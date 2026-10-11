import { withTransaction } from '../db/queryable.ts';
import type { Database, Queryable } from '../db/queryable.ts';
import { generateApiKey } from './keys.ts';

export type Role = 'admin' | 'member';

export interface UserView {
  id: string;
  email: string;
  role: Role;
  status: string;
  createdAt: Date;
}

export interface KeyView {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyIdentity {
  keyId: string;
  userId: string;
  email: string;
  role: Role;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export class IdentityError extends Error {}

export async function createUser(db: Queryable, email: string, role: Role): Promise<UserView> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 254) throw new IdentityError('invalid email');
  if (role !== 'admin' && role !== 'member') throw new IdentityError('role must be admin or member');
  try {
    // Created by the command-line tool, which is run by someone with access to the pod: the user is active at once.
    // There is no password; the dashboard login and the invite flow come with Step 10.
    const result = await db.query(
      `INSERT INTO users (email, role, status) VALUES ($1, $2, 'active')
       RETURNING id, email, role, status, created_at`,
      [normalized, role],
    );
    return toUser(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new IdentityError('a user with this email already exists');
    throw error;
  }
}

export async function listUsers(db: Queryable): Promise<UserView[]> {
  const result = await db.query('SELECT id, email, role, status, created_at FROM users ORDER BY created_at, email');
  return result.rows.map(toUser);
}

// Returns the plain key once. Only its hash is stored.
export async function createApiKey(db: Queryable, email: string, name: string): Promise<{ key: string; view: KeyView }> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) throw new IdentityError('the key name must be 1 to 100 characters');
  const user = await db.query("SELECT id FROM users WHERE email = $1 AND status = 'active'", [email.trim().toLowerCase()]);
  if (user.rowCount === 0) throw new IdentityError('no active user with this email');
  const generated = generateApiKey();
  const result = await db.query(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, name, key_prefix, created_at, last_used_at, revoked_at`,
    [user.rows[0].id, trimmed, generated.displayPrefix, generated.hash],
  );
  return { key: generated.key, view: toKey(result.rows[0]) };
}

export async function listApiKeys(db: Queryable, email: string): Promise<KeyView[]> {
  const result = await db.query(
    `SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE u.email = $1 ORDER BY k.created_at`,
    [email.trim().toLowerCase()],
  );
  return result.rows.map(toKey);
}

// Revoking twice is not an error and keeps the first revocation time.
export async function revokeApiKey(db: Queryable, keyId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id',
    [keyId],
  );
  return (result.rowCount ?? 0) > 0;
}

// The keys of one user, for the dashboard. The user id comes from the session, never from the request, and is part of the
// WHERE clause (CLAUDE.md, non-negotiable rules). The hash is never selected.
export async function listKeysOfUser(db: Queryable, userId: string): Promise<KeyView[]> {
  const result = await db.query(
    `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return result.rows.map(toKey);
}

export const MAX_ACTIVE_KEYS_PER_USER = 10;

export type CreateKeyResult = { ok: true; key: string; view: KeyView } | { ok: false; reason: 'limit' | 'no_user' };

// The cap counts active keys only. The user row is locked for the length of the transaction, so two requests of one user
// cannot both count 9 and both insert (a count followed by an insert would race under READ COMMITTED).
export async function createKeyForUser(db: Database, userId: string, name: string): Promise<CreateKeyResult> {
  return withTransaction(db, async (client) => {
    const user = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE", [userId]);
    if (user.rowCount === 0) return { ok: false, reason: 'no_user' } as const;
    const active = await client.query('SELECT count(*)::int AS c FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    if (active.rows[0].c >= MAX_ACTIVE_KEYS_PER_USER) return { ok: false, reason: 'limit' } as const;
    const generated = generateApiKey();
    const result = await client.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, key_prefix, created_at, last_used_at, revoked_at`,
      [userId, name, generated.displayPrefix, generated.hash],
    );
    return { ok: true, key: generated.key, view: toKey(result.rows[0]) } as const;
  });
}

// False when the key does not exist or belongs to someone else: the caller cannot tell the two apart. Revoking twice keeps
// the first revocation time.
export async function revokeKeyForUser(db: Queryable, userId: string, keyId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id',
    [keyId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// The lookup of every authenticated request. A revoked key, or a key of a user who is not active, finds nothing.
export async function findActiveKey(db: Queryable, hash: Buffer): Promise<ApiKeyIdentity | null> {
  const result = await db.query(
    `SELECT k.id AS key_id, u.id AS user_id, u.email, u.role
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.status = 'active'`,
    [hash],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return { keyId: row.key_id, userId: row.user_id, email: row.email, role: row.role };
}

// The database guard makes it safe when several gateway pods share a key: the write happens at most once a minute.
export async function touchApiKey(db: Queryable, keyId: string): Promise<void> {
  await db.query(
    "UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
    [keyId],
  );
}

export interface LoginUser {
  id: string;
  email: string;
  role: Role;
  status: string;
  passwordHash: string | null;
}

// The only query that reads password_hash. The hash goes to the password check and nowhere else.
export async function findUserForLogin(db: Queryable, email: string): Promise<LoginUser | null> {
  const result = await db.query('SELECT id, email, role, status, password_hash FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return { id: row.id, email: row.email, role: row.role, status: row.status, passwordHash: row.password_hash };
}

export async function markLogin(db: Queryable, userId: string): Promise<void> {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

export interface AdminUserView extends UserView {
  lastLoginAt: Date | null;
  disabledAt: Date | null;
}

// The users page of an admin. The password hash, the invite hash and every key hash are never selected.
export async function listUsersForAdmin(db: Queryable): Promise<AdminUserView[]> {
  const result = await db.query(
    'SELECT id, email, role, status, created_at, last_login_at, disabled_at FROM users ORDER BY created_at, email',
  );
  return result.rows.map(toAdminUser);
}

export async function findUserForAdmin(db: Queryable, id: string): Promise<AdminUserView | null> {
  const result = await db.query(
    'SELECT id, email, role, status, created_at, last_login_at, disabled_at FROM users WHERE id = $1',
    [id],
  );
  return result.rowCount === 0 ? null : toAdminUser(result.rows[0]);
}

export type SetStatusResult = { ok: true; user: AdminUserView } | { ok: false; reason: 'not_found' | 'last_admin' };

// Disabling and enabling, with the guard for the last admin inside the transaction. The active admins are locked first (in
// id order), so two admins who disable each other at the same time cannot both see "the other one is left": the second
// transaction waits, then counts again. A disabled user loses the sessions at once and the pending invite (an old invite
// must not come back to life on enable). The API keys are not revoked: they stop working because the user is not active
// (findActiveKey), and they work again if the user is enabled. Enabling gives back "active" only when a password exists.
export async function setUserStatus(db: Database, targetId: string, status: 'active' | 'disabled'): Promise<SetStatusResult> {
  return withTransaction(db, async (client) => {
    const admins = await client.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE");
    const target = await client.query('SELECT id, role, status, password_hash FROM users WHERE id = $1 FOR UPDATE', [targetId]);
    if (target.rowCount === 0) return { ok: false, reason: 'not_found' } as const;
    const row = target.rows[0];
    if (status === 'disabled' && row.status !== 'disabled') {
      if (row.role === 'admin' && row.status === 'active' && (admins.rowCount ?? 0) <= 1) return { ok: false, reason: 'last_admin' } as const;
      await client.query(
        "UPDATE users SET status = 'disabled', disabled_at = now(), invite_token_hash = NULL, invite_expires_at = NULL WHERE id = $1",
        [targetId],
      );
      await client.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
    } else if (status === 'active' && row.status === 'disabled') {
      await client.query(
        "UPDATE users SET status = CASE WHEN password_hash IS NOT NULL THEN 'active' ELSE 'invited' END, disabled_at = NULL WHERE id = $1",
        [targetId],
      );
    }
    const done = await client.query(
      'SELECT id, email, role, status, created_at, last_login_at, disabled_at FROM users WHERE id = $1',
      [targetId],
    );
    return { ok: true, user: toAdminUser(done.rows[0]) } as const;
  });
}

function toAdminUser(row: Record<string, unknown>): AdminUserView {
  return { ...toUser(row), lastLoginAt: row.last_login_at as Date | null, disabledAt: row.disabled_at as Date | null };
}

function toUser(row: Record<string, unknown>): UserView {
  return { id: row.id as string, email: row.email as string, role: row.role as Role, status: row.status as string, createdAt: row.created_at as Date };
}

function toKey(row: Record<string, unknown>): KeyView {
  return {
    id: row.id as string,
    name: row.name as string,
    keyPrefix: row.key_prefix as string,
    createdAt: row.created_at as Date,
    lastUsedAt: row.last_used_at as Date | null,
    revokedAt: row.revoked_at as Date | null,
  };
}
