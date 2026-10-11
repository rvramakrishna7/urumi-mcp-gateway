import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { callUpstreamTool, listUpstreamTools, UpstreamError } from '../src/upstream/client.ts';
import type { UpstreamLimits, UpstreamTarget } from '../src/upstream/client.ts';
import { startFake } from './helpers/fake-upstream.ts';
import type { Fake } from './helpers/fake-upstream.ts';
import { containsPort } from './helpers/port-needle.ts';

const TOKEN = 'canary-bearer-token-71c2a9d4e8f0b365';
const HEADER_VALUE = 'canary-header-value-4b8e1d7a9c2f6035';
const schema = { type: 'object', properties: {} };
const tools = [{ name: 'ping', description: 'Ping', inputSchema: schema }];

// Short limits keep the failure tests fast. The defaults (3 s, 5 s, 2 MB) are checked where the code defines them.
const limits: UpstreamLimits = { connectTimeoutMs: 400, listTimeoutMs: 400, maxResponseBytes: 64 * 1024 };
const bearer = (url: string, value = TOKEN): UpstreamTarget => ({ url, credential: { kind: 'bearer', header: null, value } });

async function failureOf(work: Promise<unknown>): Promise<UpstreamError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof UpstreamError, `an UpstreamError was expected, got ${error instanceof Error ? error.name : typeof error}`);
    return error;
  }
  assert.fail('the call was expected to fail');
}

describe('upstream client: one connection per call, against fake upstreams', () => {
  const fakes: Fake[] = [];
  const fake = async (options: Parameters<typeof startFake>[0]) => {
    const instance = await startFake(options);
    fakes.push(instance);
    return instance;
  };
  after(async () => {
    await Promise.all(fakes.map((entry) => entry.stop().catch(() => {})));
  });

  test('lists tools and calls one, with the bearer credential on every request', async () => {
    const upstream = await fake({ tools, token: TOKEN });
    const listed = await listUpstreamTools(bearer(upstream.url), limits);
    assert.deepEqual(listed.map((entry) => (entry as { name: string }).name), ['ping']);
    const result = await callUpstreamTool(bearer(upstream.url), 'ping', { a: 1 }, 2000, limits);
    assert.deepEqual(result.content, [{ type: 'text', text: 'ping done {"a":1}' }]);
    const authorized = upstream.requests.filter((entry) => entry.method === 'POST');
    assert.ok(authorized.length >= 4, 'two sessions of initialize, initialized and one more request each');
    assert.ok(authorized.every((entry) => entry.authorization === `Bearer ${TOKEN}`));
  });

  test('a custom header credential is sent as that header and not as Authorization', async () => {
    const upstream = await fake({ tools });
    const target: UpstreamTarget = { url: upstream.url, credential: { kind: 'header', header: 'X-Api-Key', value: HEADER_VALUE } };
    assert.equal((await listUpstreamTools(target, limits)).length, 1);
    const posts = upstream.requests.filter((entry) => entry.method === 'POST');
    assert.ok(posts.length > 0);
    assert.ok(posts.every((entry) => entry.headers['x-api-key'] === HEADER_VALUE && entry.authorization === null));
  });

  test('a wrong token is "unauthorized", and the error holds neither the URL nor the token', async () => {
    const upstream = await fake({ tools, token: TOKEN });
    const failure = await failureOf(listUpstreamTools(bearer(upstream.url, 'canary-wrong-token-0123456789abcdef'), limits));
    assert.equal(failure.kind, 'unauthorized');
    assert.equal(failure.stage, 'connect');
    for (const text of [failure.message, String(failure.stack), JSON.stringify(failure)]) {
      assert.ok(!text.includes(upstream.url) && !containsPort(text, upstream.port), 'no URL or port');
      assert.ok(!text.includes('canary'), 'no credential');
    }
  });

  test('a dead upstream (connection refused) fails fast and is called "refused"', async () => {
    const upstream = await fake({ tools });
    const url = upstream.url;
    await upstream.stop();
    const started = Date.now();
    const failure = await failureOf(listUpstreamTools(bearer(url), limits));
    assert.equal(failure.kind, 'refused');
    assert.ok(Date.now() - started < 300, 'a refused connection does not wait for the timeout');
  });

  test('a slow initialize ends at the connect timeout, whatever the upstream does', async () => {
    const upstream = await fake({ tools, initializeDelayMs: 3000 });
    const started = Date.now();
    const failure = await failureOf(listUpstreamTools(bearer(upstream.url), limits));
    const elapsed = Date.now() - started;
    assert.equal(failure.kind, 'timeout');
    assert.equal(failure.stage, 'connect');
    assert.ok(elapsed >= 350 && elapsed < 1500, `ended after ${elapsed} ms, expected about 400 ms`);
  });

  test('a slow tools/list ends at the list timeout', async () => {
    const upstream = await fake({ tools, listDelayMs: 3000 });
    const failure = await failureOf(listUpstreamTools(bearer(upstream.url), limits));
    assert.equal(failure.kind, 'timeout');
    assert.equal(failure.stage, 'list');
  });

  test('a slow tool call ends at the call timeout of the server, and it is a "call" failure', async () => {
    const upstream = await fake({ tools, callDelayMs: { ping: 3000 } });
    const started = Date.now();
    const failure = await failureOf(callUpstreamTool(bearer(upstream.url), 'ping', {}, 500, limits));
    assert.equal(failure.kind, 'timeout');
    assert.equal(failure.stage, 'call');
    assert.ok(Date.now() - started < 1500);
  });

  test('a response larger than the cap is refused, in the middle of the stream', async () => {
    const upstream = await fake({ tools, hugeTools: { ping: 3 * 1024 * 1024 } });
    const failure = await failureOf(callUpstreamTool(bearer(upstream.url), 'ping', {}, 5000, limits));
    assert.equal(failure.kind, 'too_large');
  });

  test('a redirect is not followed: the credential never reaches the other host', async () => {
    const elsewhere = await fake({ tools });
    const redirecting = await fake({ tools, redirectTo: elsewhere.url });
    const failure = await failureOf(listUpstreamTools(bearer(redirecting.url), limits));
    assert.ok(failure instanceof UpstreamError);
    assert.equal(elsewhere.requests.length, 0, 'the redirect target received no request');
  });

  test('a tool error of the upstream is returned as a result, not thrown', async () => {
    const upstream = await fake({ tools, failingTools: ['ping'], resultText: () => 'broken on purpose' });
    const result = await callUpstreamTool(bearer(upstream.url), 'ping', {}, 2000, limits);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: 'broken on purpose' }]);
  });

  test('each call opens its own connection: nothing is kept between calls', async () => {
    const upstream = await fake({ tools });
    await callUpstreamTool(bearer(upstream.url), 'ping', {}, 2000, limits);
    await callUpstreamTool(bearer(upstream.url), 'ping', {}, 2000, limits);
    assert.equal(upstream.requests.filter((entry) => entry.rpc === 'initialize').length, 2);
  });
});
