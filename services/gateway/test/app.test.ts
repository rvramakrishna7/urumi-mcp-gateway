import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { checkDatabase } from '../src/db/pool.ts';
import { createLogger } from '../src/logger.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function listen(app: ReturnType<typeof createApp>['app']): Promise<Server> {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

function close(instance: Server): Promise<void> {
  return new Promise((resolve) => {
    instance.close(() => resolve());
    instance.closeAllConnections();
  });
}

describe('gateway app: health routes', () => {
  let databaseUp = true;
  let checks = 0;
  const logLines: string[] = [];
  let server: Server;
  let base: string;
  let beginShutdown: () => void;

  before(async () => {
    const created = createApp({
      logger: createLogger((line) => logLines.push(line)),
      checkDatabase: async () => {
        checks++;
        if (!databaseUp) throw new Error('connect ECONNREFUSED 10.0.0.1:5432 password=secret-value');
      },
    });
    beginShutdown = created.beginShutdown;
    server = await listen(created.app);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await close(server);
  });

  test('/healthz answers 200 and carries a request id', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.match(response.headers.get('x-request-id') ?? '', UUID);
  });

  test('/readyz answers 200 when the database answers', async () => {
    databaseUp = true;
    const response = await fetch(`${base}/readyz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready' });
  });

  test('/readyz answers 503 when the database does not answer, and says nothing about why', async () => {
    databaseUp = false;
    const response = await fetch(`${base}/readyz`);
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), { status: 'database-unavailable' });
    assert.ok(!text.includes('ECONNREFUSED') && !text.includes('secret-value'));
    databaseUp = true;
  });

  test('/healthz does not look at the database: it still answers 200 when the database is down', async () => {
    databaseUp = false;
    const before = checks;
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(checks, before);
    databaseUp = true;
  });

  test('an unknown path answers 404 as JSON, not as an HTML page', async () => {
    const response = await fetch(`${base}/nothing-here`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not found' });
  });

  test('the log has method, path without the query string, status and duration, and nothing from the request', async () => {
    await fetch(`${base}/healthz?token=should-not-be-logged`, { headers: { authorization: 'Bearer should-not-be-logged' } });
    const line = logLines.map((raw) => JSON.parse(raw)).filter((entry) => entry.path === '/healthz').pop();
    assert.ok(line);
    assert.equal(line.method, 'GET');
    assert.equal(line.status, 200);
    assert.equal(typeof line.durationMs, 'number');
    assert.ok(!logLines.join('\n').includes('should-not-be-logged'));
  });

  test('/readyz answers 503 after beginShutdown without asking the database, /healthz still answers 200', async () => {
    const before = checks;
    beginShutdown();
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'shutting-down' });
    assert.equal(checks, before);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

describe('checkDatabase', () => {
  test('resolves when the query answers', async () => {
    await checkDatabase({ query: (async () => ({ rows: [] })) as never }, 200);
  });

  test('rejects when the query fails', async () => {
    await assert.rejects(checkDatabase({ query: (async () => { throw new Error('boom'); }) as never }, 200), /boom/);
  });

  test('rejects after the deadline when the query never answers', async () => {
    const start = Date.now();
    await assert.rejects(checkDatabase({ query: (() => new Promise(() => {})) as never }, 60), /timed out/);
    assert.ok(Date.now() - start < 1000);
  });
});
