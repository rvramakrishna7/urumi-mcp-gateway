import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
import { hashInviteToken } from '../src/identity/invites.ts';
import { hashApiKey } from '../src/identity/keys.ts';
import { createApiKey, createUser, setUserStatus } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
import { createAuthRouter } from '../src/routes/auth.ts';
import { createMeKeysRouter } from '../src/routes/me-keys.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const ORIGIN = 'http://gateway.urumi.test';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another long passphrase 42';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('the users and keys routes of the admin API (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let keyDir: string;
  let closeMcp: () => Promise<void>;
  let passwordHash: string;
  const logLines: string[] = [];
  const tokens = new Map<string, string>();
  const plainKeys: string[] = [];
  const inviteTokens: string[] = [];
  // Every response that is not an invite response, for the leak scan at the end.
  const responses: string[] = [];

  type Reply = { status: number; headers: Headers; json: any; text: string };

  const call = async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!/\/invite$/.test(path) && !(method === 'POST' && path === '/api/admin/users')) responses.push(text);
    return { status: response.status, headers: response.headers, json: text && (response.headers.get('content-type') ?? '').includes('application/json') ? JSON.parse(text) : null, text };
  };
  const asSession = (email: string, origin: string | null = ORIGIN): Record<string, string> => ({
    cookie: `session=${tokens.get(email)!}`,
    ...(origin === null ? {} : { origin }),
  });
  const asKey = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });
  const mcpStatus = async (key: string) =>
    (
      await call('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
      })
    ).status;
  const idOf = async (email: string) => (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string;
  const signIn = async (email: string, password = PASSWORD) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    if (response.status !== 200) return response.status;
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('session='))!;
    tokens.set(email, cookie.slice('session='.length).split(';')[0]!);
    return 200;
  };
  const makeUser = async (email: string, role: 'admin' | 'member') => {
    await createUser(pool, email, role);
    await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, passwordHash]);
    assert.equal(await signIn(email), 200);
  };
  const makeKey = async (email: string, name = 'k') => {
    const { key, view } = await createApiKey(pool, email, name);
    plainKeys.push(key);
    return { key, id: view.id };
  };
  const acceptInvite = (token: string, password: string) =>
    call('POST', '/api/auth/accept-invite', { body: { token, password }, headers: { origin: ORIGIN } });

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-adminusers-'));
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
      admin: { db: pool, keyring, logger, sessions },
      mcp: mcp.router,
      auth: createAuthRouter({ db: pool, logger, sessions }),
      me: createMeKeysRouter({ db: pool, logger, sessions }),
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await makeUser('admin@example.com', 'admin');
    await makeUser('a@example.com', 'member');
    await makeUser('b@example.com', 'member');
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

  describe('who may call', () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', { email: 'x@example.com' }],
      ['POST', `/api/admin/users/${MISSING_ID}/invite`],
      ['PATCH', `/api/admin/users/${MISSING_ID}`, { status: 'disabled' }],
      ['GET', `/api/admin/users/${MISSING_ID}/keys`],
      ['DELETE', `/api/admin/users/${MISSING_ID}/keys/${MISSING_ID}`],
    ];

    test('no credential: 401 on every route (the Origin is sent, so the answer is not the CSRF 403)', async () => {
      for (const [method, path, body] of routes) assert.equal((await call(method, path, { body, headers: { origin: ORIGIN } })).status, 401, `${method} ${path}`);
    });

    test('a member, by session or by key: 403 on every route', async () => {
      const key = (await makeKey('a@example.com')).key;
      for (const [method, path, body] of routes) {
        assert.equal((await call(method, path, { body, headers: asSession('a@example.com') })).status, 403, `session ${method} ${path}`);
        assert.equal((await call(method, path, { body, headers: asKey(key) })).status, 403, `key ${method} ${path}`);
      }
    });

    test('an admin by session without an Origin on a change: 403 and nothing is written', async () => {
      const before = (await pool.query('SELECT count(*)::int AS c FROM users')).rows[0].c;
      const reply = await call('POST', '/api/admin/users', { body: { email: 'csrf@example.com' }, headers: asSession('admin@example.com', null) });
      assert.equal(reply.status, 403);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM users')).rows[0].c, before);
    });

    test('an admin by session and by key can list, and the list holds no secret column', async () => {
      const key = (await makeKey('admin@example.com')).key;
      for (const headers of [asSession('admin@example.com'), asKey(key)]) {
        const reply = await call('GET', '/api/admin/users', { headers });
        assert.equal(reply.status, 200);
        assert.equal(reply.headers.get('cache-control'), 'no-store');
        assert.deepEqual(Object.keys(reply.json.users[0]).sort(), ['createdAt', 'disabledAt', 'email', 'id', 'lastLoginAt', 'role', 'status']);
      }
    });
  });

  describe('create a member and the invite', () => {
    test('a request that names a role is 400 and no user is made', async () => {
      const reply = await call('POST', '/api/admin/users', { body: { email: 'boss@example.com', role: 'admin' }, headers: asSession('admin@example.com') });
      assert.equal(reply.status, 400);
      assert.equal((await pool.query('SELECT 1 FROM users WHERE email = $1', ['boss@example.com'])).rowCount, 0);
    });

    test('a bad email is 400, a repeated email is 409', async () => {
      assert.equal((await call('POST', '/api/admin/users', { body: { email: 'not-an-email' }, headers: asSession('admin@example.com') })).status, 400);
      assert.equal((await call('POST', '/api/admin/users', { body: { email: 'A@Example.com' }, headers: asSession('admin@example.com') })).status, 409);
    });

    test('a new member is invited, the token is stored only as a hash, and it works once', async () => {
      const reply = await call('POST', '/api/admin/users', { body: { email: ' New@Example.com ' }, headers: asSession('admin@example.com') });
      assert.equal(reply.status, 201);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.equal(reply.json.user.email, 'new@example.com');
      assert.equal(reply.json.user.role, 'member');
      assert.equal(reply.json.user.status, 'invited');
      const token = reply.json.invite.token as string;
      inviteTokens.push(token);
      assert.equal(reply.json.invite.link, `${ORIGIN}/accept-invite#token=${token}`);
      assert.ok(new Date(reply.json.invite.expiresAt).getTime() > Date.now() + 71 * 3600 * 1000);

      const row = (await pool.query('SELECT invite_token_hash, created_by FROM users WHERE email = $1', ['new@example.com'])).rows[0];
      assert.deepEqual(row.invite_token_hash, hashInviteToken(token));
      assert.equal(row.created_by, await idOf('admin@example.com'));
      assert.equal(JSON.stringify((await pool.query('SELECT * FROM users')).rows).includes(token), false);

      assert.equal((await acceptInvite(token, NEW_PASSWORD)).status, 200);
      assert.equal((await acceptInvite(token, NEW_PASSWORD)).status, 400);
      assert.equal(await signIn('new@example.com', NEW_PASSWORD), 200);
    });
  });

  describe('invite of an existing user (the password reset)', () => {
    test('an admin cannot be invited by an admin: 409 and no token is written', async () => {
      await makeUser('admin2@example.com', 'admin');
      const id = await idOf('admin2@example.com');
      const reply = await call('POST', `/api/admin/users/${id}/invite`, { headers: asSession('admin@example.com') });
      assert.equal(reply.status, 409);
      assert.equal(reply.text.includes('inv_'), false);
      assert.equal((await pool.query('SELECT invite_token_hash FROM users WHERE id = $1', [id])).rows[0].invite_token_hash, null);
      // Not even an admin who invites himself.
      assert.equal((await call('POST', `/api/admin/users/${await idOf('admin@example.com')}/invite`, { headers: asSession('admin@example.com') })).status, 409);
    });

    test('a member gets a new invite; accepting it sets a new password and ends the sessions', async () => {
      const id = await idOf('b@example.com');
      const reply = await call('POST', `/api/admin/users/${id}/invite`, { headers: asSession('admin@example.com') });
      assert.equal(reply.status, 201);
      const token = reply.json.invite.token as string;
      inviteTokens.push(token);
      assert.equal((await call('GET', '/api/auth/me', { headers: asSession('b@example.com') })).status, 200);
      assert.equal((await acceptInvite(token, NEW_PASSWORD)).status, 200);
      assert.equal((await call('GET', '/api/auth/me', { headers: asSession('b@example.com') })).status, 401);
      assert.equal(await signIn('b@example.com', PASSWORD), 401);
      assert.equal(await signIn('b@example.com', NEW_PASSWORD), 200);
    });

    test('a disabled user is 409, an unknown user and a bad id are 404', async () => {
      await createUser(pool, 'gone@example.com', 'member');
      const id = await idOf('gone@example.com');
      await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [id]);
      assert.equal((await call('POST', `/api/admin/users/${id}/invite`, { headers: asSession('admin@example.com') })).status, 409);
      assert.equal((await call('POST', `/api/admin/users/${MISSING_ID}/invite`, { headers: asSession('admin@example.com') })).status, 404);
      assert.equal((await call('POST', '/api/admin/users/not-a-uuid/invite', { headers: asSession('admin@example.com') })).status, 404);
    });
  });

  describe('disable and enable', () => {
    test('disabling stops the session, the key and the invite, and does not revoke the key; enabling brings them back', async () => {
      const id = await idOf('a@example.com');
      const { key, id: keyId } = await makeKey('a@example.com', 'before-disable');
      assert.notEqual(await mcpStatus(key), 401);
      assert.equal((await call('GET', '/api/auth/me', { headers: asSession('a@example.com') })).status, 200);

      const reply = await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'disabled' }, headers: asSession('admin@example.com') });
      assert.equal(reply.status, 200);
      assert.equal(reply.json.user.status, 'disabled');
      assert.ok(reply.json.user.disabledAt);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM sessions WHERE user_id = $1', [id])).rows[0].c, 0);
      assert.equal((await call('GET', '/api/auth/me', { headers: asSession('a@example.com') })).status, 401);
      assert.equal(await mcpStatus(key), 401);
      assert.equal((await pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [keyId])).rows[0].revoked_at, null);
      assert.equal(await signIn('a@example.com'), 401);
      // Disabling again changes nothing.
      assert.equal((await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'disabled' }, headers: asSession('admin@example.com') })).status, 200);

      const enabled = await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'active' }, headers: asSession('admin@example.com') });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.json.user.status, 'active');
      assert.equal(enabled.json.user.disabledAt, null);
      assert.notEqual(await mcpStatus(key), 401);
      assert.equal(await signIn('a@example.com'), 200);
    });

    test('a disabled user with a pending invite loses it, and enabling gives "invited" when no password exists', async () => {
      const made = await call('POST', '/api/admin/users', { body: { email: 'never@example.com' }, headers: asSession('admin@example.com') });
      const token = made.json.invite.token as string;
      inviteTokens.push(token);
      const id = made.json.user.id as string;
      assert.equal((await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'disabled' }, headers: asSession('admin@example.com') })).status, 200);
      assert.equal((await pool.query('SELECT invite_token_hash FROM users WHERE id = $1', [id])).rows[0].invite_token_hash, null);
      assert.equal((await acceptInvite(token, NEW_PASSWORD)).status, 400);
      const enabled = await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'active' }, headers: asSession('admin@example.com') });
      assert.equal(enabled.json.user.status, 'invited');
      assert.equal(await signIn('never@example.com', NEW_PASSWORD), 401);
      assert.equal((await acceptInvite(token, NEW_PASSWORD)).status, 400, 'the old token does not come back');
    });

    test('a bad body is 400, an unknown user is 404, a bad id is 404', async () => {
      const headers = asSession('admin@example.com');
      const id = await idOf('a@example.com');
      assert.equal((await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'invited' }, headers })).status, 400);
      assert.equal((await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'active', role: 'admin' }, headers })).status, 400);
      assert.equal((await call('PATCH', `/api/admin/users/${MISSING_ID}`, { body: { status: 'disabled' }, headers })).status, 404);
      assert.equal((await call('PATCH', '/api/admin/users/x', { body: { status: 'disabled' }, headers })).status, 404);
    });

    test('an admin cannot disable himself, by session or by key', async () => {
      const id = await idOf('admin@example.com');
      const key = (await makeKey('admin@example.com')).key;
      assert.equal((await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'disabled' }, headers: asSession('admin@example.com') })).status, 409);
      assert.equal((await call('PATCH', `/api/admin/users/${id}`, { body: { status: 'disabled' }, headers: asKey(key) })).status, 409);
      assert.equal((await pool.query('SELECT status FROM users WHERE id = $1', [id])).rows[0].status, 'active');
    });
  });

  describe('the keys of another user', () => {
    test('the list holds the keys of that user only, and the path decides', async () => {
      const a = await makeKey('a@example.com', 'a-key');
      const b = await makeKey('b@example.com', 'b-key');
      const reply = await call('GET', `/api/admin/users/${await idOf('a@example.com')}/keys`, { headers: asSession('admin@example.com') });
      assert.equal(reply.status, 200);
      assert.ok(reply.json.keys.some((k: { id: string }) => k.id === a.id));
      assert.equal(reply.text.includes(b.id), false);
      assert.equal(reply.text.includes(b.key.slice(0, 12)), false);
      assert.equal((await call('GET', `/api/admin/users/${MISSING_ID}/keys`, { headers: asSession('admin@example.com') })).status, 404);
    });

    test('a key under the wrong user is 404 and stays active; under the right user it is revoked (TEST-012 shape)', async () => {
      const a = await makeKey('a@example.com', 'to-revoke');
      const aId = await idOf('a@example.com');
      const bId = await idOf('b@example.com');
      const headers = asSession('admin@example.com');
      assert.equal((await call('DELETE', `/api/admin/users/${bId}/keys/${a.id}`, { headers })).status, 404);
      assert.equal((await call('DELETE', `/api/admin/users/${MISSING_ID}/keys/${a.id}`, { headers })).status, 404);
      assert.equal((await pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [a.id])).rows[0].revoked_at, null);
      assert.notEqual(await mcpStatus(a.key), 401);

      assert.equal((await call('DELETE', `/api/admin/users/${aId}/keys/${a.id}`, { headers })).status, 204);
      assert.equal(await mcpStatus(a.key), 401);
      assert.notEqual((await pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [a.id])).rows[0].revoked_at, null);
      assert.equal((await call('DELETE', `/api/admin/users/${aId}/keys/not-a-uuid`, { headers })).status, 404);
    });
  });

  describe('two admins disable each other at the same time', () => {
    test('exactly one wins, and one active admin is left (5 rounds)', async () => {
      for (let round = 0; round < 5; round++) {
        const x = `race-x-${round}@example.com`;
        const y = `race-y-${round}@example.com`;
        await makeUser(x, 'admin');
        await makeUser(y, 'admin');
        // The other admins of the file are put aside, so that the pair is the whole set of active admins.
        await pool.query("UPDATE users SET status = 'disabled' WHERE role = 'admin' AND status = 'active' AND email NOT IN ($1, $2)", [x, y]);
        const [rx, ry] = await Promise.all([
          call('PATCH', `/api/admin/users/${await idOf(y)}`, { body: { status: 'disabled' }, headers: asSession(x) }),
          call('PATCH', `/api/admin/users/${await idOf(x)}`, { body: { status: 'disabled' }, headers: asSession(y) }),
        ]);
        const statuses = [rx.status, ry.status].sort();
        assert.equal(statuses[0], 200, `round ${round}: ${statuses}`);
        assert.ok(statuses[1] === 409 || statuses[1] === 401, `round ${round}: ${statuses}`);
        const left = (await pool.query("SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND status = 'active'")).rows[0].c;
        assert.equal(left, 1, `round ${round}`);
        // Put an admin back for the next round and for the tests after this one.
        await pool.query("UPDATE users SET status = 'active' WHERE email = 'admin@example.com'");
        await signIn('admin@example.com');
      }
    });

    test('the last active admin is refused by the repository itself', async () => {
      await pool.query("UPDATE users SET status = 'disabled' WHERE role = 'admin' AND email <> 'admin@example.com'");
      const only = await idOf('admin@example.com');
      assert.deepEqual(await setUserStatus(pool, only, 'disabled'), { ok: false, reason: 'last_admin' });
      assert.equal((await pool.query('SELECT status FROM users WHERE id = $1', [only])).rows[0].status, 'active');
      assert.deepEqual(await setUserStatus(pool, MISSING_ID, 'disabled'), { ok: false, reason: 'not_found' });
    });
  });

  describe('nothing secret is in a response or a log', () => {
    // A needle that is found in a text. Matches only whole values: the tokens and keys are long and random.
    const found = (needles: string[], texts: string[]) => needles.filter((needle) => texts.some((text) => text.includes(needle)));

    test('the scan loads enough needles, finds a planted control, and finds nothing real', async () => {
      const hashes = [
        passwordHash,
        ...plainKeys.map((key) => hashApiKey(key).toString('hex')),
        ...inviteTokens.map((token) => hashInviteToken(token).toString('hex')),
        ...(await pool.query('SELECT password_hash FROM users WHERE password_hash IS NOT NULL')).rows.map((r) => r.password_hash as string),
      ];
      const needles = [...new Set([PASSWORD, NEW_PASSWORD, ...plainKeys, ...inviteTokens, ...[...tokens.values()], ...hashes])];
      assert.ok(needles.length >= 20, `only ${needles.length} needles loaded`);
      assert.ok(responses.length >= 40, `only ${responses.length} responses recorded`);
      assert.ok(logLines.length >= 10, `only ${logLines.length} log lines recorded`);
      assert.ok(inviteTokens.length >= 3 && plainKeys.length >= 5);

      const control = `planted: ${plainKeys[0]!}`;
      assert.deepEqual(found(needles, [control]), [plainKeys[0]!], 'the control must be found');
      assert.equal(createHash('sha256').update('x').digest('hex').length, 64);

      assert.deepEqual(found(needles, responses), [], 'a response holds a secret');
      assert.deepEqual(found(needles, logLines), [], 'a log line holds a secret');
    });
  });
});
