import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_UPSTREAM } from './helpers/upstream-policy.ts';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { sessionAuthConfig } from '../src/auth/session.ts';
import { createGateway } from '../src/core/gateway.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { hashApiKey } from '../src/identity/keys.ts';
import { createApiKey, createKeyForUser, createUser, MAX_ACTIVE_KEYS_PER_USER } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
import { createAuthRouter } from '../src/routes/auth.ts';
import { createMeKeysRouter } from '../src/routes/me-keys.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const ORIGIN = 'http://gateway.urumi.test';
const PASSWORD = 'correct horse battery staple';
const KEY_SHAPE = /^mcpgw_[A-Za-z0-9_-]{43}$/;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('GET, POST and DELETE /api/me/keys (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let keyDir: string;
  let closeMcp: () => Promise<void>;
  let passwordHash: string;
  const logLines: string[] = [];
  const tokens = new Map<string, string>();
  const everyPlainKey: string[] = [];

  type Reply = { status: number; headers: Headers; json: any; text: string };

  const call = async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text && (response.headers.get('content-type') ?? '').includes('application/json') ? JSON.parse(text) : null, text };
  };
  const cookieOf = (email: string) => ({ cookie: `session=${tokens.get(email)!}` });
  const asUser = (email: string, origin: string | null = ORIGIN): Record<string, string> => ({
    ...cookieOf(email),
    ...(origin === null ? {} : { origin }),
  });
  const list = (email: string) => call('GET', '/api/me/keys', { headers: asUser(email) });
  const create = async (email: string, name: string) => {
    const reply = await call('POST', '/api/me/keys', { body: { name }, headers: asUser(email) });
    if (reply.status === 201) everyPlainKey.push(reply.json.key);
    return reply;
  };
  const mcpStatus = async (key: string) =>
    (
      await call('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
      })
    ).status;
  const row = async (id: string) => (await pool.query('SELECT user_id, revoked_at FROM api_keys WHERE id = $1', [id])).rows[0];
  const userId = async (email: string) => (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string;
  const signIn = async (email: string) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('session='))!;
    tokens.set(email, cookie.slice('session='.length).split(';')[0]!);
  };
  const makeUser = async (email: string, role: 'admin' | 'member') => {
    await createUser(pool, email, role);
    await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, passwordHash]);
    await signIn(email);
  };

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-mekeys-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    const keyring = loadKeyring(join(keyDir, 'key'), 'k1');
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    passwordHash = await hashPassword(PASSWORD);

    const logger = createLogger((line) => logLines.push(line));
    const sessions = sessionAuthConfig(ORIGIN);
    const gateway = createGateway({ db: pool, keyring, logger });
    const mcp = createMcpRouter({ db: pool, gateway, logger, allowedHosts: ['127.0.0.1'] });
    closeMcp = mcp.close;
    const { app } = createApp({
      logger,
      checkDatabase: async () => {},
      admin: { db: pool, keyring, logger, upstream: TEST_UPSTREAM, sessions },
      mcp: mcp.router,
      auth: createAuthRouter({ db: pool, logger, sessions }),
      me: createMeKeysRouter({ db: pool, logger, sessions }),
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await makeUser('a@example.com', 'member');
    await makeUser('b@example.com', 'member');
    await makeUser('admin@example.com', 'admin');
  });

  after(async () => {
    await closeMcp();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  describe('one member cannot reach the keys of another', () => {
    let aKeys: { id: string; key: string }[];
    let bKeys: { id: string; key: string }[];

    before(async () => {
      const make = async (email: string, names: string[]) => {
        const out: { id: string; key: string }[] = [];
        for (const name of names) {
          const reply = await create(email, name);
          assert.equal(reply.status, 201);
          out.push({ id: reply.json.meta.id, key: reply.json.key });
        }
        return out;
      };
      aKeys = await make('a@example.com', ['a-one', 'a-two']);
      bKeys = await make('b@example.com', ['b-one', 'b-two']);
    });

    test('the list of A holds the keys of A and nothing of B', async () => {
      const reply = await list('a@example.com');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json.keys.map((k: { id: string }) => k.id).sort(), aKeys.map((k) => k.id).sort());
      for (const k of bKeys) {
        assert.equal(reply.text.includes(k.id), false);
        assert.equal(reply.text.includes(k.key.slice(0, 10)), false);
      }
      assert.equal(reply.text.includes('b-one'), false);
    });

    test('A deleting a key of B gets 404, the row of B is unchanged and the key of B still works on /mcp', async () => {
      const before = await row(bKeys[0]!.id);
      assert.equal(before.revoked_at, null);
      const reply = await call('DELETE', `/api/me/keys/${bKeys[0]!.id}`, { headers: asUser('a@example.com') });
      assert.equal(reply.status, 404);
      assert.deepEqual(await row(bKeys[0]!.id), before);
      assert.notEqual(await mcpStatus(bKeys[0]!.key), 401);
      assert.equal((await list('b@example.com')).json.keys.every((k: { revokedAt: unknown }) => k.revokedAt === null), true);
    });

    test('the answer for the key of B is the same as for an id that does not exist', async () => {
      const other = await call('DELETE', `/api/me/keys/${bKeys[1]!.id}`, { headers: asUser('a@example.com') });
      const missing = await call('DELETE', `/api/me/keys/${MISSING_ID}`, { headers: asUser('a@example.com') });
      assert.equal(other.status, 404);
      assert.equal(missing.status, 404);
      assert.equal(other.text, missing.text);
      assert.equal((await call('DELETE', '/api/me/keys/not-a-uuid', { headers: asUser('a@example.com') })).status, 404);
    });

    test('there is no route by id, and a user id in the query or the body is ignored', async () => {
      assert.equal((await call('GET', `/api/me/keys/${bKeys[0]!.id}`, { headers: asUser('a@example.com') })).status, 404);
      const bId = await userId('b@example.com');
      const withQuery = await call('GET', `/api/me/keys?userId=${bId}`, { headers: asUser('a@example.com') });
      assert.deepEqual(withQuery.json.keys.map((k: { id: string }) => k.id).sort(), aKeys.map((k) => k.id).sort());
      const forged = await call('POST', '/api/me/keys', { body: { name: 'forged', userId: bId }, headers: asUser('a@example.com') });
      assert.equal(forged.status, 201);
      assert.equal((await row(forged.json.meta.id)).user_id, await userId('a@example.com'));
      assert.equal((await call('PATCH', `/api/me/keys/${aKeys[0]!.id}`, { body: {}, headers: asUser('a@example.com') })).status, 404);
    });

    test('an admin sees and revokes only their own keys through these routes', async () => {
      assert.equal((await create('admin@example.com', 'admin-own')).status, 201);
      const keys = (await list('admin@example.com')).json.keys;
      assert.deepEqual(keys.map((k: { name: string }) => k.name), ['admin-own']);
      assert.equal((await call('DELETE', `/api/me/keys/${aKeys[0]!.id}`, { headers: asUser('admin@example.com') })).status, 404);
      assert.equal((await row(aKeys[0]!.id)).revoked_at, null);
    });
  });

  describe('create', () => {
    test('201 with the plain key once; only the hash is stored; later lists never hold the key or the hash', async () => {
      const reply = await create('a@example.com', '  spaced name  ');
      assert.equal(reply.status, 201);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.match(reply.json.key, KEY_SHAPE);
      assert.equal(reply.json.meta.name, 'spaced name');
      assert.equal(reply.json.meta.status, 'active');
      assert.equal(reply.json.meta.keyPrefix, reply.json.key.slice(0, 10));
      assert.deepEqual(Object.keys(reply.json.meta).sort(), ['createdAt', 'id', 'keyPrefix', 'lastUsedAt', 'name', 'revokedAt', 'status']);
      const stored = await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [reply.json.meta.id]);
      assert.deepEqual(stored.rows[0].key_hash, hashApiKey(reply.json.key));
      const listing = await list('a@example.com');
      assert.equal(listing.text.includes(reply.json.key), false);
      assert.equal(listing.text.includes('key_hash'), false);
      assert.equal(listing.text.includes('keyHash'), false);
      assert.notEqual(await mcpStatus(reply.json.key), 401);
    });

    test('a bad name is 400', async () => {
      for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 5 }, { name: null }, []]) {
        const reply = await call('POST', '/api/me/keys', { body, headers: asUser('b@example.com') });
        assert.equal(reply.status, 400, JSON.stringify(body));
      }
      assert.equal((await create('b@example.com', 'x'.repeat(100))).status, 201);
    });
  });

  describe('revoke', () => {
    test('204, the key stops working at once, the row stays, and a second revoke keeps the first time', async () => {
      const created = await create('b@example.com', 'to-revoke');
      const { id } = created.json.meta;
      assert.notEqual(await mcpStatus(created.json.key), 401);
      assert.equal((await call('DELETE', `/api/me/keys/${id}`, { headers: asUser('b@example.com') })).status, 204);
      assert.equal(await mcpStatus(created.json.key), 401);
      const time = (await row(id)).revoked_at as Date;
      assert.ok(time instanceof Date);
      assert.equal((await call('DELETE', `/api/me/keys/${id}`, { headers: asUser('b@example.com') })).status, 204);
      assert.equal(((await row(id)).revoked_at as Date).getTime(), time.getTime());
      const entry = (await list('b@example.com')).json.keys.find((k: { id: string }) => k.id === id);
      assert.equal(entry.status, 'revoked');
      assert.ok(entry.revokedAt);
    });
  });

  describe('the cap of active keys', () => {
    test('the 11th active key is 409, a revoked key does not count, and a revoke makes room', async () => {
      await makeUser('cap@example.com', 'member');
      const ids: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_KEYS_PER_USER; i += 1) {
        const reply = await create('cap@example.com', `k${i}`);
        assert.equal(reply.status, 201);
        ids.push(reply.json.meta.id);
      }
      const over = await create('cap@example.com', 'eleven');
      assert.equal(over.status, 409);
      assert.deepEqual(over.json, { error: 'key limit reached' });
      assert.equal((await list('cap@example.com')).json.keys.length, 10);
      assert.equal((await call('DELETE', `/api/me/keys/${ids[0]}`, { headers: asUser('cap@example.com') })).status, 204);
      assert.equal((await create('cap@example.com', 'after-revoke')).status, 201);
      assert.equal((await create('cap@example.com', 'again')).status, 409);
      const all = (await list('cap@example.com')).json.keys;
      assert.equal(all.length, 11);
      assert.equal(all.filter((k: { status: string }) => k.status === 'active').length, 10);
    });

    test('20 parallel creates by one user leave exactly 10 active keys', async () => {
      await createUser(pool, 'race@example.com', 'member');
      const id = await userId('race@example.com');
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => createKeyForUser(pool, id, `r${i}`)));
      assert.equal(results.filter((r) => r.ok).length, MAX_ACTIVE_KEYS_PER_USER);
      assert.equal(results.filter((r) => !r.ok && r.reason === 'limit').length, 10);
      const active = await pool.query('SELECT count(*)::int AS c FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      assert.equal(active.rows[0].c, MAX_ACTIVE_KEYS_PER_USER);
      for (const r of results) if (r.ok) everyPlainKey.push(r.key);
    });
  });

  describe('authentication of the routes', () => {
    test('no cookie is 401 for every method', async () => {
      assert.equal((await call('GET', '/api/me/keys', { headers: { origin: ORIGIN } })).status, 401);
      assert.equal((await call('POST', '/api/me/keys', { body: { name: 'x' }, headers: { origin: ORIGIN } })).status, 401);
      assert.equal((await call('DELETE', `/api/me/keys/${MISSING_ID}`, { headers: { origin: ORIGIN } })).status, 401);
    });

    test('an API key is never accepted, alone or together with a good cookie', async () => {
      const key = (await createApiKey(pool, 'a@example.com', 'script key')).key;
      everyPlainKey.push(key);
      assert.equal((await call('GET', '/api/me/keys', { headers: { authorization: `Bearer ${key}` } })).status, 401);
      assert.equal((await call('POST', '/api/me/keys', { body: { name: 'x' }, headers: { authorization: `Bearer ${key}`, origin: ORIGIN } })).status, 401);
      assert.equal((await call('GET', '/api/me/keys', { headers: { ...cookieOf('a@example.com'), authorization: `Bearer ${key}` } })).status, 401);
    });

    test('POST and DELETE need the exact origin: missing or wrong is 403 and changes nothing; GET needs none', async () => {
      const count = async () => (await pool.query('SELECT count(*)::int AS c FROM api_keys')).rows[0].c as number;
      const total = await count();
      for (const origin of [null, 'http://evil.example', `${ORIGIN}.evil.example`, 'null']) {
        assert.equal((await call('POST', '/api/me/keys', { body: { name: 'csrf' }, headers: asUser('a@example.com', origin) })).status, 403);
      }
      const victim = (await list('a@example.com')).json.keys[0].id;
      assert.equal((await call('DELETE', `/api/me/keys/${victim}`, { headers: asUser('a@example.com', 'http://evil.example') })).status, 403);
      assert.equal((await call('DELETE', `/api/me/keys/${victim}`, { headers: asUser('a@example.com', null) })).status, 403);
      assert.equal((await row(victim)).revoked_at, null);
      assert.equal(await count(), total);
      assert.equal((await call('GET', '/api/me/keys', { headers: asUser('a@example.com', null) })).status, 200);
    });

    test('an expired session and a disabled user are 401', async () => {
      await makeUser('gone@example.com', 'member');
      assert.equal((await list('gone@example.com')).status, 200);
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE user_id = $1", [await userId('gone@example.com')]);
      assert.equal((await list('gone@example.com')).status, 401);
      await signIn('gone@example.com');
      assert.equal((await list('gone@example.com')).status, 200);
      await pool.query("UPDATE users SET status = 'disabled' WHERE email = 'gone@example.com'");
      assert.equal((await list('gone@example.com')).status, 401);
    });
  });

  // The scan asserts how many needles it loaded and has a planted control, so a scan that loaded nothing cannot pass.
  // It runs last in this file (node:test runs the tests of a describe in order).
  test('no plain key, session token or password is in the log, and the scan finds a planted control', () => {
    const needles = [...everyPlainKey, ...tokens.values(), PASSWORD];
    assert.ok(everyPlainKey.length >= 30, `loaded ${everyPlainKey.length} keys`);
    assert.ok(tokens.size >= 5, `loaded ${tokens.size} tokens`);
    assert.ok(needles.length >= 36, `loaded ${needles.length} needles`);
    const log = logLines.join('\n');
    assert.ok(logLines.some((line) => line.includes('"message":"api key created"')));
    assert.ok(logLines.some((line) => line.includes('"message":"api key revoked"')));
    assert.equal(needles.filter((needle) => log.includes(needle)).length, 0);
    const control = `${log}\n${everyPlainKey[0]}`;
    assert.ok(needles.filter((needle) => control.includes(needle)).length >= 1, 'control: a planted key must be found');
    assert.equal(logLines.filter((line) => /"message":"api key/.test(line)).join(' ').includes('@'), false);
  });
});
