import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGroqClient, GroqError } from '../src/chat/groq.ts';
import type { GroqTool } from '../src/chat/groq.ts';
import type { GroqErrorKind } from '../src/chat/groq.ts';

const KEY = 'gsk_test_canary_0123456789abcdef0123456789abcdef';
const BODY_MARKER = 'UPSTREAM-BODY-MARKER-9c1e4a7b';
const TOOLS: GroqTool[] = [{ type: 'function', function: { name: 'woo__list_orders', description: 'd', parameters: { type: 'object', properties: {} } } }];
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'x',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  ...extra,
});

interface Seen {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function client(respond: (seen: Seen) => Response | Promise<Response>, model = 'openai/gpt-oss-120b', extra: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const entry = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    seen.push(entry);
    return respond(entry);
  }) as unknown as typeof fetch;
  return { groq: createGroqClient({ apiKey: KEY, model, fetchImpl, ...extra }), seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('the Groq client against a fake fetch (no network)', () => {
  test('the request: URL, method, key in the Authorization header only, and the body fields of the decision', async () => {
    const { groq, seen } = client(() => json(completion({ content: 'hello' })));
    await groq.complete(MESSAGES, TOOLS);
    const request = seen[0]!;
    assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(request.init.method, 'POST');
    assert.equal((request.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
    assert.equal(request.init.redirect, 'error');
    assert.deepEqual(request.body, {
      model: 'openai/gpt-oss-120b',
      messages: MESSAGES,
      tools: TOOLS,
      tool_choice: 'auto',
      max_completion_tokens: 1024,
      reasoning_effort: 'low',
      include_reasoning: false,
    });
    assert.equal(JSON.stringify(request.body).includes(KEY), false, 'the key is not in the body');
    assert.equal('parallel_tool_calls' in request.body, false, 'parallel_tool_calls is not sent');
    for (const unsupported of ['n', 'logprobs', 'logit_bias', 'top_logprobs']) assert.equal(unsupported in request.body, false, unsupported);
  });

  test('another model gets no reasoning fields, and a request without tools has no tool_choice', async () => {
    const { groq, seen } = client(() => json(completion({ content: 'hello' })), 'llama-3.3-70b-versatile');
    await groq.complete(MESSAGES, []);
    assert.equal('reasoning_effort' in seen[0]!.body, false);
    assert.equal('include_reasoning' in seen[0]!.body, false);
    assert.equal('tools' in seen[0]!.body, false);
    assert.equal('tool_choice' in seen[0]!.body, false);
  });

  test('a text answer, a tool call answer, and the usage', async () => {
    const text = await client(() => json(completion({ content: 'hello' }))).groq.complete(MESSAGES, TOOLS);
    assert.deepEqual(text, { message: { content: 'hello', tool_calls: [] }, finishReason: 'stop', totalTokens: 10 });

    const calls = await client(() =>
      json(completion({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'woo__list_orders', arguments: '{"a":1}' } }] })),
    ).groq.complete(MESSAGES, TOOLS);
    assert.deepEqual(calls.message, { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'woo__list_orders', arguments: '{"a":1}' } }] });
  });

  test('the reasoning of the model and unknown fields are dropped', async () => {
    const result = await client(() => json(completion({ content: 'hello', reasoning: 'secret thoughts', extra: 1 }, { x_groq: { id: 'q' } }))).groq.complete(MESSAGES, TOOLS);
    assert.equal(JSON.stringify(result).includes('secret thoughts'), false);
    assert.deepEqual(Object.keys(result.message).sort(), ['content', 'tool_calls']);
  });

  const kindOf = async (respond: (seen: Seen) => Response | Promise<Response>, extra: { maxResponseBytes?: number; timeoutMs?: number } = {}) => {
    try {
      await client(respond, 'openai/gpt-oss-120b', extra).groq.complete(MESSAGES, TOOLS);
    } catch (error) {
      assert.ok(error instanceof GroqError, String(error));
      return error;
    }
    assert.fail('expected a GroqError');
  };

  test('the status codes map to kinds, and 429 carries a usable retry-after', async () => {
    const table: [number, GroqErrorKind][] = [[401, 'auth'], [403, 'auth'], [400, 'bad_request'], [404, 'bad_request'], [413, 'bad_request'], [429, 'rate_limited'], [500, 'unavailable'], [502, 'unavailable'], [503, 'unavailable'], [204, 'bad_request'], [302, 'bad_request']];
    for (const [status, kind] of table) {
      assert.equal((await kindOf(() => new Response(status === 204 ? null : `{"error":"${BODY_MARKER}"}`, { status }))).kind, kind, String(status));
    }
    const limited = await kindOf(() => json({ error: BODY_MARKER }, 429, { 'retry-after': '7' }));
    assert.equal(limited.retryAfterSeconds, 7);
    for (const header of ['', 'abc', '-3', '0', '1e3', '99999999', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      assert.equal((await kindOf(() => json({}, 429, header === '' ? {} : { 'retry-after': header }))).retryAfterSeconds, null, header);
    }
  });

  test('answers that are not what the loop relies on are invalid_response', async () => {
    const bad: unknown[] = [
      'not json',
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: 'text' }] },
      { choices: [{ message: { content: 5 } }] },
      { choices: [{ message: { content: 'x', tool_calls: 'no' } }] },
      { choices: [{ message: { content: null, tool_calls: [null] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'function' }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: '', type: 'function', function: { name: 'n', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: '', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'n', arguments: {} } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'n', arguments: 'x'.repeat(20_001) } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'retrieval', function: { name: 'n', arguments: '{}' } }] } }] },
    ];
    for (const body of bad) {
      const error = await kindOf(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }));
      assert.equal(error.kind, 'invalid_response', JSON.stringify(body).slice(0, 80));
    }
  });

  test('an answer over the cap is too_large, by its length header and by its stream', async () => {
    assert.equal((await kindOf(() => json(completion({ content: 'x'.repeat(5000) })), { maxResponseBytes: 1000 })).kind, 'too_large');
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(800)));
          controller.enqueue(new TextEncoder().encode('x'.repeat(800)));
          controller.close();
        },
      }),
      { status: 200 },
    );
    assert.equal((await kindOf(() => streamed, { maxResponseBytes: 1000 })).kind, 'too_large');
  });

  test('a network error is unavailable, and a request that does not end is a timeout', async () => {
    assert.equal(
      (
        await kindOf(() => {
          throw new TypeError(`fetch failed ${BODY_MARKER}`);
        })
      ).kind,
      'unavailable',
    );
    const never = (seen: Seen) =>
      new Promise<Response>((_resolve, reject) => {
        (seen.init.signal as AbortSignal).addEventListener('abort', () => reject((seen.init.signal as AbortSignal).reason));
      });
    const started = Date.now();
    assert.equal((await kindOf(never, { timeoutMs: 150 })).kind, 'timeout');
    assert.ok(Date.now() - started < 3000);
  });

  test('a per-call timeout overrides the default', async () => {
    const never = (seen: Seen) =>
      new Promise<Response>((_resolve, reject) => {
        (seen.init.signal as AbortSignal).addEventListener('abort', () => reject((seen.init.signal as AbortSignal).reason));
      });
    const { groq } = client(never, 'openai/gpt-oss-120b', { timeoutMs: 60_000 });
    const started = Date.now();
    await assert.rejects(groq.complete(MESSAGES, TOOLS, 120), (error: unknown) => error instanceof GroqError && error.kind === 'timeout');
    assert.ok(Date.now() - started < 3000);
  });

  test('leak scan: no error, text or JSON of an error holds the key or anything from the answer, and the scan finds a planted control', async () => {
    const texts: string[] = [];
    const responders: (() => Response | Promise<Response>)[] = [
      () => json({ error: { message: `${BODY_MARKER} ${KEY}` } }, 401),
      () => json({ error: BODY_MARKER }, 429, { 'retry-after': '3', 'x-secret': BODY_MARKER }),
      () => new Response(`${BODY_MARKER} ${KEY}`, { status: 500 }),
      () => new Response(`{"choices":[${BODY_MARKER}`, { status: 200 }),
      () => {
        throw new TypeError(`connect ECONNREFUSED ${BODY_MARKER} ${KEY}`);
      },
    ];
    assert.ok(responders.length >= 5, 'the scan loaded all its cases');
    for (const respond of responders) {
      const error = await kindOf(respond);
      texts.push(error.message, String(error), JSON.stringify(error), error.stack ?? '');
    }
    assert.ok(texts.length >= 20);
    const all = texts.join('\n');
    assert.equal(all.includes(KEY), false);
    assert.equal(all.includes(BODY_MARKER), false);
    assert.equal(`${all}\n${KEY}`.includes(KEY), true, 'planted control');
  });
});

describe('the Groq client against a real local HTTP server', () => {
  let server: Server;
  let base: string;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let mode: 'ok' | 'redirect' | 'slow-body' = 'ok';
  let redirectTargetHits = 0;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/target') {
        redirectTargetHits += 1;
        res.writeHead(200).end('{}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (mode === 'redirect') {
          res.writeHead(307, { location: '/target' }).end();
        } else if (mode === 'slow-body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"choices":[');
          // The headers are out and the body never ends: the timeout must cover the body too.
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completion({ content: 'from the server' })));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a real request carries the bearer key and a JSON body, and the answer is read', async () => {
    mode = 'ok';
    const groq = createGroqClient({ apiKey: KEY, model: 'openai/gpt-oss-120b', baseUrl: `${base}/openai/v1` });
    const result = await groq.complete(MESSAGES, TOOLS);
    assert.equal(result.message.content, 'from the server');
    const last = received.at(-1)!;
    assert.equal(last.headers.authorization, `Bearer ${KEY}`);
    assert.equal(last.headers['content-type'], 'application/json');
    assert.equal(last.body.includes(KEY), false);
  });

  test('a redirect is not followed: the key is not sent to another address', async () => {
    mode = 'redirect';
    const groq = createGroqClient({ apiKey: KEY, model: 'openai/gpt-oss-120b', baseUrl: `${base}/openai/v1` });
    await assert.rejects(groq.complete(MESSAGES, TOOLS), (error: unknown) => error instanceof GroqError && error.kind === 'unavailable');
    assert.equal(redirectTargetHits, 0);
  });

  test('a body that never ends is cut by the timeout', async () => {
    mode = 'slow-body';
    const groq = createGroqClient({ apiKey: KEY, model: 'openai/gpt-oss-120b', baseUrl: `${base}/openai/v1`, timeoutMs: 300 });
    const started = Date.now();
    await assert.rejects(groq.complete(MESSAGES, TOOLS), (error: unknown) => error instanceof GroqError && error.kind === 'timeout');
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  });
});
