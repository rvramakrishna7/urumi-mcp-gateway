import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { createGateway } from '../src/core/gateway.ts';
import type { Gateway } from '../src/core/gateway.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser, listApiKeys, revokeApiKey } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createMcpRouter, MAX_BODY_BYTES } from '../src/mcp/router.ts';
import type { McpRouter } from '../src/mcp/router.ts';
import { getServerBySlug, insertServer, patchServer } from '../src/registry/repository.ts';
import { createPoller } from '../src/upstream/poller.ts';
import type { Poller } from '../src/upstream/poller.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';
import { startFake } from './helpers/fake-upstream.ts';
import type { Fake } from './helpers/fake-upstream.ts';

const UPSTREAM_TOKEN = 'canary-mcp-endpoint-upstream-token-7c2e91d4a8b03f56';
const HOST = 'gateway.test';
const schema = { type: 'object', properties: { text: { type: 'string' } } };
const tool = (name: string) => ({ name, description: `The ${name} tool`, inputSchema: schema });

// Searches texts for secrets. Used on the real data and, as a control, on data with a planted secret.
function findLeaks(texts: string[], secrets: string[]): string[] {
  return secrets.filter((secret) => texts.some((text) => text.includes(secret)));
}

describe('public /mcp endpoint, with the real SDK client against fake upstreams (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keyDir: string;
  let keyring: Keyring;
  let gateway: Gateway;
  let poller: Poller;
  let mcp: McpRouter;
  let server: Server;
  let base: string;
  let port: number;
  let adminKey: string;
  let memberKey: string;
  let memberKeyId: string;
  let shop: Fake;
  let other: Fake;
  const logLines: string[] = [];
  // Every response body that a test received, for the leak scan.
  const received: string[] = [];

  // The real SDK client, as an external client (Claude Code, MCP Inspector) would connect: a URL and a key.
  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return client;
  }

  // Plain node:http, because fetch does not let a test choose the Host header with certainty.
  function raw(options: { method?: string; path?: string; host?: string; key?: string | null; body?: string; headers?: Record<string, string> }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: options.host ?? `${HOST}:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...options.headers };
      if (options.key) headers.authorization = `Bearer ${options.key}`;
      const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/mcp', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          received.push(text);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      });
      req.on('error', reject);
      req.end(options.body);
    });
  }

  const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const textOf = (result: { content?: unknown }) => ((result.content as Array<{ text: string }>)[0] ?? { text: '' }).text;
  const auditRows = async () => (await pool.query('SELECT user_email, via, requested_name, outcome FROM audit_log ORDER BY id')).rows;

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'mcp-endpoint-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    keyring = loadKeyring(join(keyDir, 'key'), 'k1');

    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    await createUser(pool, 'admin@example.com', 'admin');
    await createUser(pool, 'member@example.com', 'member');
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;
    const member = await createApiKey(pool, 'member@example.com', 'member key');
    memberKey = member.key;
    memberKeyId = member.view.id;

    shop = await startFake({ token: UPSTREAM_TOKEN, tools: [tool('list_orders'), tool('create_product')] });
    other = await startFake({ tools: [tool('ping')] });
    for (const [slug, fake, bearer] of [['shop', shop, UPSTREAM_TOKEN], ['other', other, undefined]] as const) {
      await insertServer(
        pool,
        keyring,
        { slug, name: slug, url: fake.url, enabled: true, callTimeoutMs: 5000, ...(bearer ? { credential: { kind: 'bearer' as const, value: bearer } } : {}) },
        { createdBy: null, seedManaged: false },
      );
    }

    const logger = createLogger((line) => logLines.push(line));
    gateway = createGateway({ db: pool, keyring, logger });
    poller = createPoller({ db: pool, keyring, logger });
    await poller.refreshNow();

    mcp = createMcpRouter({ db: pool, gateway, logger, allowedHosts: [HOST, '127.0.0.1'] });
    const { app } = createApp({ logger, checkDatabase: async () => {}, mcp: mcp.router });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await mcp.close();
    await poller.stop();
    await Promise.all([shop.stop(), other.stop()]);
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  test('a client with a URL and a key connects and lists the tools of every connected upstream', async () => {
    const client = await connect(memberKey);
    try {
      const names = (await client.listTools()).tools.map((entry) => entry.name).sort();
      assert.deepEqual(names, ['other__ping', 'shop__create_product', 'shop__list_orders']);
      received.push(JSON.stringify(names));
    } finally {
      await client.close();
    }
  });

  test('a call from the member and a call from the admin each have one audit row with via "mcp" and the right user', async () => {
    const asMember = await connect(memberKey);
    const asAdmin = await connect(adminKey);
    try {
      const memberResult = await asMember.callTool({ name: 'shop__list_orders', arguments: { text: 'date=2026-10-09' } });
      received.push(JSON.stringify(memberResult));
      assert.equal(textOf(memberResult), 'list_orders done {"text":"date=2026-10-09"}');
      const adminResult = await asAdmin.callTool({ name: 'other__ping', arguments: {} });
      received.push(JSON.stringify(adminResult));
      assert.equal(textOf(adminResult), 'ping done {}');
    } finally {
      await asMember.close();
      await asAdmin.close();
    }
    assert.deepEqual(await auditRows(), [
      { user_email: 'member@example.com', via: 'mcp', requested_name: 'shop__list_orders', outcome: 'ok' },
      { user_email: 'admin@example.com', via: 'mcp', requested_name: 'other__ping', outcome: 'ok' },
    ]);
  });

  test('the upstream got its own credential and never a gateway key', () => {
    const headers = JSON.stringify(shop.requests.map((entry) => entry.authorization).concat(other.requests.map((entry) => entry.authorization)));
    assert.ok(headers.includes(UPSTREAM_TOKEN));
    assert.deepEqual(findLeaks([headers], [adminKey, memberKey]), []);
  });

  test('a 2025-era client (no server/discover, plain JSON-RPC POST) is served on the same URL', async () => {
    const response = await raw({ key: memberKey, body: listBody });
    assert.equal(response.status, 200);
    assert.match(response.text, /shop__list_orders/);
  });

  test('a missing, malformed, unknown or revoked-looking key gets the same 401 and the same body', async () => {
    const unknown = `mcpgw_${'A'.repeat(43)}`;
    const answers = [
      await raw({ key: null, body: listBody }),
      await raw({ key: 'not-a-key', body: listBody }),
      await raw({ key: unknown, body: listBody }),
    ];
    for (const answer of answers) {
      assert.equal(answer.status, 401);
      assert.equal(answer.headers['www-authenticate'], 'Bearer');
    }
    assert.equal(new Set(answers.map((answer) => answer.text)).size, 1, 'the caller learns nothing about why');
  });

  test('a key in the query string is not accepted', async () => {
    assert.equal((await raw({ key: null, path: `/mcp?key=${memberKey}`, body: listBody })).status, 401);
  });

  test('the Host header is checked on /mcp: a foreign host gets 403 even with a valid key', async () => {
    const foreign = await raw({ key: memberKey, host: 'evil.example', body: listBody });
    assert.equal(foreign.status, 403);
    assert.ok(!foreign.text.includes('shop__'));
    assert.equal((await raw({ key: memberKey, host: HOST, body: listBody })).status, 200, 'the allowed host without a port also works');
  });

  test('a body above the limit is refused with 413 before it is read', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shop__list_orders', arguments: { text: 'x'.repeat(MAX_BODY_BYTES) } } });
    assert.equal((await raw({ key: memberKey, body: big })).status, 413);
  });

  test('only the intended paths exist: OAuth discovery paths and other paths answer 404', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/register', '/mcp/other', '/']) {
      assert.equal((await raw({ method: 'GET', path, key: memberKey })).status, 404, path);
    }
  });

  test('GET and DELETE on /mcp are refused (stateless: no session, no stream) and still need a key', async () => {
    assert.equal((await raw({ method: 'GET', key: null })).status, 401);
    assert.equal((await raw({ method: 'GET', key: memberKey })).status, 405);
    assert.equal((await raw({ method: 'DELETE', key: memberKey })).status, 405);
  });

  test('revoking the member key blocks the next request, and the admin key still works', async () => {
    const client = await connect(memberKey);
    try {
      assert.equal((await client.listTools()).tools.length, 3, 'works before the revocation');
      assert.equal(await revokeApiKey(pool, memberKeyId), true);
      assert.equal((await raw({ key: memberKey, body: listBody })).status, 401, 'the very next request is refused');
      await assert.rejects(client.listTools(), 'the connected client is cut off on its next call');
    } finally {
      await client.close().catch(() => {});
    }
    assert.equal((await raw({ key: adminKey, body: listBody })).status, 200);
    assert.ok((await listApiKeys(pool, 'member@example.com')).every((key) => key.revokedAt !== null));
  });

  test('disabling an upstream: a new connection lists none of its tools, and a call from a stale list is "Unknown tool"', async () => {
    const stale = await connect(adminKey);
    try {
      assert.ok((await stale.listTools()).tools.some((entry) => entry.name === 'shop__list_orders'));
      const target = (await getServerBySlug(pool, 'shop'))!;
      const callsBefore = shop.toolCalls();
      await patchServer(pool, keyring, target.id, { enabled: false });

      const fresh = await connect(adminKey);
      try {
        const names = (await fresh.listTools()).tools.map((entry) => entry.name);
        assert.deepEqual(names, ['other__ping']);
      } finally {
        await fresh.close();
      }

      const result = await stale.callTool({ name: 'shop__list_orders', arguments: {} });
      received.push(JSON.stringify(result));
      assert.equal(result.isError, true);
      assert.equal(textOf(result), 'Unknown tool');
      assert.equal(shop.toolCalls(), callsBefore, 'the disabled upstream received no call');
      const last = (await auditRows()).at(-1)!;
      assert.deepEqual([last.requested_name, last.outcome, last.via, last.user_email], ['shop__list_orders', 'unknown_tool', 'mcp', 'admin@example.com']);

      await patchServer(pool, keyring, target.id, { enabled: true });
      await poller.refreshNow();
      const again = await connect(adminKey);
      try {
        assert.ok((await again.listTools()).tools.some((entry) => entry.name === 'shop__list_orders'));
      } finally {
        await again.close();
      }
    } finally {
      await stale.close();
    }
  });

  test('leak scan: no key and no upstream credential in any response or log line; the scan itself finds a planted secret', () => {
    const secrets = [UPSTREAM_TOKEN, adminKey, memberKey];
    const all = [...received, ...logLines];
    assert.ok(all.length > 20, 'there is something to scan');
    assert.deepEqual(findLeaks(all, secrets), []);
    // Control: the same scan must find a secret that is really there.
    assert.deepEqual(findLeaks([...all, `Authorization: Bearer ${UPSTREAM_TOKEN}`], secrets), [UPSTREAM_TOKEN]);
  });
});
