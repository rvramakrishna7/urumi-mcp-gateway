import { after, before, beforeEach, describe, test } from 'node:test';
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
import { loadKeyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

// The admin API starts a refresh of the poller after a server was created or changed, and never waits for it.
describe('admin API: refresh after a server change (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let keyDir: string;
  let adminKey: string;
  let behaviour: () => Promise<unknown> | void = () => {};
  let calls = 0;
  let logLines: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  const send = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const create = (slug: string) => send('POST', '/api/admin/servers', { slug, name: slug, url: `http://${slug}.test/mcp` });
  // Gives a rejected promise that nobody handles the time to be reported by Node.
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

  before(async () => {
    process.on('unhandledRejection', onUnhandled);
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-refresh-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    const keyring = loadKeyring(join(keyDir, 'key'), 'k1');
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    await createUser(pool, 'admin@example.com', 'admin');
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;

    const logger = createLogger((line) => logLines.push(line));
    const { app } = createApp({
      logger,
      checkDatabase: async () => {},
      admin: { db: pool, keyring, logger, upstream: TEST_UPSTREAM, onServerChanged: () => { calls += 1; return behaviour(); } },
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    process.off('unhandledRejection', onUnhandled);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    behaviour = () => {};
    calls = 0;
    logLines = [];
    unhandled.length = 0;
  });

  test('create and every kind of update start one refresh; a read, a delete and a rejected request start none', async () => {
    const created = await create('one');
    assert.equal(created.status, 201);
    assert.equal(calls, 1);
    const id = created.json.server.id;
    for (const patch of [{ enabled: false }, { enabled: true }, { name: 'Renamed' }, { url: 'http://moved.test/mcp' }, { credential: { kind: 'bearer', value: 'a-new-credential-value' } }, { credential: null }]) {
      const previous: number = calls;
      assert.equal((await send('PATCH', `/api/admin/servers/${id}`, patch)).status, 200, JSON.stringify(Object.keys(patch)));
      assert.equal(calls, previous + 1, JSON.stringify(Object.keys(patch)));
    }
    const settled = calls;
    assert.equal((await send('GET', '/api/admin/servers')).status, 200);
    assert.equal((await send('PATCH', `/api/admin/servers/${id}`, { bogus: true })).status, 400);
    assert.equal((await create('one')).status, 409, 'a conflict is not a change');
    assert.equal((await send('PATCH', '/api/admin/servers/00000000-0000-4000-8000-000000000000', { enabled: false })).status, 404);
    assert.equal((await send('DELETE', `/api/admin/servers/${id}`)).status, 204);
    assert.equal(calls, settled, 'no refresh for a read, a bad request, a conflict, a missing server or a delete');
  });

  test('a refresh that never finishes does not hold the answer back', async () => {
    behaviour = () => new Promise(() => {});
    const started = Date.now();
    assert.equal((await create('hanging')).status, 201);
    assert.ok(Date.now() - started < 2000, 'the answer did not wait for the refresh');
    assert.equal(calls, 1);
  });

  test('a refresh that rejects: the answer is still 2xx, the error is logged by class only, and nothing is unhandled', async () => {
    behaviour = () => Promise.reject(new TypeError('secret detail that must not be logged'));
    const created = await create('rejecting');
    assert.equal(created.status, 201);
    const id = created.json.server.id;
    assert.equal((await send('PATCH', `/api/admin/servers/${id}`, { enabled: false })).status, 200);
    await settle();
    assert.equal(calls, 2);
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
    const failures = logLines.map((line) => JSON.parse(line)).filter((entry) => entry.message === 'refresh after a server change failed');
    assert.equal(failures.length, 2);
    assert.equal(failures[0].errorName, 'TypeError');
    assert.ok(!logLines.join('\n').includes('secret detail'), 'the message of the error is not logged');
  });

  test('a refresh that throws at once is also contained', async () => {
    behaviour = () => { throw new Error('synchronous failure'); };
    assert.equal((await create('throwing')).status, 201);
    await settle();
    assert.deepEqual(unhandled, []);
    assert.equal(logLines.filter((line) => line.includes('refresh after a server change failed')).length, 1);
  });
});
