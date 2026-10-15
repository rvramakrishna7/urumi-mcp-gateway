// The one place that talks to the gateway. The dashboard and the API share one origin (the Ingress host), so every call is a
// same-origin fetch: the browser sends the httpOnly session cookie and sets the Origin header by itself. Nothing here reads,
// stores or logs a cookie, a password or a token, and the text of an error body is never kept: only its kind is.
export type ApiErrorKind =
  | 'unauthorized' // 401: no session, or wrong credentials
  | 'throttled' // 429
  | 'forbidden' // 403
  | 'invalid' // 400: bad request, or an invite that is wrong, expired or used
  | 'weak' // 400 from accept-invite: the password is not allowed
  | 'server' // 5xx, or an answer that is not what the contract says
  | 'network'; // the request did not reach the gateway

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  // Only for 'throttled', and only when the gateway sent a usable Retry-After.
  readonly retryAfterSeconds: number | null;

  constructor(kind: ApiErrorKind, retryAfterSeconds: number | null = null) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type Role = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  role: Role;
}

const WEAK_PASSWORD = 'weak password';

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,7}$/.test(value.trim())) return null;
  const seconds = Number(value);
  return seconds > 0 ? seconds : null;
}

async function errorFor(response: Response): Promise<ApiError> {
  const { status } = response;
  if (status === 401) return new ApiError('unauthorized');
  if (status === 403) return new ApiError('forbidden');
  if (status === 429) return new ApiError('throttled', parseRetryAfter(response.headers.get('Retry-After')));
  if (status === 400) {
    // Only the fixed marker of the gateway is read, and only to tell two kinds of 400 apart. The reason text is dropped.
    const body: unknown = await response.json().catch(() => null);
    const marker = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return new ApiError(marker === WEAK_PASSWORD ? 'weak' : 'invalid');
  }
  return new ApiError('server');
}

export async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | undefined> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }
  if (!response.ok) throw await errorFor(response);
  if (response.status === 204) return undefined;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('server');
  }
}

const isUser = (value: unknown): value is User => {
  if (typeof value !== 'object' || value === null) return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === 'string' && typeof user.email === 'string' && (user.role === 'admin' || user.role === 'member');
};

async function userFrom(promise: Promise<{ user?: unknown } | undefined>): Promise<User> {
  const answer = await promise;
  if (!answer || !isUser(answer.user)) throw new ApiError('server');
  return answer.user;
}

// The session of the cookie, or null when there is none (a 401 is an answer here, not a failure).
export async function fetchSession(): Promise<User | null> {
  try {
    return await userFrom(request('GET', '/api/auth/me'));
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'unauthorized') return null;
    throw error;
  }
}

export const login = (email: string, password: string): Promise<User> => userFrom(request('POST', '/api/auth/login', { email, password }));

export const acceptInvite = (token: string, password: string): Promise<User> => userFrom(request('POST', '/api/auth/accept-invite', { token, password }));

export async function logout(): Promise<void> {
  try {
    await request('POST', '/api/auth/logout');
  } catch (error) {
    // No session left on the server is the state that a logout wants.
    if (!(error instanceof ApiError && error.kind === 'unauthorized')) throw error;
  }
}
