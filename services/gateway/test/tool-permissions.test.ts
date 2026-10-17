import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { createGateway } from '../src/core/gateway.ts';
import type { Caller, Gateway } from '../src/core/gateway.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
import type { McpRouter } from '../src/mcp/router.ts';
import { insertServer } from '../src/registry/repository.ts';
import { createPoller } from '../src/upstream/poller.ts';
import type { Poller } from '../src/upstream/poller.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';
import { startFake } from './helpers/fake-upstream.ts';
import type { Fake } from './helpers/fake-upstream.ts';

const HOST = 'gateway.test';
const schema = { type: 'object', properties: { text: { type: 'string' } } };
const tool = (name: string) => ({ name, description: `The ${name} tool`, inputSchema: schema });
const TOOLS = ['list_orders', 'create_product', 'update_order_status', 'convert_amounts', 'fetch'];
const ADMIN_REQUIRED = 'This tool requires admin access';

// Static tool permissions for the member role. Two gateways share one database and one fake upstream: "gateway" has an
// explicit list, "defaultGateway" has the built-in default list for the slugs woo, fx and fetch. Every slug points at the
// same fake, so fake.toolCalls() counts what really reached an upstream.
describe('member tool restrictions: listTools, callTool, rejectToolCall and the public /mcp endpoint (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keyDir: string;
  let keyring: Keyring;
  let gateway: Gateway;
  let defaultGateway: Gateway;
  let poller: Poller;
  let mcp: McpRouter;
  let server: Server;
  let base: string;
  let fake: Fake;
  let admin: Caller;
  let member: Caller;
  let adminKey: string;
  let memberKey: string;

  const textOf = (result: { content?: unknown }) => ((result.content as Array<{ text: string }>)[0] ?? { text: '' }).text;
  const names = async (g: Gateway, caller: Caller) => (await g.listTools(caller)).map((entry) => entry.name).sort();
  const auditRows = async () =>
    (await pool.query('SELECT user_email, via, server_slug, tool, requested_name, outcome, error_kind, duration_ms FROM audit_log ORDER BY id')).rows as {
      user_email: string; via: string; server_slug: string | null; tool: string | null; requested_name: string; outcome: string; error_kind: string | null; duration_ms: number | null;
    }[];
  const lastRow = async () => (await auditRows()).at(-1)!;

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return client;
  }

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'tool-permissions-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    keyring = loadKeyring(join(keyDir, 'key'), 'k1');

    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    const adminUser = await createUser(pool, 'admin@example.com', 'admin');
    const memberUser = await createUser(pool, 'member@example.com', 'member');
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;
    memberKey = (await createApiKey(pool, 'member@example.com', 'member key')).key;
    admin = { userId: adminUser.id, email: adminUser.email, role: 'admin', via: 'mcp' };
    member = { userId: memberUser.id, email: memberUser.email, role: 'member', via: 'mcp' };

    fake = await startFake({ tools: TOOLS.map(tool) });
    // "off" is enabled while the poller caches its tools and disabled afterwards, so its tools exist in the cache.
    for (const slug of ['shop', 'off', 'woo', 'fx', 'fetch']) {
      await insertServer(pool, keyring, { slug, name: slug, url: fake.url, enabled: true, callTimeoutMs: 5000 }, { createdBy: null, seedManaged: false });
    }

    const logger = createLogger(() => {});
    gateway = createGateway({ db: pool, keyring, logger, memberRestrictedTools: ['shop__create_product', 'shop__update_order_status', 'off__create_product', 'gone__create_product'] });
    defaultGateway = createGateway({ db: pool, keyring, logger });
    poller = createPoller({ db: pool, keyring, logger });
    await poller.refreshNow();
    await pool.query("UPDATE upstream_servers SET enabled = false WHERE slug = 'off'");

    mcp = createMcpRouter({ db: pool, gateway, logger, allowedHosts: [HOST, '127.0.0.1'] });
    const { app } = createApp({ logger, checkDatabase: async () => {}, mcp: mcp.router });
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
    await mcp.close();
    await poller.stop();
    await fake.stop();
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  test('listTools: a member does not see the restricted names, an admin sees every name', async () => {
    const forAdmin = await names(gateway, admin);
    const forMember = await names(gateway, member);
    assert.ok(forAdmin.includes('shop__create_product') && forAdmin.includes('shop__update_order_status'));
    assert.ok(!forMember.includes('shop__create_product') && !forMember.includes('shop__update_order_status'));
    assert.deepEqual(forAdmin.filter((name) => !forMember.includes(name)), ['shop__create_product', 'shop__update_order_status']);
    assert.ok(forMember.includes('shop__list_orders') && forMember.includes('woo__create_product'), 'only the configured names are hidden');
  });

  test('callTool: a member calling a restricted tool is refused, nothing reaches the upstream, and the audit row says denied', async () => {
    const before = fake.toolCalls();
    const rowsBefore = (await auditRows()).length;
    const result = await gateway.callTool(member, 'shop__create_product', { text: 'x' });
    assert.deepEqual([result.isError, textOf(result)], [true, ADMIN_REQUIRED]);
    assert.equal(fake.toolCalls(), before, 'no request reached the upstream');
    const rows = await auditRows();
    assert.equal(rows.length, rowsBefore + 1, 'exactly one row');
    const row = rows.at(-1)!;
    assert.deepEqual(
      [row.user_email, row.via, row.server_slug, row.tool, row.requested_name, row.outcome, row.error_kind],
      ['member@example.com', 'mcp', 'shop', 'create_product', 'shop__create_product', 'denied', 'member_restricted'],
    );
    assert.ok(row.duration_ms !== null && row.duration_ms >= 0, 'the row is complete: duration is set');
  });

  test('callTool: the same call from an admin runs, and an unrestricted tool runs for a member', async () => {
    const before = fake.toolCalls();
    assert.equal((await gateway.callTool(admin, 'shop__create_product', {})).isError, undefined);
    assert.equal((await gateway.callTool(member, 'shop__list_orders', {})).isError, undefined);
    assert.equal(fake.toolCalls(), before + 2);
    assert.equal((await lastRow()).outcome, 'ok');
  });

  test('callTool: an unknown or disabled tool answers "Unknown tool" even when its name is on the list', async () => {
    const before = fake.toolCalls();
    for (const name of ['gone__create_product', 'off__create_product']) {
      const result = await gateway.callTool(member, name, {});
      assert.deepEqual([result.isError, textOf(result)], [true, 'Unknown tool'], name);
      const row = await lastRow();
      assert.deepEqual([row.outcome, row.error_kind], ['unknown_tool', null], name);
    }
    assert.equal(fake.toolCalls(), before);
  });

  test('a role that is neither admin nor member is treated as a member (fail closed)', async () => {
    const stranger = { ...member, role: 'owner' } as unknown as Caller;
    assert.ok(!(await names(gateway, stranger)).includes('shop__create_product'));
    const result = await gateway.callTool(stranger, 'shop__create_product', {});
    assert.deepEqual([result.isError, textOf(result)], [true, ADMIN_REQUIRED]);
  });

  test('the built-in default list: the member tools of Step 18 stay allowed, the two write tools are refused', async () => {
    const forMember = await names(defaultGateway, member);
    for (const hidden of ['woo__create_product', 'woo__update_order_status']) assert.ok(!forMember.includes(hidden), hidden);
    for (const allowed of ['woo__list_orders', 'fx__convert_amounts']) assert.ok(forMember.includes(allowed), allowed);
    const before = fake.toolCalls();
    assert.equal((await defaultGateway.callTool(member, 'woo__list_orders', {})).isError, undefined);
    assert.equal((await defaultGateway.callTool(member, 'fx__convert_amounts', {})).isError, undefined);
    assert.equal(fake.toolCalls(), before + 2);
    for (const denied of ['woo__create_product', 'woo__update_order_status']) {
      const result = await defaultGateway.callTool(member, denied, {});
      assert.deepEqual([result.isError, textOf(result)], [true, ADMIN_REQUIRED], denied);
    }
    assert.equal(fake.toolCalls(), before + 2, 'the refused calls reached no upstream');
  });

  test('the built-in default list: fetch__fetch is allowed for a member (listed and not refused as member_restricted)', async () => {
    assert.ok((await names(defaultGateway, member)).includes('fetch__fetch'));
    const before = fake.toolCalls();
    const result = await defaultGateway.callTool(member, 'fetch__fetch', {});
    assert.equal(result.isError, undefined);
    assert.equal(fake.toolCalls(), before + 1);
    const row = await lastRow();
    assert.deepEqual([row.tool, row.outcome, row.error_kind], ['fetch', 'ok', null]);
  });

  test('rejectToolCall: it writes a complete row and never reaches an upstream', async () => {
    const before = fake.toolCalls();
    // An admin, a name that exists but was not offered: denied / not_offered.
    let result = await gateway.rejectToolCall({ ...admin, via: 'chat' }, 'shop__list_orders', 'not_offered');
    assert.deepEqual([result.isError, textOf(result)], [true, 'Unknown tool']);
    let row = await lastRow();
    assert.deepEqual([row.via, row.server_slug, row.tool, row.outcome, row.error_kind], ['chat', 'shop', 'list_orders', 'denied', 'not_offered']);
    assert.ok(row.duration_ms !== null);
    // A member, a restricted name: denied / member_restricted.
    result = await gateway.rejectToolCall({ ...member, via: 'chat' }, 'shop__create_product', 'not_offered');
    assert.deepEqual([result.isError, textOf(result)], [true, ADMIN_REQUIRED]);
    row = await lastRow();
    assert.deepEqual([row.outcome, row.error_kind, row.tool], ['denied', 'member_restricted', 'create_product']);
    // A name that does not exist, and a disabled server: unknown_tool, as callTool answers.
    for (const name of ['nope__missing', 'off__list_orders']) {
      result = await gateway.rejectToolCall({ ...member, via: 'chat' }, name, 'not_offered');
      assert.deepEqual([result.isError, textOf(result)], [true, 'Unknown tool'], name);
      assert.equal((await lastRow()).outcome, 'unknown_tool', name);
    }
    assert.equal(fake.toolCalls(), before, 'no request reached the upstream');
  });

  test('/mcp as a member: the restricted tools are not listed, and a call from a cached list is refused and audited', async () => {
    const client = await connect(memberKey);
    try {
      const listed = (await client.listTools()).tools.map((entry) => entry.name);
      assert.ok(!listed.includes('shop__create_product') && !listed.includes('shop__update_order_status'));
      assert.ok(listed.includes('shop__list_orders'));
      const before = fake.toolCalls();
      const result = await client.callTool({ name: 'shop__create_product', arguments: {} });
      assert.deepEqual([result.isError, textOf(result)], [true, ADMIN_REQUIRED]);
      assert.equal(fake.toolCalls(), before);
      const row = await lastRow();
      assert.deepEqual([row.user_email, row.via, row.outcome, row.error_kind], ['member@example.com', 'mcp', 'denied', 'member_restricted']);
    } finally {
      await client.close();
    }
  });

  test('/mcp as an admin: every tool is listed and the restricted tool runs', async () => {
    const client = await connect(adminKey);
    try {
      const listed = (await client.listTools()).tools.map((entry) => entry.name);
      assert.ok(listed.includes('shop__create_product') && listed.includes('shop__update_order_status'));
      const before = fake.toolCalls();
      const result = await client.callTool({ name: 'shop__create_product', arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(fake.toolCalls(), before + 1);
      const row = await lastRow();
      assert.deepEqual([row.user_email, row.via, row.outcome], ['admin@example.com', 'mcp', 'ok']);
    } finally {
      await client.close();
    }
  });

  test('a role change takes effect on the next request: the same key lists and calls differently after a promotion', async () => {
    const client = await connect(memberKey);
    try {
      assert.ok(!(await client.listTools()).tools.some((entry) => entry.name === 'shop__create_product'));
      await pool.query("UPDATE users SET role = 'admin' WHERE email = 'member@example.com'");
      assert.ok((await client.listTools()).tools.some((entry) => entry.name === 'shop__create_product'));
      assert.notEqual((await client.callTool({ name: 'shop__create_product', arguments: {} })).isError, true);
      await pool.query("UPDATE users SET role = 'member' WHERE email = 'member@example.com'");
      const again = await client.callTool({ name: 'shop__create_product', arguments: {} });
      assert.deepEqual([again.isError, textOf(again)], [true, ADMIN_REQUIRED]);
    } finally {
      await pool.query("UPDATE users SET role = 'member' WHERE email = 'member@example.com'");
      await client.close();
    }
  });
});
