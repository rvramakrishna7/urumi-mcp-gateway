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
import { hashSessionToken, sessionAuthConfig, sessionClearCookie, sessionSetCookie, sessionTokenFromCookieHeader } from '../src/auth/session.ts';
import { MAX_FAILURES, emailThrottleKey, lockedSeconds, recordFailure } from '../src/auth/throttle.ts';
import { createGateway } from '../src/core/gateway.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { generateInviteToken, issueInvite } from '../src/identity/invites.ts';
import { createLogger } from '../src/logger.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
import { createAuthRouter } from '../src/routes/auth.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const ORIGIN = 'http://gateway.urumi.test';
const PASSWORD = 'correct horse battery staple';

describe('session cookie and token helpers', () => {
  const plain = sessionAuthConfig('http://gateway.urumi.test').cookie;
  const secure = sessionAuthConfig('https://gateway.example.com').cookie;
  const token = randomBytes(32).toString('base64url');

  test('on plain http the cookie is HttpOnly and SameSite=Strict, with no Secure, no Domain and no prefix', () => {
    assert.deepEqual(plain, { name: 'session', secure: false });
    assert.equal(sessionSetCookie(plain, token), `session=${token}; Max-Age=43200; Path=/; HttpOnly; SameSite=Strict`);
    assert.equal(sessionClearCookie(plain), 'session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
  });

  test('on https the cookie is Secure and has the __Host- prefix, and still has no Domain', () => {
    assert.deepEqual(secure, { name: '__Host-session', secure: true });
    assert.equal(sessionSetCookie(secure, token), `__Host-session=${token}; Max-Age=43200; Path=/; HttpOnly; SameSite=Strict; Secure`);
    assert.equal(sessionSetCookie(secure, token).includes('Domain'), false);
  });

  test('the token is read only from the cookie of our name and only when it has the exact shape', () => {
    assert.equal(sessionTokenFromCookieHeader(`a=b; session=${token}; c=d`, plain), token);
    assert.equal(sessionTokenFromCookieHeader(`session=${token}`, secure), null);
    assert.equal(sessionTokenFromCookieHeader(`xsession=${token}`, plain), null);
    assert.equal(sessionTokenFromCookieHeader(`session=${token}x`, plain), null);
    assert.equal(sessionTokenFromCookieHeader('session=short', plain), null);
    assert.equal(sessionTokenFromCookieHeader(`session=${'a'.repeat(5000)}`, plain), null);
    assert.equal(sessionTokenFromCookieHeader(undefined, plain), null);
    assert.equal(sessionTokenFromCookieHeader('', plain), null);
  });
});

describe('login, sessions and the admin API with a session (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let keyDir: string;
  let adminKey: string;
  let closeMcp: () => Promise<void>;
  const logLines: string[] = [];

  type Reply = { status: number; headers: Headers; json: any; token: string | null };

  const call = async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('session='));
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null, token: cookie ? cookie.slice('session='.length).split(';')[0]! : null };
  };
  const login = (email: string, password: string, origin: string | null = ORIGIN) =>
    call('POST', '/api/auth/login', { body: { email, password }, headers: origin === null ? {} : { origin } });
  const withSession = (token: string, origin?: string): Record<string, string> => ({ cookie: `session=${token}`, ...(origin === undefined ? {} : { origin }) });
  const sessionCount = async (email: string) =>
    (await pool.query('SELECT count(*)::int AS c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1', [email])).rows[0].c as number;
  const makeUser = async (email: string, role: 'admin' | 'member', passwordHash: string | null) => {
    await createUser(pool, email, role);
    if (passwordHash) await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, passwordHash]);
  };
  let sharedHash: string;

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-auth-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    const keyring = loadKeyring(join(keyDir, 'key'), 'k1');
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    sharedHash = await hashPassword(PASSWORD);
    await makeUser('admin@example.com', 'admin', sharedHash);
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;

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
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  describe('POST /api/auth/login', () => {
    test('a correct password gives 200, the user, and a cookie with the exact flags; only the hash of the token is stored', async () => {
      await makeUser('login-ok@example.com', 'member', sharedHash);
      const reply = await login('Login-OK@Example.com ', PASSWORD);
      assert.equal(reply.status, 200);
      assert.deepEqual(Object.keys(reply.json), ['user']);
      assert.deepEqual(Object.keys(reply.json.user).sort(), ['email', 'id', 'role']);
      assert.equal(reply.json.user.email, 'login-ok@example.com');
      assert.equal(reply.json.user.role, 'member');
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      const cookie = reply.headers.getSetCookie();
      assert.equal(cookie.length, 1);
      assert.match(cookie[0]!, /^session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
      const stored = await pool.query('SELECT count(*)::int AS c FROM sessions WHERE token_hash = $1', [hashSessionToken(reply.token!)]);
      assert.equal(stored.rows[0].c, 1);
      const raw = await pool.query('SELECT count(*)::int AS c FROM sessions WHERE token_hash = $1', [Buffer.from(reply.token!)]);
      assert.equal(raw.rows[0].c, 0);
      assert.notEqual((await pool.query('SELECT last_login_at FROM users WHERE email = $1', ['login-ok@example.com'])).rows[0].last_login_at, null);
    });

    test('every login makes a new session token', async () => {
      await makeUser('login-twice@example.com', 'member', sharedHash);
      const [a, b] = [await login('login-twice@example.com', PASSWORD), await login('login-twice@example.com', PASSWORD)];
      assert.notEqual(a.token, b.token);
      assert.equal(await sessionCount('login-twice@example.com'), 2);
    });

    test('a wrong password, an unknown email, no password, an invited and a disabled user all get the same 401 and no cookie', async () => {
      await makeUser('wrong@example.com', 'member', sharedHash);
      await makeUser('nopass@example.com', 'member', null);
      await makeUser('invited@example.com', 'member', sharedHash);
      await pool.query("UPDATE users SET status = 'invited' WHERE email = 'invited@example.com'");
      await makeUser('disabled@example.com', 'member', sharedHash);
      await pool.query("UPDATE users SET status = 'disabled' WHERE email = 'disabled@example.com'");
      const replies = [
        await login('wrong@example.com', 'not the password!!'),
        await login('nobody-here@example.com', PASSWORD),
        await login('nopass@example.com', PASSWORD),
        await login('invited@example.com', PASSWORD),
        await login('disabled@example.com', PASSWORD),
      ];
      for (const reply of replies) {
        assert.equal(reply.status, 401);
        assert.deepEqual(reply.json, { error: 'invalid credentials' });
        assert.equal(reply.headers.get('set-cookie'), null);
      }
      for (const email of ['wrong', 'nopass', 'invited', 'disabled']) assert.equal(await sessionCount(`${email}@example.com`), 0);
    });

    test('a request without the dashboard origin is refused before anything is checked, even with the right password', async () => {
      await makeUser('origin@example.com', 'member', sharedHash);
      for (const origin of [null, 'http://evil.example', 'null', 'http://gateway.urumi.test:8080', 'https://gateway.urumi.test', `${ORIGIN}/`]) {
        const reply = await login('origin@example.com', PASSWORD, origin);
        assert.equal(reply.status, 403, String(origin));
        assert.equal(reply.headers.get('set-cookie'), null);
      }
      assert.equal(await sessionCount('origin@example.com'), 0);
      // The refused requests were not counted as failed logins.
      assert.equal(await lockedSeconds(pool, emailThrottleKey('origin@example.com')), 0);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM login_throttle WHERE key_hash = $1', [emailThrottleKey('origin@example.com')])).rows[0].c, 0);
    });

    test('a body that is not the expected JSON is 400', async () => {
      const send = (body: unknown, type = 'application/json') =>
        fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': type, origin: ORIGIN }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      assert.equal((await send({})).status, 400);
      assert.equal((await send({ email: 'a@example.com' })).status, 400);
      assert.equal((await send({ email: 'a@example.com', password: 12345678901234 })).status, 400);
      assert.equal((await send({ email: 'a@example.com', password: 'x'.repeat(1025) })).status, 400);
      assert.equal((await send({ email: ['a@example.com'], password: PASSWORD })).status, 400);
      assert.equal((await send(`email=a@example.com&password=${PASSWORD}`, 'application/x-www-form-urlencoded')).status, 400);
      assert.equal((await send('{not json')).status, 400);
      assert.equal((await send({ email: 'a@example.com', password: PASSWORD, extra: 'x'.repeat(5000) })).status, 413);
    });
  });

  describe('the login throttle', () => {
    test('five wrong passwords lock the email: the sixth attempt is 429 with Retry-After, even with the right password', async () => {
      await makeUser('lock@example.com', 'member', sharedHash);
      for (let i = 0; i < MAX_FAILURES; i += 1) assert.equal((await login('lock@example.com', 'not the password!!')).status, 401, `attempt ${i + 1}`);
      const locked = await login('lock@example.com', PASSWORD);
      assert.equal(locked.status, 429);
      assert.deepEqual(locked.json, { error: 'too many attempts' });
      const wait = Number(locked.headers.get('retry-after'));
      assert.ok(wait > 0 && wait <= 900, `Retry-After ${wait}`);
      assert.equal(locked.headers.get('set-cookie'), null);
      assert.equal(await sessionCount('lock@example.com'), 0);
      // The lock is for that email only.
      assert.equal((await login('admin@example.com', PASSWORD)).status, 200);
      // The case and the spaces of the email do not give a second counter.
      assert.equal((await login('  LOCK@example.com', PASSWORD)).status, 429);
    });

    test('an email that does not exist is counted and locked the same way', async () => {
      for (let i = 0; i < MAX_FAILURES; i += 1) assert.equal((await login('ghost@example.com', PASSWORD)).status, 401);
      assert.equal((await login('ghost@example.com', PASSWORD)).status, 429);
    });

    test('a refused attempt during the lock does not make the lock longer', async () => {
      const key = emailThrottleKey('lock@example.com');
      const before = (await pool.query('SELECT locked_until, failures FROM login_throttle WHERE key_hash = $1', [key])).rows[0];
      await login('lock@example.com', PASSWORD);
      await login('lock@example.com', 'not the password!!');
      const after = (await pool.query('SELECT locked_until, failures FROM login_throttle WHERE key_hash = $1', [key])).rows[0];
      assert.deepEqual(after, before);
    });

    test('when the lock has passed, the right password works again and clears the count', async () => {
      const key = emailThrottleKey('lock@example.com');
      await pool.query("UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE key_hash = $1", [key]);
      assert.equal((await login('lock@example.com', PASSWORD)).status, 200);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM login_throttle WHERE key_hash = $1', [key])).rows[0].c, 0);
    });

    test('a success clears the failures, so failures before it do not add up with failures after it', async () => {
      await makeUser('clear@example.com', 'member', sharedHash);
      for (let i = 0; i < MAX_FAILURES - 1; i += 1) await login('clear@example.com', 'not the password!!');
      assert.equal((await login('clear@example.com', PASSWORD)).status, 200);
      for (let i = 0; i < MAX_FAILURES - 1; i += 1) assert.equal((await login('clear@example.com', 'not the password!!')).status, 401);
      assert.equal((await login('clear@example.com', PASSWORD)).status, 200);
    });

    test('failures older than the window start a new count', async () => {
      await makeUser('window@example.com', 'member', sharedHash);
      const key = emailThrottleKey('window@example.com');
      for (let i = 0; i < MAX_FAILURES - 1; i += 1) await login('window@example.com', 'not the password!!');
      await pool.query("UPDATE login_throttle SET window_started_at = now() - interval '16 minutes' WHERE key_hash = $1", [key]);
      assert.equal((await login('window@example.com', 'not the password!!')).status, 401);
      assert.equal((await pool.query('SELECT failures FROM login_throttle WHERE key_hash = $1', [key])).rows[0].failures, 1);
      assert.equal((await login('window@example.com', PASSWORD)).status, 200);
    });

    test('failures that arrive at the same time are all counted', async () => {
      const key = emailThrottleKey('parallel@example.com');
      await Promise.all(Array.from({ length: 10 }, () => recordFailure(pool, key)));
      assert.equal((await pool.query('SELECT failures FROM login_throttle WHERE key_hash = $1', [key])).rows[0].failures, 10);
      assert.ok((await lockedSeconds(pool, key)) > 0);
    });

    test('old rows that are not locked are removed when a failure is written; locked rows stay', async () => {
      const old = randomBytes(32);
      const lockedOld = randomBytes(32);
      await pool.query("INSERT INTO login_throttle (key_hash, failures, window_started_at) VALUES ($1, 2, now() - interval '2 hours')", [old]);
      await pool.query("INSERT INTO login_throttle (key_hash, failures, window_started_at, locked_until) VALUES ($1, 5, now() - interval '2 hours', now() + interval '5 minutes')", [lockedOld]);
      await recordFailure(pool, randomBytes(32));
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM login_throttle WHERE key_hash = $1', [old])).rows[0].c, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM login_throttle WHERE key_hash = $1', [lockedOld])).rows[0].c, 1);
    });
  });

  describe('GET /api/auth/me and POST /api/auth/logout', () => {
    test('me answers for a valid session with the user and an expiry, and for nobody else', async () => {
      await makeUser('me@example.com', 'member', sharedHash);
      const { token } = await login('me@example.com', PASSWORD);
      const reply = await call('GET', '/api/auth/me', { headers: withSession(token!) });
      assert.equal(reply.status, 200);
      assert.deepEqual(Object.keys(reply.json.user).sort(), ['email', 'id', 'role']);
      assert.equal(reply.json.user.email, 'me@example.com');
      const expires = Date.parse(reply.json.session.expiresAt);
      // The idle limit (2 hours) is earlier than the absolute limit (12 hours) for a new session.
      assert.ok(Math.abs(expires - (Date.now() + 2 * 3600_000)) < 60_000);
      assert.equal(reply.headers.get('cache-control'), 'no-store');

      const refusedHeaders: Array<Record<string, string>> = [{}, { cookie: 'session=' + randomBytes(32).toString('base64url') }, { cookie: 'session=not-a-token' }, { cookie: `other=${token}` }];
      for (const headers of refusedHeaders) {
        const refused = await call('GET', '/api/auth/me', { headers });
        assert.equal(refused.status, 401);
        assert.deepEqual(refused.json, { error: 'unauthorized' });
      }
    });

    test('an API key is not a browser login: it is refused on /me, with or without a cookie', async () => {
      assert.equal((await call('GET', '/api/auth/me', { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);
      const { token } = await login('admin@example.com', PASSWORD);
      assert.equal((await call('GET', '/api/auth/me', { headers: { authorization: `Bearer ${adminKey}`, ...withSession(token!) } })).status, 401);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 200);
    });

    test('a session that passed its absolute limit or its idle limit is refused', async () => {
      await makeUser('expire@example.com', 'member', sharedHash);
      const absolute = (await login('expire@example.com', PASSWORD)).token!;
      const idle = (await login('expire@example.com', PASSWORD)).token!;
      const fresh = (await login('expire@example.com', PASSWORD)).token!;
      await pool.query("UPDATE sessions SET created_at = now() - interval '13 hours', last_seen_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' WHERE token_hash = $1", [hashSessionToken(absolute)]);
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE token_hash = $1", [hashSessionToken(idle)]);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(absolute) })).status, 401);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(idle) })).status, 401);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(fresh) })).status, 200);
    });

    test('use of a session moves its idle limit, at most once a minute', async () => {
      await makeUser('touch@example.com', 'member', sharedHash);
      const { token } = await login('touch@example.com', PASSWORD);
      const hash = hashSessionToken(token!);
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '90 minutes' WHERE token_hash = $1", [hash]);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 200);
      let seconds = 9999;
      for (let i = 0; i < 40 && seconds > 60; i += 1) {
        seconds = (await pool.query('SELECT extract(epoch FROM now() - last_seen_at)::int AS s FROM sessions WHERE token_hash = $1', [hash])).rows[0].s;
        if (seconds > 60) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(seconds <= 60, `last_seen_at moved (${seconds} s ago)`);
    });

    test('a user who is disabled, and a changed role, take effect on the next request', async () => {
      await makeUser('status@example.com', 'member', sharedHash);
      const { token } = await login('status@example.com', PASSWORD);
      await pool.query("UPDATE users SET role = 'admin' WHERE email = 'status@example.com'");
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).json.user.role, 'admin');
      await pool.query("UPDATE users SET status = 'disabled' WHERE email = 'status@example.com'");
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 401);
      await pool.query("UPDATE users SET status = 'active' WHERE email = 'status@example.com'");
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 200);
    });

    test('logout needs the origin, then deletes the session and clears the cookie; the old cookie is refused afterwards', async () => {
      await makeUser('logout@example.com', 'member', sharedHash);
      const { token } = await login('logout@example.com', PASSWORD);
      const noOrigin = await call('POST', '/api/auth/logout', { headers: withSession(token!) });
      assert.equal(noOrigin.status, 403);
      const wrongOrigin = await call('POST', '/api/auth/logout', { headers: withSession(token!, 'http://evil.example') });
      assert.equal(wrongOrigin.status, 403);
      assert.equal(await sessionCount('logout@example.com'), 1);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 200);

      const out = await call('POST', '/api/auth/logout', { headers: withSession(token!, ORIGIN) });
      assert.equal(out.status, 204);
      assert.equal(out.headers.get('set-cookie'), 'session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
      assert.equal(await sessionCount('logout@example.com'), 0);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 401);
      assert.equal((await call('POST', '/api/auth/logout', { headers: withSession(token!, ORIGIN) })).status, 401);
    });

    test('logout without a session is 401 and ends nobody else', async () => {
      const { token } = await login('admin@example.com', PASSWORD);
      assert.equal((await call('POST', '/api/auth/logout', { headers: { origin: ORIGIN } })).status, 401);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(token!) })).status, 200);
    });
  });

  describe('the admin API accepts a session as well as an API key', () => {
    let adminToken: string;
    let memberToken: string;

    before(async () => {
      await makeUser('plain-member@example.com', 'member', sharedHash);
      adminToken = (await login('admin@example.com', PASSWORD)).token!;
      memberToken = (await login('plain-member@example.com', PASSWORD)).token!;
    });

    test('an admin session can read; a member session is 403; no credential is 401', async () => {
      assert.equal((await call('GET', '/api/admin/servers', { headers: withSession(adminToken) })).status, 200);
      assert.equal((await call('GET', '/api/admin/servers', { headers: withSession(memberToken) })).status, 403);
      assert.equal((await call('GET', '/api/admin/servers')).status, 401);
    });

    test('a change with a session needs the dashboard origin; with the right one it works', async () => {
      const body = { slug: 'viasession', name: 'Via session', url: 'http://viasession.test/mcp' };
      assert.equal((await call('POST', '/api/admin/servers', { body, headers: withSession(adminToken) })).status, 403);
      assert.equal((await call('POST', '/api/admin/servers', { body, headers: withSession(adminToken, 'http://evil.example') })).status, 403);
      assert.equal((await pool.query("SELECT count(*)::int AS c FROM upstream_servers WHERE slug = 'viasession'")).rows[0].c, 0);
      const created = await call('POST', '/api/admin/servers', { body, headers: withSession(adminToken, ORIGIN) });
      assert.equal(created.status, 201);
      const patched = await call('PATCH', `/api/admin/servers/${created.json.server.id}`, { body: { enabled: false }, headers: withSession(adminToken, ORIGIN) });
      assert.equal(patched.status, 200);
      assert.equal((await call('DELETE', `/api/admin/servers/${created.json.server.id}`, { headers: withSession(adminToken) })).status, 403);
      assert.equal((await call('DELETE', `/api/admin/servers/${created.json.server.id}`, { headers: withSession(adminToken, ORIGIN) })).status, 204);
    });

    test('a member session cannot change anything, with or without the origin', async () => {
      const body = { slug: 'viamember', name: 'Via member', url: 'http://viamember.test/mcp' };
      assert.equal((await call('POST', '/api/admin/servers', { body, headers: withSession(memberToken, ORIGIN) })).status, 403);
      assert.equal((await call('POST', '/api/admin/servers', { body, headers: withSession(memberToken) })).status, 403);
      assert.equal((await pool.query("SELECT count(*)::int AS c FROM upstream_servers WHERE slug = 'viamember'")).rows[0].c, 0);
    });

    test('an API key still works as before and needs no origin', async () => {
      assert.equal((await call('GET', '/api/admin/servers', { headers: { authorization: `Bearer ${adminKey}` } })).status, 200);
      const body = { slug: 'viakey', name: 'Via key', url: 'http://viakey.test/mcp' };
      const created = await call('POST', '/api/admin/servers', { body, headers: { authorization: `Bearer ${adminKey}` } });
      assert.equal(created.status, 201);
      await call('DELETE', `/api/admin/servers/${created.json.server.id}`, { headers: { authorization: `Bearer ${adminKey}` } });
    });

    test('a wrong key is 401 and never falls back to a valid cookie', async () => {
      const wrongKey = `mcpgw_${randomBytes(32).toString('base64url')}`;
      assert.equal((await call('GET', '/api/admin/servers', { headers: { authorization: `Bearer ${wrongKey}`, ...withSession(adminToken) } })).status, 401);
      assert.equal((await call('GET', '/api/admin/servers', { headers: { authorization: 'Bearer nonsense', ...withSession(adminToken) } })).status, 401);
    });
  });

  describe('POST /api/auth/accept-invite', () => {
    const accept = (token: string, password: string, origin: string | null = ORIGIN) =>
      call('POST', '/api/auth/accept-invite', { body: { token, password }, headers: origin === null ? {} : { origin } });
    const invited = async (email: string, status = 'invited') => {
      await makeUser(email, 'member', null);
      const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string;
      const token = (await issueInvite(pool, id))!;
      // The status is set after the invite is issued: a disabled user cannot be given one.
      await pool.query('UPDATE users SET status = $2 WHERE id = $1', [id, status]);
      return { id, token };
    };

    test('a valid invite sets the password, signs the person in, and the password then works at login', async () => {
      const { token } = await invited('accept1@example.com');
      const reply = await accept(token, 'chosen by the person 1');
      assert.equal(reply.status, 200);
      assert.deepEqual(Object.keys(reply.json), ['user']);
      assert.equal(reply.json.user.email, 'accept1@example.com');
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.match(reply.headers.getSetCookie()[0]!, /^session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(reply.token!) })).status, 200);
      assert.equal((await login('accept1@example.com', 'chosen by the person 1')).status, 200);
      assert.equal((await login('accept1@example.com', 'not chosen by anyone')).status, 401);
    });

    test('a request without the dashboard origin is refused and the token is not used up', async () => {
      const { token } = await invited('accept2@example.com');
      for (const origin of [null, 'http://evil.example']) {
        assert.equal((await accept(token, 'chosen by the person 2', origin)).status, 403);
      }
      assert.equal((await accept(token, 'chosen by the person 2')).status, 200);
    });

    test('a used token, a wrong token, an expired token and a disabled user all get the same 400', async () => {
      const used = await invited('accept3@example.com');
      await accept(used.token, 'chosen by the person 3');
      const expired = await invited('accept4@example.com');
      await pool.query("UPDATE users SET invite_expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
      const disabled = await invited('accept5@example.com', 'disabled');
      const bodies = new Set<string>();
      for (const token of [used.token, generateInviteToken(), expired.token, disabled.token, 'inv_short']) {
        const reply = await accept(token, 'chosen by the person 4');
        assert.equal(reply.status, 400);
        assert.equal(reply.headers.get('set-cookie'), null);
        bodies.add(JSON.stringify(reply.json));
      }
      assert.deepEqual([...bodies], ['{"error":"invalid or expired invite"}']);
    });

    test('a weak password is 400 with a reason that does not repeat it, and the invite still works afterwards', async () => {
      const { token } = await invited('accept6@example.com');
      const reply = await accept(token, 'tooshort');
      assert.equal(reply.status, 400);
      assert.equal(reply.json.error, 'weak password');
      assert.match(reply.json.reason, /at least 12/);
      assert.equal(JSON.stringify(reply.json).includes('tooshort'), false);
      assert.equal(reply.headers.get('set-cookie'), null);
      assert.equal((await accept(token, 'a long enough password 6')).status, 200);
    });

    test('a body that is not the expected JSON is 400, and a big one is 413', async () => {
      const send = (body: unknown) => fetch(`${base}/api/auth/accept-invite`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
      assert.equal((await send({})).status, 400);
      assert.equal((await send({ token: generateInviteToken() })).status, 400);
      assert.equal((await send({ token: 5, password: 'a long enough password' })).status, 400);
      assert.equal((await send({ token: generateInviteToken(), password: 'a long enough password', pad: 'x'.repeat(5000) })).status, 413);
    });

    test('accepting a reset invite ends the sessions that existed, and the old password stops working', async () => {
      await makeUser('accept7@example.com', 'member', sharedHash);
      const old = (await login('accept7@example.com', PASSWORD)).token!;
      const id = (await pool.query("SELECT id FROM users WHERE email = 'accept7@example.com'")).rows[0].id as string;
      const token = (await issueInvite(pool, id))!;
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(old) })).status, 200);
      const reply = await accept(token, 'the new password for 7');
      assert.equal(reply.status, 200);
      assert.equal((await call('GET', '/api/auth/me', { headers: withSession(old) })).status, 401);
      assert.equal((await login('accept7@example.com', PASSWORD)).status, 401);
      assert.equal((await login('accept7@example.com', 'the new password for 7')).status, 200);
    });

    test('neither the token nor the password is written to the log', async () => {
      const { token } = await invited('accept8@example.com');
      await accept(token, 'tooshort-for-the-scan');
      await accept(token, 'a password for the scan 8');
      const log = logLines.join(' ');
      for (const secret of [token, 'tooshort-for-the-scan', 'a password for the scan 8']) assert.equal(log.includes(secret), false);
      assert.ok(logLines.some((line) => line.includes('"message":"invite accepted"')));
      assert.equal(logLines.filter((line) => /"message":"invite/.test(line)).join(' ').includes('@'), false);
    });
  });

  describe('the public MCP endpoint', () => {
    test('a session cookie is not accepted on /mcp, with the right origin or without', async () => {
      const { token } = await login('admin@example.com', PASSWORD);
      for (const headers of [withSession(token!), withSession(token!, ORIGIN)]) {
        const reply = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers });
        assert.equal(reply.status, 401);
      }
    });
  });

  test('no password, session token or password hash is written to the log, and none is in a response body', async () => {
    const { token } = await login('admin@example.com', PASSWORD);
    await call('GET', '/api/auth/me', { headers: withSession(token!) });
    await login('admin@example.com', 'a-wrong-password-for-the-scan');
    const stored = (await pool.query('SELECT password_hash FROM users WHERE email = $1', ['admin@example.com'])).rows[0].password_hash as string;
    const log = logLines.join('\n');
    for (const secret of [PASSWORD, 'a-wrong-password-for-the-scan', token!, stored, stored.split('$')[5]!, adminKey]) {
      assert.equal(log.includes(secret), false);
    }
    // The admin API logs who changed a server (an existing line); the login and session lines hold no email.
    const authLines = logLines.filter((line) => /"message":"(login|logout|session)/.test(line));
    assert.ok(authLines.length >= 3);
    assert.equal(authLines.join(' ').includes('@'), false, 'the login lines hold no email');
    for (const path of ['/api/auth/me']) {
      const body = JSON.stringify((await call('GET', path, { headers: withSession(token!) })).json);
      assert.equal(body.includes(stored), false);
      assert.equal(body.includes('password'), false);
      assert.equal(body.includes(token!), false);
    }
  });
});
