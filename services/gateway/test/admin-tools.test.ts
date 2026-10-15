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
import { loadKeyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { insertServer } from '../src/registry/repository.ts';
import { replaceTools } from '../src/upstream/tools-repository.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const MARKER = 'DESCRIPTION-MARKER-MUST-NOT-APPEAR';
const hash = (text: string) => createHash('sha256').update(text).digest();
const accepted = (name: string) => ({ name, description: MARKER, descriptionHash: hash(name), inputSchema: { type: 'object', properties: { secret: { type: 'string' } } }, annotations: null });

// GET /api/admin/tools: the cached tool names of every server, for the servers screen. No call to an upstream.
describe('admin API: cached tool names (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let keyDir: string;
  let adminKey: string;
  let memberKey: string;
  let rawBody = '';

  const get = async (key: string | null) => {
    const response = await fetch(`${base}/api/admin/tools`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    const text = await response.text();
    rawBody = text;
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-admin-tools-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    const keyring = loadKeyring(join(keyDir, 'key'), 'k1');
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    await createUser(pool, 'admin@example.com', 'admin');
    await createUser(pool, 'member@example.com', 'member');
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;
    memberKey = (await createApiKey(pool, 'member@example.com', 'member key')).key;

    const mk = (slug: string, enabled = true) => insertServer(pool, keyring, { slug, name: slug, url: `http://${slug}.test/mcp`, enabled, callTimeoutMs: 30_000 }, { createdBy: null, seedManaged: false });
    const woo = await mk('woo');
    await mk('empty');
    const off = await mk('off', false);
    await replaceTools(pool, woo.id, { accepted: [accepted('list_products'), accepted('create_product')], skipped: [{ name: 'bad.name', reason: 'invalid_name', descriptionHash: null }], note: null });
    await replaceTools(pool, off.id, { accepted: [accepted('ping')], skipped: [], note: null });

    const logger = createLogger(() => {});
    const { app } = createApp({ logger, checkDatabase: async () => {}, admin: { db: pool, keyring, logger } });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  test('401 without a key and 403 for a member: the route is admin only', async () => {
    assert.equal((await get(null)).status, 401);
    assert.equal((await get(memberKey)).status, 403);
  });

  test('an admin gets the names of every server: exposed tools, skipped tools, and an empty list for a server with none', async () => {
    const { status, json } = await get(adminKey);
    assert.equal(status, 200);
    assert.deepEqual(json.servers.map((s: { slug: string }) => s.slug), ['empty', 'off', 'woo']);
    const woo = json.servers.find((s: { slug: string }) => s.slug === 'woo');
    assert.deepEqual(woo.tools, [
      { name: 'create_product', exposedName: 'woo__create_product' },
      { name: 'list_products', exposedName: 'woo__list_products' },
    ]);
    assert.deepEqual(woo.skipped, [{ name: 'bad.name', reason: 'invalid_name' }]);
    assert.ok(typeof woo.fetchedAt === 'string');
    const empty = json.servers.find((s: { slug: string }) => s.slug === 'empty');
    assert.deepEqual({ tools: empty.tools, skipped: empty.skipped, fetchedAt: empty.fetchedAt }, { tools: [], skipped: [], fetchedAt: null });
  });

  test('a disabled server keeps its cached names (the screen reads its state from the server list)', async () => {
    const { json } = await get(adminKey);
    const off = json.servers.find((s: { slug: string }) => s.slug === 'off');
    assert.deepEqual(off.tools, [{ name: 'ping', exposedName: 'off__ping' }]);
  });

  test('names only: no description, schema or hash leaves the gateway (planted marker is absent, control is present)', async () => {
    await get(adminKey);
    assert.ok(rawBody.length > 100, 'the body was read');
    assert.ok(rawBody.includes('woo__list_products'), 'control: a planted name is found by the same check');
    for (const needle of [MARKER, 'inputSchema', 'description', 'secret', 'annotations']) {
      assert.ok(!rawBody.includes(needle), `${needle} must not be in the answer`);
    }
  });
});
