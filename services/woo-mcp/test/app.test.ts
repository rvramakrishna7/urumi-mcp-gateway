import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

const TOKEN = randomBytes(24).toString('hex');
const WRONG_TOKEN = randomBytes(24).toString('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const logLines: string[] = [];
const config = { allowedHosts: ['localhost', '127.0.0.1', 'woo-mcp.mcp-servers.svc.cluster.local'], mcpAuthToken: TOKEN };

let server: Server;
let base: string;
let port: number;

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

// fetch does not let a test choose the Host header, so Host checks use the plain http client.
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function mcpPost(body: unknown, authorization: string | null = `Bearer ${TOKEN}`): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization === null ? {} : { authorization }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// The transport answers with a server-sent event; the JSON-RPC message is on the "data:" line.
async function rpc(response: Response): Promise<any> {
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
  assert.ok(line, `no data line in: ${text}`);
  return JSON.parse(line.slice('data: '.length));
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describe('woo-mcp app', () => {
  before(async () => {
    const { app } = createApp(config, createLogger((line) => logLines.push(line)));
    server = await listen(app);
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await close(server);
  });

  describe('health routes', () => {
    test('/healthz answers 200 without a token and carries a request id', async () => {
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
      assert.match(response.headers.get('x-request-id') ?? '', UUID);
    });

    test('/readyz answers 200 without a token', async () => {
      const response = await fetch(`${base}/readyz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready' });
    });

    test('/readyz answers 503 after beginShutdown, /healthz still answers 200', async () => {
      const second = createApp(config, createLogger(() => {}));
      const instance = await listen(second.app);
      const secondBase = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
      try {
        second.beginShutdown();
        assert.equal((await fetch(`${secondBase}/readyz`)).status, 503);
        assert.equal((await fetch(`${secondBase}/healthz`)).status, 200);
      } finally {
        await close(instance);
      }
    });

    test('health routes ignore the Host header (the kubelet probes the pod IP)', async () => {
      const response = await rawGet('/healthz', { Host: '10.42.0.17:8080' });
      assert.equal(response.status, 200);
    });
  });

  describe('authentication on /mcp', () => {
    test('rejects a request without a token', async () => {
      const response = await mcpPost(initialize, null);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    });

    test('rejects a wrong token, a wrong scheme and an empty token', async () => {
      assert.equal((await mcpPost(initialize, `Bearer ${WRONG_TOKEN}`)).status, 401);
      assert.equal((await mcpPost(initialize, `Basic ${TOKEN}`)).status, 401);
      assert.equal((await mcpPost(initialize, 'Bearer ')).status, 401);
      assert.equal((await mcpPost(initialize, 'Bearer x')).status, 401);
    });

    test('does not read the body of an unauthenticated request', async () => {
      const response = await mcpPost('{ this is not json', null);
      assert.equal(response.status, 401);
    });

    test('accepts the right token and a lower case scheme', async () => {
      assert.equal((await mcpPost(initialize, `Bearer ${TOKEN}`)).status, 200);
      assert.equal((await mcpPost(initialize, `bearer ${TOKEN}`)).status, 200);
    });

    test('rejects a Host header that is not allowed, even with the right token', async () => {
      const response = await rawGet('/mcp', { Host: 'evil.example.com', Authorization: `Bearer ${TOKEN}` });
      assert.equal(response.status, 403);
    });

    test('accepts the in-cluster host name with a port', async () => {
      const response = await rawGet('/mcp', {
        Host: 'woo-mcp.mcp-servers.svc.cluster.local:80',
        Authorization: `Bearer ${TOKEN}`,
      });
      // GET is not allowed on /mcp, so reaching the 405 proves that the Host check passed.
      assert.equal(response.status, 405);
    });
  });

  describe('MCP endpoint', () => {
    test('initialize returns the server info and declares a static tools capability', async () => {
      const message = await rpc(await mcpPost(initialize));
      assert.equal(message.result.serverInfo.name, 'woo-mcp');
      assert.deepEqual(message.result.capabilities.tools, { listChanged: false });
    });

    test('tools/list works without a session and returns an empty list', async () => {
      const message = await rpc(await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      assert.deepEqual(message.result.tools, []);
    });

    test('an unknown tool is reported as an error', async () => {
      const message = await rpc(
        await mcpPost({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }),
      );
      assert.ok(message.error || message.result?.isError);
    });

    test('GET and DELETE are not allowed on a stateless server', async () => {
      for (const method of ['GET', 'DELETE']) {
        const response = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'POST');
      }
    });

    test('a GET without a token is rejected before the method check', async () => {
      assert.equal((await fetch(`${base}/mcp`)).status, 401);
    });

    test('malformed JSON gets a short JSON error without a stack trace', async () => {
      const response = await mcpPost('{ this is not json');
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { error: 'bad request' });
      assert.ok(!text.includes(' at '));
    });

    test('a body above 100 kb is rejected with 413', async () => {
      const response = await mcpPost({ jsonrpc: '2.0', id: 4, method: 'tools/list', padding: 'x'.repeat(200_000) });
      assert.equal(response.status, 413);
    });

    test('an unknown route gets a JSON 404', async () => {
      const response = await fetch(`${base}/nope`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'not found' });
    });
  });

  describe('logging', () => {
    test('logs the path without the query string', async () => {
      await fetch(`${base}/healthz?marker=query-string-value`);
      const joined = logLines.join('\n');
      assert.ok(joined.includes('"path":"/healthz"'));
      assert.ok(!joined.includes('query-string-value'));
    });

    test('logs the full path of an /mcp request, not the path inside the router', async () => {
      await mcpPost({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
      const entries = logLines.map((line) => JSON.parse(line));
      assert.ok(entries.some((entry) => entry.method === 'POST' && entry.path === '/mcp' && entry.status === 200));
      assert.ok(!entries.some((entry) => entry.path === '/'));
    });

    test('never logs a token, an Authorization header or a request body', () => {
      const joined = logLines.join('\n');
      assert.ok(logLines.length > 0);
      assert.ok(!joined.includes(TOKEN), 'the valid token was logged');
      assert.ok(!joined.includes(WRONG_TOKEN), 'a presented token was logged');
      assert.ok(!/bearer/i.test(joined), 'an Authorization header was logged');
      assert.ok(!joined.includes('this is not json'), 'a request body was logged');
    });
  });
});
