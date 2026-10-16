import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { FxApiError } from '../src/fxClient.ts';
import { createLogger } from '../src/logger.ts';
import type { ToolDeps } from '../src/tools/common.ts';

const TOKEN = randomBytes(24).toString('hex');
const config = { allowedHosts: ['localhost', '127.0.0.1'], mcpAuthToken: TOKEN };

// What the fake rate service answers is set per test. It records the pairs that were asked.
let table: Record<string, number> = { 'INR/EUR': 0.00939, 'EUR/INR': 106.45 };
let failure: FxApiError | null = null;
const asked: string[] = [];
const logLines: string[] = [];
const deps: ToolDeps = {
  fx: {
    getRate: async (base, quote, date) => {
      asked.push(`${base}/${quote}${date ? `@${date}` : ''}`);
      if (failure) throw failure;
      const rate = table[`${base}/${quote}`];
      if (rate === undefined) throw new FxApiError('not-found', 'x', 404);
      return { date: date ?? '2026-10-16', base, quote, rate };
    },
    listCurrencies: async () => [{ code: 'EUR', name: 'Euro' }, { code: 'INR', name: 'Indian Rupee' }],
  },
  now: () => new Date('2026-10-16T10:00:00Z'),
};

let server: Server;
let base: string;

async function rpc(method: string, params: unknown, id = 1): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
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

  test('tools/list returns strict schemas, read-only annotations and the documented limits', async () => {
    const { result } = await rpc('tools/list', {});
    assert.equal(result.tools.length, 3);
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    }
    const convert = result.tools.find((tool: { name: string }) => tool.name === 'convert_amounts');
    assert.deepEqual([...convert.inputSchema.required].sort(), ['amounts', 'from', 'to']);
    assert.equal(convert.inputSchema.properties.amounts.maxItems, 100);
    assert.equal(convert.inputSchema.properties.amounts.minItems, 1);
  });

  test('convert_amounts over MCP returns JSON text with the inverse-pair total', async () => {
    asked.length = 0;
    const { result } = await callTool('convert_amounts', { from: 'INR', to: 'EUR', amounts: ['150000.00', 100000] });
    assert.equal(result.isError, undefined);
    const answer = JSON.parse(result.content[0].text);
    assert.equal(answer.total.converted, '2348.52');
    assert.equal(answer.basis, 'inverse pair');
    assert.deepEqual(asked, ['INR/EUR', 'EUR/INR@2026-10-16']);
  });

  test('a lower case code is accepted over MCP too', async () => {
    const { result } = await callTool('get_rate', { from: 'eur', to: 'inr' });
    assert.equal(JSON.parse(result.content[0].text).rate, '106.45');
  });

  test('an unknown argument, a bad code and a too long list are rejected before the tool runs', async () => {
    asked.length = 0;
    const bad: unknown[] = [
      { from: 'INR', to: 'EUR', amounts: ['1'], url: 'http://evil.example' },
      { from: 'INR', to: 'E/R', amounts: ['1'] },
      { from: 'INR', to: 'EUR', amounts: Array.from({ length: 101 }, () => '1') },
      { from: 'INR', to: 'EUR', amounts: [] },
    ];
    for (const args of bad) {
      const message = await callTool('convert_amounts', args);
      assert.ok(message.error || message.result?.isError, JSON.stringify(message).slice(0, 200));
    }
    assert.equal(asked.length, 0);
  });

  test('a bad amount comes back as a tool result with isError and names its position', async () => {
    const message = await callTool('convert_amounts', { from: 'INR', to: 'EUR', amounts: ['10', '1.234'] });
    assert.equal(message.error, undefined);
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /amounts\[1\]/);
  });

  test('a rate service that is down comes back as a tool result with isError, not as a JSON-RPC error', async () => {
    failure = new FxApiError('network', 'could not reach the rate service (ECONNREFUSED)');
    try {
      const message = await callTool('get_rate', { from: 'EUR', to: 'INR' });
      assert.equal(message.error, undefined);
      assert.equal(message.result.isError, true);
      assert.match(message.result.content[0].text, /cannot be reached/);
    } finally {
      failure = null;
    }
  });

  test('a slow rate service comes back as a tool result with isError', async () => {
    failure = new FxApiError('timeout', 'The rate service did not answer within 8000 ms');
    try {
      const message = await callTool('convert_amounts', { from: 'INR', to: 'EUR', amounts: ['1'] });
      assert.equal(message.error, undefined);
      assert.equal(message.result.isError, true);
      assert.match(message.result.content[0].text, /did not answer in time/);
    } finally {
      failure = null;
    }
  });

  test('the log has tool, duration and outcome for each call and no arguments', async () => {
    const toolLines = logLines.filter((line) => JSON.parse(line).message === 'tool call').map((line) => JSON.parse(line));
    assert.ok(toolLines.length >= 3);
    for (const line of toolLines) {
      assert.ok(['ok', 'error'].includes(line.outcome));
      assert.equal(typeof line.durationMs, 'number');
      assert.ok(!('args' in line) && !('arguments' in line));
    }
    const joined = logLines.join('\n');
    assert.ok(!joined.includes(TOKEN), 'the token was logged');
    assert.ok(!joined.includes('150000'), 'an amount was logged');
    assert.ok(!joined.includes('evil.example'), 'an argument was logged');
  });
});
