import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, acceptInvite, fetchSession, login, logout, request } from '../src/api/client';
import type { ApiErrorKind } from '../src/api/client';

// The mapping of the gateway's answers to typed kinds, tested on the client itself (the screens only show the messages that
// a kind leads to, so two kinds with the same message could not be told apart there).
afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: BodyInit | null = null, headers: Record<string, string> = {}): Response => new Response(body, { status, headers });

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

describe('api client: every status has its own kind', () => {
  const cases: Array<[number, ApiErrorKind]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'throttled'],
    [400, 'invalid'],
    [404, 'notfound'],
    [409, 'limit'],
    [418, 'server'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
  ];

  test.each(cases)('status %i is the kind %s', async (status, kind) => {
    stubFetch(() => answer(status, '{}'));
    expect((await failure(request('POST', '/api/x'))).kind).toBe(kind);
  });

  test('403 is its own kind: not the kind of a 500, and not the kind of a 401', async () => {
    stubFetch(() => answer(403, '{"error":"forbidden"}'));
    const forbidden = await failure(request('POST', '/api/x'));
    stubFetch(() => answer(500, '{"error":"internal error"}'));
    const broken = await failure(request('POST', '/api/x'));
    stubFetch(() => answer(401, '{"error":"unauthorized"}'));
    const unauthorized = await failure(request('POST', '/api/x'));
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.kind).not.toBe(broken.kind);
    expect(forbidden.kind).not.toBe(unauthorized.kind);
  });

  test('the error carries its kind only: no text of the answer is kept anywhere', async () => {
    stubFetch(() => answer(500, '{"error":"SECRET-INTERNAL-TEXT"}'));
    const error = await failure(request('POST', '/api/x'));
    expect(error.message).toBe('server');
    expect(JSON.stringify(Object.getOwnPropertyNames(error).map((name) => String(Reflect.get(error, name))))).not.toContain('SECRET-INTERNAL-TEXT');
  });

  test('a request that does not reach the gateway is "network"', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(request('GET', '/api/x'))).kind).toBe('network');
  });
});

describe('api client: Retry-After on a 429', () => {
  const retryAfter = async (header: string | null): Promise<number | null> => {
    stubFetch(() => answer(429, '{"error":"too many attempts"}', header === null ? {} : { 'Retry-After': header }));
    const error = await failure(request('POST', '/api/x'));
    expect(error.kind).toBe('throttled');
    return error.retryAfterSeconds;
  };

  test('a whole number of seconds is kept', async () => {
    expect(await retryAfter('1')).toBe(1);
    expect(await retryAfter('900')).toBe(900);
    expect(await retryAfter('9999999')).toBe(9_999_999);
  });

  test.each([
    ['missing', null],
    ['zero', '0'],
    ['negative', '-5'],
    ['8 digits', '12345678'],
    ['a decimal', '1.5'],
    ['a date (the other form of the header)', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['text', 'soon'],
    ['empty', ''],
  ])('%s is no usable wait (null, so the screen says "a few minutes")', async (_name, header) => {
    expect(await retryAfter(header)).toBeNull();
  });

  test('another status never carries a wait', async () => {
    stubFetch(() => answer(500, '{}', { 'Retry-After': '60' }));
    expect((await failure(request('POST', '/api/x'))).retryAfterSeconds).toBeNull();
  });
});

describe('api client: the two kinds of 400', () => {
  const kindOf400 = async (body: BodyInit | null): Promise<ApiErrorKind> => {
    stubFetch(() => answer(400, body));
    return (await failure(request('POST', '/api/x'))).kind;
  };

  test('the marker "weak password" is weak, with or without a reason (the reason is dropped)', async () => {
    expect(await kindOf400('{"error":"weak password"}')).toBe('weak');
    expect(await kindOf400('{"error":"weak password","reason":"SERVER-REASON"}')).toBe('weak');
  });

  test('any other 400 is invalid: another marker, an empty body, text that is not JSON, JSON that is not an object', async () => {
    expect(await kindOf400('{"error":"invalid or expired invite"}')).toBe('invalid');
    expect(await kindOf400('{"error":"something nobody planned"}')).toBe('invalid');
    expect(await kindOf400('{"error":123}')).toBe('invalid');
    expect(await kindOf400('{}')).toBe('invalid');
    expect(await kindOf400(null)).toBe('invalid');
    expect(await kindOf400('')).toBe('invalid');
    expect(await kindOf400('<html>Bad Request</html>')).toBe('invalid');
    expect(await kindOf400('null')).toBe('invalid');
    expect(await kindOf400('"weak password"')).toBe('invalid');
    expect(await kindOf400('[1,2]')).toBe('invalid');
  });

  test('the marker is read on a 400 only: a 500 with the same body is a server error', async () => {
    stubFetch(() => answer(500, '{"error":"weak password"}'));
    expect((await failure(request('POST', '/api/x'))).kind).toBe('server');
  });
});

describe('api client: an answer that is not what the contract says', () => {
  test('200 with a body that is not JSON is a server error', async () => {
    stubFetch(() => answer(200, '<html>an error page of a proxy</html>'));
    expect((await failure(request('GET', '/api/x'))).kind).toBe('server');
  });

  test('200 with an empty body is a server error (only a 204 may be empty)', async () => {
    stubFetch(() => answer(200, ''));
    expect((await failure(request('GET', '/api/x'))).kind).toBe('server');
  });

  test('204 is "no content", not an error', async () => {
    stubFetch(() => answer(204));
    expect(await request('POST', '/api/x')).toBeUndefined();
  });

  test('a user that is missing a field, or has a role that does not exist, is a server error', async () => {
    for (const user of [{ id: 'u', email: 'a@b.c' }, { id: 'u', email: 'a@b.c', role: 'owner' }, { id: 1, email: 'a@b.c', role: 'admin' }, null, 'x']) {
      stubFetch(() => answer(200, JSON.stringify({ user })));
      expect((await failure(login('a@b.c', 'password-long-enough'))).kind).toBe('server');
    }
    stubFetch(() => answer(200, '{}'));
    expect((await failure(login('a@b.c', 'password-long-enough'))).kind).toBe('server');
  });
});

describe('api client: the session probe', () => {
  const user = { id: 'u1', email: 'a@b.c', role: 'member' };

  test('a 401 is "nobody is signed in" (null); every other failure is an error and never null', async () => {
    stubFetch(() => answer(401, '{}'));
    expect(await fetchSession()).toBeNull();
    for (const [status, kind] of [[403, 'forbidden'], [500, 'server'], [503, 'server']] as const) {
      stubFetch(() => answer(status, '{}'));
      expect((await failure(fetchSession())).kind).toBe(kind);
    }
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(fetchSession())).kind).toBe('network');
  });

  test('200 gives the user', async () => {
    stubFetch(() => answer(200, JSON.stringify({ user, session: { expiresAt: 'x' } })));
    expect(await fetchSession()).toEqual(user);
  });
});

describe('api client: logout and accept-invite', () => {
  test('logout: 204 and 401 are both "the session is gone"; 403, 5xx and a network failure are errors', async () => {
    stubFetch(() => answer(204));
    await expect(logout()).resolves.toBeUndefined();
    stubFetch(() => answer(401, '{"error":"unauthorized"}'));
    await expect(logout()).resolves.toBeUndefined();
    for (const [status, kind] of [[403, 'forbidden'], [500, 'server'], [503, 'server']] as const) {
      stubFetch(() => answer(status, '{}'));
      expect((await failure(logout())).kind).toBe(kind);
    }
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(logout())).kind).toBe('network');
  });

  test('accept-invite: a network failure is "network", the two 400s are told apart, and the other statuses have their kinds', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(acceptInvite('tok', 'a long enough password'))).kind).toBe('network');
    const expected: Array<[number, string, ApiErrorKind]> = [
      [400, '{"error":"weak password","reason":"x"}', 'weak'],
      [400, '{"error":"invalid or expired invite"}', 'invalid'],
      [403, '{"error":"forbidden"}', 'forbidden'],
      [500, '{"error":"internal error"}', 'server'],
    ];
    for (const [status, body, kind] of expected) {
      stubFetch(() => answer(status, body));
      expect((await failure(acceptInvite('tok', 'a long enough password'))).kind).toBe(kind);
    }
  });
});

describe('api client: what is sent', () => {
  const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

  test('GET /api/auth/me: same-origin credentials, Accept only, no body and no Content-Type', async () => {
    const mock = stubFetch(() => answer(401, '{}'));
    await fetchSession();
    const [path, init] = mock.mock.calls[0] ?? [];
    expect(path).toBe('/api/auth/me');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init ?? {})).toEqual({ Accept: 'application/json' });
  });

  test('POST /api/auth/logout: same-origin credentials, Accept only, no body and no Content-Type', async () => {
    const mock = stubFetch(() => answer(204));
    await logout();
    const [path, init] = mock.mock.calls[0] ?? [];
    expect(path).toBe('/api/auth/logout');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init ?? {})).toEqual({ Accept: 'application/json' });
  });

  test('a call with a body has Content-Type JSON and exactly the fields it was given', async () => {
    const mock = stubFetch(() => answer(401, '{}'));
    await failure(login('a@b.c', 'secret-password-1'));
    await failure(acceptInvite('tok_1', 'secret-password-2'));
    const [loginCall, acceptCall] = mock.mock.calls;
    expect(loginCall?.[0]).toBe('/api/auth/login');
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({ email: 'a@b.c', password: 'secret-password-1' });
    expect(acceptCall?.[0]).toBe('/api/auth/accept-invite');
    expect(JSON.parse(String(acceptCall?.[1]?.body))).toEqual({ token: 'tok_1', password: 'secret-password-2' });
    for (const call of [loginCall, acceptCall]) {
      expect(headersOf(call?.[1] ?? {})).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
      expect(call?.[1]?.credentials).toBe('same-origin');
    }
  });
});
