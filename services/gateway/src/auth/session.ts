import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/queryable.ts';

// Dashboard sessions (docs/architecture.md, decision 35). The cookie holds 32 random bytes; only their SHA-256 is stored.
// A session ends after 12 hours, or after 2 hours without a request, or when its row is deleted.
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const SESSION_IDLE_SECONDS = 2 * 60 * 60;

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface SessionCookie {
  name: string;
  // Secure (and the __Host- prefix) only when the public origin is https: a browser refuses a Secure cookie on plain
  // http for a host that is not localhost.
  secure: boolean;
}

// The settings that the session middleware and the auth routes share, derived from PUBLIC_ORIGIN.
export interface SessionAuthConfig {
  publicOrigin: string;
  cookie: SessionCookie;
}

export function sessionAuthConfig(publicOrigin: string): SessionAuthConfig {
  const secure = new URL(publicOrigin).protocol === 'https:';
  return { publicOrigin, cookie: { name: secure ? '__Host-session' : 'session', secure } };
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

const attributes = (cookie: SessionCookie, maxAge: number): string =>
  `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${cookie.secure ? '; Secure' : ''}`;

// Never Domain: the cookie belongs to this host only.
export function sessionSetCookie(cookie: SessionCookie, token: string): string {
  return `${cookie.name}=${token}; ${attributes(cookie, SESSION_MAX_AGE_SECONDS)}`;
}

export function sessionClearCookie(cookie: SessionCookie): string {
  return `${cookie.name}=; ${attributes(cookie, 0)}`;
}

// Returns the token only when the cookie is present and has the exact shape of a token. Anything else is "no session",
// so a malformed value never reaches the database.
export function sessionTokenFromCookieHeader(header: string | undefined, cookie: SessionCookie): string | null {
  if (typeof header !== 'string' || header.length > 4096) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0 || trimmed.slice(0, separator) !== cookie.name) continue;
    const value = trimmed.slice(separator + 1);
    return TOKEN_FORMAT.test(value) ? value : null;
  }
  return null;
}

export interface SessionIdentity {
  sessionId: string;
  userId: string;
  email: string;
  role: 'admin' | 'member';
  // The earlier of the absolute limit and the idle limit.
  expiresAt: Date;
}

export async function createSession(db: Queryable, userId: string): Promise<{ token: string; sessionId: string }> {
  const token = newSessionToken();
  // Old rows are removed here, when somebody signs in, so no timer is needed.
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  const result = await db.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING id",
    [userId, hashSessionToken(token), SESSION_MAX_AGE_SECONDS],
  );
  return { token, sessionId: result.rows[0].id };
}

// The role and the status come from the users table on every request, so a disabled user or a changed role takes effect
// at once. An expired or idle session finds nothing.
export async function findSession(db: Queryable, hash: Buffer): Promise<SessionIdentity | null> {
  const result = await db.query(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, u.role,
            LEAST(s.expires_at, s.last_seen_at + make_interval(secs => $2)) AS expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()
       AND s.last_seen_at > now() - make_interval(secs => $2) AND u.status = 'active'`,
    [hash, SESSION_IDLE_SECONDS],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return { sessionId: row.session_id, userId: row.user_id, email: row.email, role: row.role, expiresAt: row.expires_at };
}

// At most one write a minute per session (the SQL has the same guard for the case of several pods).
export async function touchSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'", [sessionId]);
}

export async function deleteSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function deleteSessionsForUser(db: Queryable, userId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}
