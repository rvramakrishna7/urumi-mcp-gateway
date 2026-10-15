// The one place that talks to the gateway. The dashboard and the API share one origin (the Ingress host), so every call is a
// same-origin fetch: the browser sends the httpOnly session cookie and sets the Origin header by itself. Nothing here reads,
// stores or logs a cookie, a password or a token, and the text of an error body is never kept: only its kind is.
export type ApiErrorKind =
  | 'unauthorized' // 401: no session, or wrong credentials
  | 'throttled' // 429
  | 'forbidden' // 403
  | 'notfound' // 404: the thing is not there, or is not yours (the gateway does not tell the two apart)
  | 'limit' // 409: a limit of the gateway is reached (the 10 active keys of a user)
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
  if (status === 404) return new ApiError('notfound');
  if (status === 409) return new ApiError('limit');
  if (status === 429) return new ApiError('throttled', parseRetryAfter(response.headers.get('Retry-After')));
  if (status === 400) {
    // Only the fixed marker of the gateway is read, and only to tell two kinds of 400 apart. The reason text is dropped.
    const body: unknown = await response.json().catch(() => null);
    const marker = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return new ApiError(marker === WEAK_PASSWORD ? 'weak' : 'invalid');
  }
  return new ApiError('server');
}

export async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T | undefined> {
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

// One API key of the signed-in user. The gateway sends the first characters of the key (keyPrefix) and never the hash.
export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked';
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isApiKey = (value: unknown): value is ApiKey => {
  if (typeof value !== 'object' || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.id === 'string' &&
    typeof key.name === 'string' &&
    typeof key.keyPrefix === 'string' &&
    typeof key.createdAt === 'string' &&
    isNullableString(key.lastUsedAt) &&
    isNullableString(key.revokedAt) &&
    (key.status === 'active' || key.status === 'revoked')
  );
};

export async function listKeys(): Promise<ApiKey[]> {
  const answer = await request<{ keys?: unknown }>('GET', '/api/me/keys');
  if (!answer || !Array.isArray(answer.keys) || !answer.keys.every(isApiKey)) throw new ApiError('server');
  return answer.keys;
}

// The plain key is in this one answer and nowhere else. The caller keeps it in component state only.
export async function createKey(name: string): Promise<{ key: string; meta: ApiKey }> {
  const answer = await request<{ key?: unknown; meta?: unknown }>('POST', '/api/me/keys', { name });
  if (!answer || typeof answer.key !== 'string' || !isApiKey(answer.meta)) throw new ApiError('server');
  return { key: answer.key, meta: answer.meta };
}

export async function revokeKey(id: string): Promise<void> {
  await request('DELETE', `/api/me/keys/${encodeURIComponent(id)}`);
}

export const AUDIT_OUTCOMES = ['ok', 'error', 'timeout', 'unreachable', 'unknown_tool', 'denied', 'interrupted', 'started'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

// One tool call as the gateway records it. There are no arguments and no results in it, and error text of an upstream never.
export interface AuditItem {
  id: number;
  ts: string;
  finishedAt: string | null;
  userEmail: string;
  serverSlug: string | null;
  tool: string | null;
  requestedName: string;
  outcome: AuditOutcome;
  errorKind: string | null;
  durationMs: number | null;
  via: 'mcp' | 'chat';
}

export interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

export interface AuditFilter {
  outcomes: AuditOutcome[];
  server: string;
  userId: string;
}

const isAuditItem = (value: unknown): value is AuditItem => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'number' &&
    typeof item.ts === 'string' &&
    isNullableString(item.finishedAt) &&
    typeof item.userEmail === 'string' &&
    isNullableString(item.serverSlug) &&
    isNullableString(item.tool) &&
    typeof item.requestedName === 'string' &&
    (AUDIT_OUTCOMES as readonly unknown[]).includes(item.outcome) &&
    isNullableString(item.errorKind) &&
    (item.durationMs === null || typeof item.durationMs === 'number') &&
    (item.via === 'mcp' || item.via === 'chat')
  );
};

export async function listAudit(filter: AuditFilter, cursor: string | null): Promise<AuditPage> {
  const params = new URLSearchParams();
  for (const outcome of filter.outcomes) params.append('outcome', outcome);
  if (filter.server !== '') params.set('server', filter.server);
  if (filter.userId !== '') params.set('userId', filter.userId);
  if (cursor !== null) params.set('cursor', cursor);
  const query = params.toString();
  const answer = await request<{ items?: unknown; nextCursor?: unknown }>('GET', query === '' ? '/api/audit' : `/api/audit?${query}`);
  if (!answer || !Array.isArray(answer.items) || !answer.items.every(isAuditItem) || !isNullableString(answer.nextCursor)) throw new ApiError('server');
  return { items: answer.items, nextCursor: answer.nextCursor };
}

export interface UserOption {
  id: string;
  email: string;
}

// For the admin's user filter only. The route is admin only; the gateway refuses it to a member.
export async function listUserOptions(): Promise<UserOption[]> {
  const answer = await request<{ users?: unknown }>('GET', '/api/admin/users');
  if (!answer || !Array.isArray(answer.users)) throw new ApiError('server');
  return answer.users.map((user: unknown) => {
    const u = user as Record<string, unknown>;
    if (typeof u?.id !== 'string' || typeof u.email !== 'string') throw new ApiError('server');
    return { id: u.id, email: u.email };
  });
}
