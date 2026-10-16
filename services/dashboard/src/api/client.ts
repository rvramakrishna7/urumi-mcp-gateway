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

// The fixed error markers of POST /api/chat, as short codes. The client keeps a marker only if it is in this list (REASONS), so
// text from anywhere else can never become a reason. The status alone cannot tell the cases apart: 429 is the quota of the user or
// the model service, 502 is a rejected request or an unavailable model, 503 is "not configured" or "database unavailable".
export type ApiErrorReason =
  | 'not_configured'
  | 'invalid_request'
  | 'rate_limited'
  | 'service_unavailable'
  | 'invalid_confirmation'
  | 'model_rate_limited'
  | 'model_timeout'
  | 'model_rejected'
  | 'model_unavailable'
  | 'internal';

const REASONS: Readonly<Record<string, ApiErrorReason>> = {
  'chat not configured': 'not_configured',
  'invalid request': 'invalid_request',
  'too many requests': 'rate_limited',
  'service unavailable': 'service_unavailable',
  'invalid confirmation': 'invalid_confirmation',
  'model rate limited': 'model_rate_limited',
  'model timeout': 'model_timeout',
  'model rejected the request': 'model_rejected',
  'model unavailable': 'model_unavailable',
  'internal error': 'internal',
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  // Only for 'throttled', and only when the gateway sent a usable Retry-After.
  readonly retryAfterSeconds: number | null;
  // The allowlisted marker of the answer, or null (no body, another body, or a marker that is not in the list).
  readonly reason: ApiErrorReason | null;

  constructor(kind: ApiErrorKind, retryAfterSeconds: number | null = null, reason: ApiErrorReason | null = null) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
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

// Only the fixed marker of the gateway is read, to tell apart answers that share a status. Its text is never kept: a marker
// that is not in REASONS becomes null.
async function markerOf(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null);
  const marker = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof marker === 'string' ? marker : undefined;
}

const reasonOf = (marker: string | undefined): ApiErrorReason | null => (marker !== undefined && Object.hasOwn(REASONS, marker) ? (REASONS[marker] ?? null) : null);

async function errorFor(response: Response): Promise<ApiError> {
  const { status } = response;
  if (status === 401) return new ApiError('unauthorized');
  if (status === 403) return new ApiError('forbidden');
  if (status === 404) return new ApiError('notfound');
  if (status === 409) return new ApiError('limit');
  if (status === 429) return new ApiError('throttled', parseRetryAfter(response.headers.get('Retry-After')), reasonOf(await markerOf(response)));
  if (status === 400) {
    const marker = await markerOf(response);
    return new ApiError(marker === WEAK_PASSWORD ? 'weak' : 'invalid', null, reasonOf(marker));
  }
  return new ApiError('server', null, reasonOf(await markerOf(response)));
}

export async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | undefined> {
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

export type ServerStatus = 'unknown' | 'connected' | 'unreachable';

// One upstream MCP server as the gateway shows it to an admin. The credential value is never in it: only whether one is set.
export interface UpstreamServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  callTimeoutMs: number;
  credential: { set: boolean; kind: 'bearer' | 'header' | null; header: string | null };
  status: ServerStatus;
  statusReason: string | null;
  statusCheckedAt: string | null;
  seedManaged: boolean;
}

// What the admin types. It goes out in a request body and is not kept anywhere else.
export type CredentialInput = { kind: 'bearer'; value: string } | { kind: 'header'; header: string; value: string };

export interface CreateServerInput {
  slug: string;
  name: string;
  url: string;
  callTimeoutMs: number;
  credential?: CredentialInput;
}

// PATCH semantics of the gateway: a missing key keeps the value, and for credential null removes it.
export interface PatchServerInput {
  name?: string;
  url?: string;
  enabled?: boolean;
  callTimeoutMs?: number;
  credential?: CredentialInput | null;
}

const isUpstreamServer = (value: unknown): value is UpstreamServer => {
  if (typeof value !== 'object' || value === null) return false;
  const server = value as Record<string, unknown>;
  const credential = server.credential as Record<string, unknown> | null | undefined;
  return (
    typeof server.id === 'string' &&
    typeof server.slug === 'string' &&
    typeof server.name === 'string' &&
    typeof server.url === 'string' &&
    typeof server.enabled === 'boolean' &&
    typeof server.callTimeoutMs === 'number' &&
    typeof credential === 'object' &&
    credential !== null &&
    typeof credential.set === 'boolean' &&
    (credential.kind === null || credential.kind === 'bearer' || credential.kind === 'header') &&
    isNullableString(credential.header) &&
    (server.status === 'unknown' || server.status === 'connected' || server.status === 'unreachable') &&
    isNullableString(server.statusReason) &&
    isNullableString(server.statusCheckedAt) &&
    typeof server.seedManaged === 'boolean'
  );
};

export async function listServers(): Promise<UpstreamServer[]> {
  const answer = await request<{ servers?: unknown }>('GET', '/api/admin/servers');
  if (!answer || !Array.isArray(answer.servers) || !answer.servers.every(isUpstreamServer)) throw new ApiError('server');
  return answer.servers;
}

export async function createServer(input: CreateServerInput): Promise<void> {
  await request('POST', '/api/admin/servers', input);
}

export async function patchServer(id: string, patch: PatchServerInput): Promise<void> {
  await request('PATCH', `/api/admin/servers/${encodeURIComponent(id)}`, patch);
}

export async function deleteServer(id: string): Promise<void> {
  await request('DELETE', `/api/admin/servers/${encodeURIComponent(id)}`);
}

// The cached tool names of one server (the gateway reads its own cache; no upstream is called for this answer).
export interface ServerTools {
  serverId: string;
  tools: Array<{ name: string; exposedName: string }>;
  skipped: Array<{ name: string; reason: string }>;
  fetchedAt: string | null;
}

const isServerTools = (value: unknown): value is ServerTools => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const named = (item: unknown, second: string) =>
    typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string' && typeof (item as Record<string, unknown>)[second] === 'string';
  return (
    typeof entry.serverId === 'string' &&
    Array.isArray(entry.tools) &&
    entry.tools.every((tool) => named(tool, 'exposedName')) &&
    Array.isArray(entry.skipped) &&
    entry.skipped.every((tool) => named(tool, 'reason')) &&
    isNullableString(entry.fetchedAt)
  );
};

export async function listServerTools(): Promise<ServerTools[]> {
  const answer = await request<{ servers?: unknown }>('GET', '/api/admin/tools');
  if (!answer || !Array.isArray(answer.servers) || !answer.servers.every(isServerTools)) throw new ApiError('server');
  return answer.servers;
}

export type UserStatus = 'invited' | 'active' | 'disabled';

// One team member as the gateway shows them to an admin. No password, invite or key hash is ever in it.
export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

// An invite: the link carries the one-time token in its fragment. Only the link and the expiry are kept; both live in
// component state for as long as the reveal panel is open.
export interface Invite {
  link: string;
  expiresAt: string;
}

const isAdminUser = (value: unknown): value is AdminUser => {
  if (typeof value !== 'object' || value === null) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === 'string' &&
    typeof user.email === 'string' &&
    (user.role === 'admin' || user.role === 'member') &&
    (user.status === 'invited' || user.status === 'active' || user.status === 'disabled') &&
    typeof user.createdAt === 'string' &&
    isNullableString(user.lastLoginAt)
  );
};

const isInvite = (value: unknown): value is Invite => {
  if (typeof value !== 'object' || value === null) return false;
  const invite = value as Record<string, unknown>;
  return typeof invite.link === 'string' && typeof invite.expiresAt === 'string';
};

const inviteFrom = (answer: { invite?: unknown } | undefined): Invite => {
  if (!answer || !isInvite(answer.invite)) throw new ApiError('server');
  return { link: answer.invite.link, expiresAt: answer.invite.expiresAt };
};

export async function listUsers(): Promise<AdminUser[]> {
  const answer = await request<{ users?: unknown }>('GET', '/api/admin/users');
  if (!answer || !Array.isArray(answer.users) || !answer.users.every(isAdminUser)) throw new ApiError('server');
  return answer.users;
}

// The gateway makes members only: the body has an email and nothing else.
export async function inviteMember(email: string): Promise<Invite> {
  return inviteFrom(await request<{ invite?: unknown }>('POST', '/api/admin/users', { email }));
}

export async function reinviteUser(id: string): Promise<Invite> {
  return inviteFrom(await request<{ invite?: unknown }>('POST', `/api/admin/users/${encodeURIComponent(id)}/invite`));
}

export async function setUserStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
  await request('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, { status });
}

export async function listUserKeys(id: string): Promise<ApiKey[]> {
  const answer = await request<{ keys?: unknown }>('GET', `/api/admin/users/${encodeURIComponent(id)}/keys`);
  if (!answer || !Array.isArray(answer.keys) || !answer.keys.every(isApiKey)) throw new ApiError('server');
  return answer.keys;
}

export async function revokeUserKey(id: string, keyId: string): Promise<void> {
  await request('DELETE', `/api/admin/users/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}`);
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatToolCall {
  name: string;
  ok: boolean;
  durationMs: number;
}

// A write tool that the server has not run. The token is bound to the user, the tool and these arguments and expires in 5 minutes.
export interface ChatPending {
  token: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatReply {
  reply: string;
  toolCalls: ChatToolCall[];
  pending: ChatPending | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isChatToolCall = (value: unknown): value is ChatToolCall =>
  isPlainObject(value) && typeof value.name === 'string' && typeof value.ok === 'boolean' && typeof value.durationMs === 'number';

const isChatPending = (value: unknown): value is ChatPending =>
  isPlainObject(value) && typeof value.token === 'string' && typeof value.name === 'string' && isPlainObject(value.args);

// One turn. The gateway keeps no conversation: the whole history goes with every request. To run a pending write, the same history
// goes again with the confirm object that the last answer carried.
export async function sendChat(messages: ChatMessage[], confirm?: ChatPending): Promise<ChatReply> {
  const answer = await request<{ reply?: unknown; toolCalls?: unknown; pending?: unknown }>('POST', '/api/chat', confirm ? { messages, confirm } : { messages });
  if (!answer || typeof answer.reply !== 'string' || !Array.isArray(answer.toolCalls) || !answer.toolCalls.every(isChatToolCall)) throw new ApiError('server');
  if (answer.pending !== undefined && !isChatPending(answer.pending)) throw new ApiError('server');
  return { reply: answer.reply, toolCalls: answer.toolCalls, pending: answer.pending ?? null };
}
