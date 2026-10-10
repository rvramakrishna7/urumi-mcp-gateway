import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';
import type { ToolDeps } from '../src/tools/common.ts';
import { WooApiError } from '../src/wooClient.ts';

const TOKEN = randomBytes(24).toString('hex');
const config = { allowedHosts: ['localhost', '127.0.0.1'], mcpAuthToken: TOKEN };

// What the stub answers is set per test. The stub records the calls that reach it.
let nextAnswer: () => unknown = () => ({ status: 200, data: [], total: 0, totalPages: 0 });
const wooCalls: Array<{ method: string; path: string }> = [];
const logLines: string[] = [];
const deps: ToolDeps = {
  woo: {
    request: (async (method: string, request: { path: string }) => {
      wooCalls.push({ method, path: request.path });
      return nextAnswer();
    }) as ToolDeps['woo']['request'],
  },
  storeTimezone: 'Asia/Kolkata',
  now: () => new Date('2026-10-10T05:00:00Z'),
};

let server: Server;
let base: string;

async function rpc(method: string, params: unknown, id = 1): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
  assert.ok(line, `no data line in: ${text}`);
  return JSON.parse(line.slice('data: '.length));
}

const callTool = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args });

describe('tools over MCP', () => {
  before(async () => {
    const { app } = createApp(config, createLogger((line) => logLines.push(line)), deps);
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
  });

  test('tools/list returns the tools with strict input schemas and annotations', async () => {
    const { result } = await rpc('tools/list', {});
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    }
    const listProducts = result.tools.find((tool: { name: string }) => tool.name === 'list_products');
    // A field with a default is not required.
    assert.deepEqual(listProducts.inputSchema.required ?? [], []);
    assert.equal(listProducts.inputSchema.properties.per_page.maximum, 50);
  });

  test('tools/call runs a tool and returns JSON text', async () => {
    wooCalls.length = 0;
    nextAnswer = () => ({
      status: 200,
      data: [{ id: 5, name: 'Test Mug', sku: '', price: '12.00', status: 'publish', stock_status: 'instock', stock_quantity: null, permalink: 'http://store.urumi.test/p/' }],
      total: 1,
      totalPages: 1,
    });
    const { result } = await callTool('list_products', { per_page: 5 });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).products[0].name, 'Test Mug');
    assert.deepEqual(wooCalls, [{ method: 'GET', path: '/wp-json/wc/v3/products' }]);
  });

  test('an unknown argument is rejected before the tool runs', async () => {
    wooCalls.length = 0;
    const message = await callTool('list_products', { per_page: 5, sneaky: true });
    assert.ok(message.error || message.result?.isError, JSON.stringify(message));
    assert.equal(wooCalls.length, 0);
  });

  test('an argument out of range is rejected before the tool runs', async () => {
    wooCalls.length = 0;
    const message = await callTool('list_products', { per_page: 500 });
    assert.ok(message.error || message.result?.isError, JSON.stringify(message));
    assert.equal(wooCalls.length, 0);
  });

  test('a store that is down comes back as a tool result with isError, not as a JSON-RPC error', async () => {
    nextAnswer = () => {
      throw new WooApiError('network', 'could not reach WooCommerce (ECONNREFUSED)');
    };
    const message = await callTool('list_orders', {});
    assert.equal(message.error, undefined);
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /cannot be reached/);
  });

  test('a slow store comes back as a tool result with isError', async () => {
    nextAnswer = () => {
      throw new WooApiError('timeout', 'WooCommerce did not answer within 10000 ms');
    };
    const message = await callTool('get_order', { id: 13 });
    assert.equal(message.error, undefined);
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /did not answer in time/);
  });

  test('the log has tool, duration and outcome for each call and no arguments', async () => {
    const toolLines = logLines.filter((line) => JSON.parse(line).message === 'tool call').map((line) => JSON.parse(line));
    assert.ok(toolLines.length >= 3);
    for (const line of toolLines) {
      assert.ok(['ok', 'error'].includes(line.outcome));
      assert.equal(typeof line.durationMs, 'number');
      assert.ok(!('args' in line) && !('arguments' in line));
    }
  });
});
