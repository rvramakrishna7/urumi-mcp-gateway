import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, sendChat } from '../src/api/client';
import type { ApiErrorKind, ApiErrorReason } from '../src/api/client';

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function stubFetch(respond: (init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => respond(init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('sendChat: the request', () => {
  test('posts the messages to /api/chat as JSON, with the cookie and no confirm key unless there is one', async () => {
    const mock = stubFetch(() => answer(200, { reply: 'x', toolCalls: [] }));
    await sendChat(MESSAGES);
    const [path, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/chat');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ messages: MESSAGES });
  });

  test('a confirm object goes along unchanged', async () => {
    const mock = stubFetch(() => answer(200, { reply: 'x', toolCalls: [] }));
    const confirm = { token: 't', name: 'woo__create_product', args: { name: 'Mug' } };
    await sendChat(MESSAGES, confirm);
    expect(JSON.parse(String((mock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ messages: MESSAGES, confirm });
  });
});

describe('sendChat: the answer is checked, not trusted', () => {
  test('a good answer with and without a pending call', async () => {
    stubFetch(() => answer(200, { reply: 'r', toolCalls: [{ name: 'a', ok: true, durationMs: 1.5 }] }));
    expect(await sendChat(MESSAGES)).toEqual({ reply: 'r', toolCalls: [{ name: 'a', ok: true, durationMs: 1.5 }], pending: null });
    const pending = { token: 't', name: 'woo__create_product', args: { a: 1 } };
    stubFetch(() => answer(200, { reply: '', toolCalls: [], pending }));
    expect((await sendChat(MESSAGES)).pending).toEqual(pending);
  });

  const bad: Array<[string, unknown]> = [
    ['no reply', { toolCalls: [] }],
    ['reply is not text', { reply: 1, toolCalls: [] }],
    ['toolCalls is not a list', { reply: 'r', toolCalls: 'x' }],
    ['a tool call without ok', { reply: 'r', toolCalls: [{ name: 'a', durationMs: 1 }] }],
    ['pending without a token', { reply: 'r', toolCalls: [], pending: { name: 'a', args: {} } }],
    ['pending args are a list', { reply: 'r', toolCalls: [], pending: { token: 't', name: 'a', args: [] } }],
    ['pending is a string', { reply: 'r', toolCalls: [], pending: 'yes' }],
  ];
  test.each(bad)('%s is a server error', async (_name, body) => {
    stubFetch(() => answer(200, body));
    expect((await failure(sendChat(MESSAGES))).kind).toBe('server');
  });
});

describe('ApiError.reason: only markers on the list become a reason', () => {
  const cases: Array<[number, string, ApiErrorKind, ApiErrorReason]> = [
    [503, 'chat not configured', 'server', 'not_configured'],
    [503, 'service unavailable', 'server', 'service_unavailable'],
    [400, 'invalid request', 'invalid', 'invalid_request'],
    [400, 'invalid confirmation', 'invalid', 'invalid_confirmation'],
    [429, 'too many requests', 'throttled', 'rate_limited'],
    [429, 'model rate limited', 'throttled', 'model_rate_limited'],
    [504, 'model timeout', 'server', 'model_timeout'],
    [502, 'model rejected the request', 'server', 'model_rejected'],
    [502, 'model unavailable', 'server', 'model_unavailable'],
    [500, 'internal error', 'server', 'internal'],
  ];

  test.each(cases)('%i %s is %s with the reason %s', async (status, marker, kind, reason) => {
    stubFetch(() => answer(status, { error: marker }));
    const error = await failure(sendChat(MESSAGES));
    expect(error.kind).toBe(kind);
    expect(error.reason).toBe(reason);
  });

  test('429 keeps the Retry-After next to the reason', async () => {
    stubFetch(() => answer(429, { error: 'too many requests' }, { 'Retry-After': '17' }));
    const error = await failure(sendChat(MESSAGES));
    expect([error.reason, error.retryAfterSeconds]).toEqual(['rate_limited', 17]);
  });

  const unlisted: Array<[string, number, string]> = [
    ['an unknown marker', 502, 'something else entirely'],
    ['a marker that is a property of Object', 500, 'constructor'],
    ['a marker that is __proto__', 500, '__proto__'],
    ['a marker with the right words and more', 502, 'model unavailable: key gsk_x'],
    ['a different case', 502, 'Model Unavailable'],
  ];
  test.each(unlisted)('%s has no reason', async (_name, status, marker) => {
    stubFetch(() => answer(status, { error: marker }));
    expect((await failure(sendChat(MESSAGES))).reason).toBeNull();
  });

  test.each([
    ['not JSON', '<html>bad gateway</html>'],
    ['an array', '[]'],
    ['a number marker', '{"error": 5}'],
    ['no marker', '{"message": "model unavailable"}'],
  ])('a body that is %s has no reason and no crash', async (_name, body) => {
    stubFetch(() => answer(502, body));
    const error = await failure(sendChat(MESSAGES));
    expect(error.kind).toBe('server');
    expect(error.reason).toBeNull();
  });

  test('the text of the answer is not kept anywhere on the error', async () => {
    stubFetch(() => answer(502, { error: 'model unavailable', detail: 'LEAK-gsk_secret' }));
    const error = await failure(sendChat(MESSAGES));
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('LEAK-gsk_secret');
    expect(error.message).toBe('server');
  });

  test('the weak password marker of accept-invite still works next to the new reasons', async () => {
    stubFetch(() => answer(400, { error: 'weak password' }));
    const error = await failure(sendChat(MESSAGES));
    expect([error.kind, error.reason]).toEqual(['weak', null]);
  });
});
