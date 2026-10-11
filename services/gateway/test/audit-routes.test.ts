import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { finishAudit, startAudit } from '../src/audit/repository.ts';
import { hashPassword } from '../src/auth/password.ts';
import { sessionAuthConfig } from '../src/auth/session.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createAuditRouter } from '../src/routes/audit.ts';
import { createAuthRouter } from '../src/routes/auth.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const ORIGIN = 'http://gateway.urumi.test';
const PASSWORD = 'correct horse battery staple';
const ITEM_KEYS = ['durationMs', 'errorKind', 'finishedAt', 'id', 'outcome', 'requestId', 'requestedName', 'serverSlug', 'tool', 'ts', 'userEmail', 'userId', 'via'];

describe('GET /api/audit (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let passwordHash: string;
  let seq = 0;
  const ids = new Map<string, string>();
  const tokens = new Map<string, string>();
  const bodies: string[] = [];
  const secrets: string[] = [];

  type Reply = { status: number; headers: Headers; json: any; text: string };
  const call = async (method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, { method, headers });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, headers: response.headers, json: text && (response.headers.get('content-type') ?? '').includes('application/json') ? JSON.parse(text) : null, text };
  };
  const as = (email: string, origin: string | null = null): Record<string, string> => ({ cookie: `session=${tokens.get(email)!}`, ...(origin ? { origin } : {}) });
  const get = (email: string, query = '') => call('GET', `/api/audit${query}`, as(email));
  const addRow = async (email: string, options: { slug?: string | null; tool?: string; outcome?: string; via?: 'mcp' | 'chat' } = {}) => {
    const slug = options.slug === undefined ? 'woo' : options.slug;
    const tool = options.tool ?? 'list_orders';
    const id = await startAudit(pool, {
      userId: ids.get(email)!,
      userEmail: email,
      serverId: null,
      serverSlug: slug,
      requestedName: slug ? `${slug}__${tool}` : tool,
      tool,
      via: options.via ?? 'mcp',
      requestId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    });
    if ((options.outcome ?? 'ok') !== 'started') await finishAudit(pool, id, (options.outcome ?? 'ok') as 'ok', null, 7);
    return id;
  };
  const makeUser = async (email: string, role: 'admin' | 'member') => {
    ids.set(email, (await createUser(pool, email, role)).id);
    await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, passwordHash]);
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('session='))!;
    tokens.set(email, cookie.slice('session='.length).split(';')[0]!);
  };

  before(async () => {
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    passwordHash = await hashPassword(PASSWORD);
    const logger = createLogger(() => {});
    const sessions = sessionAuthConfig(ORIGIN);
    const { app } = createApp({
      logger,
      checkDatabase: async () => {},
      auth: createAuthRouter({ db: pool, logger, sessions }),
      audit: createAuditRouter({ db: pool, logger, sessions }),
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await makeUser('alice@example.com', 'member');
    await makeUser('bob@example.com', 'member');
    await makeUser('admin@example.com', 'admin');
    for (let i = 0; i < 3; i++) await addRow('alice@example.com', { tool: `alice${i}` });
    await addRow('alice@example.com', { slug: 'other', tool: 'ping', outcome: 'timeout' });
    for (let i = 0; i < 2; i++) await addRow('bob@example.com', { tool: `bob${i}`, via: 'chat' });
    await addRow('admin@example.com', { tool: 'admin0' });
    secrets.push(PASSWORD, passwordHash, ...tokens.values());
  });
  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await db.drop();
  });

  describe('authentication', () => {
    test('no credentials is 401', async () => {
      assert.equal((await call('GET', '/api/audit')).status, 401);
    });

    test('an API key is never accepted, with or without a valid session cookie', async () => {
      const { key } = await createApiKey(pool, 'admin@example.com', 'proof');
      secrets.push(key);
      assert.equal((await call('GET', '/api/audit', { authorization: `Bearer ${key}` })).status, 401);
      assert.equal((await call('GET', '/api/audit', { authorization: `Bearer ${key}`, ...as('admin@example.com') })).status, 401);
    });

    test('a disabled user and a wrong cookie are 401', async () => {
      assert.equal((await call('GET', '/api/audit', { cookie: 'session=not-a-session' })).status, 401);
      await pool.query("UPDATE users SET status = 'disabled' WHERE email = 'bob@example.com'");
      assert.equal((await get('bob@example.com')).status, 401);
      await pool.query("UPDATE users SET status = 'active' WHERE email = 'bob@example.com'");
      assert.equal((await get('bob@example.com')).status, 200);
    });

    test('only GET exists', async () => {
      const reply = await call('POST', '/api/audit', as('admin@example.com', ORIGIN));
      assert.equal(reply.status, 404);
    });
  });

  describe('who sees what', () => {
    test('a member sees only their own rows', async () => {
      const reply = await get('alice@example.com');
      assert.equal(reply.status, 200);
      assert.equal(reply.json.items.length, 4);
      assert.ok(reply.json.items.every((item: any) => item.userEmail === 'alice@example.com' && item.userId === ids.get('alice@example.com')));
      // The control: the rows that must be absent exist.
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE user_email <> 'alice@example.com'")).rows[0].n, 3);
      const bob = await get('bob@example.com');
      assert.deepEqual(bob.json.items.map((item: any) => item.tool), ['bob1', 'bob0']);
      assert.ok(bob.json.items.every((item: any) => item.via === 'chat'));
    });

    test('a member who sends userId is refused with 400, even with their own id, and nothing is returned', async () => {
      for (const target of ['bob@example.com', 'alice@example.com']) {
        const reply = await get('alice@example.com', `?userId=${ids.get(target)}`);
        assert.equal(reply.status, 400);
        assert.deepEqual(reply.json, { error: 'invalid request', issues: [{ field: 'userId', problem: 'admin_only' }] });
      }
    });

    test('an admin sees every row and can filter by user', async () => {
      const all = await get('admin@example.com');
      assert.equal(all.json.items.length, 7);
      assert.deepEqual([...new Set(all.json.items.map((item: any) => item.userEmail))].sort(), ['admin@example.com', 'alice@example.com', 'bob@example.com']);
      const bob = await get('admin@example.com', `?userId=${ids.get('bob@example.com')}`);
      assert.equal(bob.json.items.length, 2);
    });

    test('the filters work with the member scope: the filter narrows, it never widens', async () => {
      const other = await get('alice@example.com', '?server=other&outcome=timeout');
      assert.equal(other.json.items.length, 1);
      assert.equal((await get('bob@example.com', '?server=other')).json.items.length, 0);
    });
  });

  describe('the answer', () => {
    test('has the documented fields only, and the headers of a private JSON answer', async () => {
      const reply = await get('alice@example.com', '?limit=1');
      assert.deepEqual(Object.keys(reply.json).sort(), ['items', 'nextCursor']);
      assert.deepEqual(Object.keys(reply.json.items[0]).sort(), ITEM_KEYS);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    });

    test('every route of the app answers with nosniff, a 404 and the health route included', async () => {
      assert.equal((await call('GET', '/healthz')).headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await call('GET', '/nothing')).headers.get('x-content-type-options'), 'nosniff');
    });

    test('pages follow nextCursor to the end, newest first, with no repeat', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const reply: Reply = await get('admin@example.com', `?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        assert.equal(reply.status, 200);
        seen.push(...reply.json.items.map((item: any) => item.id));
        cursor = reply.json.nextCursor;
        pages++;
      } while (cursor);
      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 7);
      assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
    });

    test('filters by outcome (repeated), via, tool, and time', async () => {
      assert.equal((await get('admin@example.com', '?outcome=timeout&outcome=error')).json.items.length, 1);
      assert.equal((await get('admin@example.com', '?outcome=timeout,error')).status, 400);
      assert.equal((await get('admin@example.com', '?via=chat')).json.items.length, 2);
      assert.deepEqual((await get('admin@example.com', '?tool=admin0')).json.items.map((item: any) => item.tool), ['admin0']);
      const past = await get('admin@example.com', '?to=2000-01-02T00:00:00Z&from=2000-01-01T00:00:00Z');
      assert.equal(past.json.items.length, 0);
      const now = await get('admin@example.com', `?from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`);
      assert.equal(now.json.items.length, 7);
    });
  });

  describe('bad requests are 400 and name the field, never the value', () => {
    const bad = [
      '?limit=0', '?limit=201', '?limit=abc', '?limit=1&limit=2', '?limit=-1', '?limit=1.5',
      '?cursor=abc', '?cursor=0', '?cursor=1;DROP', '?cursor=99999999999999999999',
      '?server=Woo', '?server=a_b', '?server=%27%20OR%201=1', '?tool=', `?tool=${'x'.repeat(201)}`,
      '?outcome=nope', '?outcome=ok&outcome=nope', '?via=email', '?userId=not-a-uuid',
      '?from=yesterday', '?from=2030-01-01', '?to=2030-01-01T00:00:00',
      '?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z', '?from=2030-01-01T00:00:00Z&to=2030-01-01T00:00:00Z',
      '?from=2030-01-01T00:00:00Z&to=2030-06-01T00:00:00Z',
      '?foo=bar', '?user=x',
    ];
    for (const query of bad) {
      test(query.length > 60 ? `${query.slice(0, 57)}...` : query, async () => {
        const reply = await get('admin@example.com', query);
        assert.equal(reply.status, 400, reply.text);
        assert.equal(reply.json.error, 'invalid request');
        assert.ok(Array.isArray(reply.json.issues));
        assert.ok(!reply.text.includes('DROP'), 'the value is not echoed');
      });
    }

    test('a range of exactly 90 days is accepted', async () => {
      assert.equal((await get('admin@example.com', '?from=2030-01-01T00:00:00Z&to=2030-04-01T00:00:00Z')).status, 200);
    });

    test('a bad request writes nothing and changes nothing', async () => {
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 7);
    });
  });

  test('leak scan: no password, hash, session token or API key in any answer of this file, with a planted control', async () => {
    const needles = secrets.filter((value) => value.length >= 8);
    assert.ok(needles.length >= 6, `only ${needles.length} needles loaded`);
    const scan = (text: string) => needles.filter((needle) => text.includes(needle));
    assert.ok(scan(`before ${needles[0]} after`).length >= 1, 'the planted control must be found');
    assert.ok(bodies.length >= 30, `only ${bodies.length} answers collected`);
    assert.deepEqual(scan(bodies.join('\n')), []);
  });
});
