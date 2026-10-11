import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database, Queryable } from '../db/queryable.ts';
import { withTransaction } from '../db/queryable.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import type { Role } from './repository.ts';
import { IdentityError } from './repository.ts';

// Invites and the first admin (docs/architecture.md, decision 36). An invite is a token that lets one person set a
// password once. Only the SHA-256 of the token is stored (the token has 256 bits of randomness, so a fast hash is enough).
export const INVITE_TTL_SECONDS = 72 * 60 * 60;
export const BOOTSTRAP_TTL_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_FORMAT = /^inv_[A-Za-z0-9_-]{43}$/;

export const looksLikeInviteToken = (value: string): boolean => TOKEN_FORMAT.test(value);

export function generateInviteToken(): string {
  return `inv_${randomBytes(32).toString('base64url')}`;
}

export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

// Makes a new invite for a user who is not disabled and returns the token (shown once). A new token replaces the old one,
// so only the latest invite works. For a user who already has a password this is the password reset (accepting it sets a
// new password and ends the sessions of that user).
export async function issueInvite(db: Queryable, userId: string, ttlSeconds: number = INVITE_TTL_SECONDS): Promise<string | null> {
  const token = generateInviteToken();
  const result = await db.query(
    `UPDATE users SET invite_token_hash = $2, invite_expires_at = now() + make_interval(secs => $3::double precision)
     WHERE id = $1 AND status <> 'disabled' RETURNING id`,
    [userId, hashInviteToken(token), ttlSeconds],
  );
  return result.rowCount === 0 ? null : token;
}

export async function issueInviteByEmail(db: Queryable, email: string): Promise<string> {
  const user = await db.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  if (user.rowCount === 0) throw new IdentityError('no user with this email');
  const token = await issueInvite(db, user.rows[0].id);
  if (!token) throw new IdentityError('the user is disabled');
  return token;
}

export type AcceptResult =
  | { ok: true; user: { id: string; email: string; role: Role } }
  // One answer for a token that is wrong, expired, already used, or of a disabled user.
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'weak'; problem: string };

// Sets the password of the person whom the token belongs to. The token is used up by one UPDATE, so two requests with the
// same token cannot both succeed. The sessions of that user are deleted: a reset must log out whoever had the old password.
export async function acceptInvite(db: Database, token: string, password: unknown): Promise<AcceptResult> {
  if (!looksLikeInviteToken(token)) return { ok: false, reason: 'invalid' };
  const hash = hashInviteToken(token);
  const found = await db.query(
    "SELECT email FROM users WHERE invite_token_hash = $1 AND invite_expires_at > now() AND status <> 'disabled'",
    [hash],
  );
  if (found.rowCount === 0) return { ok: false, reason: 'invalid' };
  // The reason for a weak password is only given to the holder of a valid token. It never repeats the password.
  const problem = passwordProblem(password, found.rows[0].email);
  if (problem) return { ok: false, reason: 'weak', problem };

  // The slow hash runs before the transaction, so no row is locked while it works.
  const passwordHash = await hashPassword(password as string);
  return withTransaction(db, async (client) => {
    const updated = await client.query(
      `UPDATE users SET password_hash = $2, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL, last_login_at = now()
       WHERE invite_token_hash = $1 AND invite_expires_at > now() AND status <> 'disabled'
       RETURNING id, email, role`,
      [hash, passwordHash],
    );
    if (updated.rowCount === 0) return { ok: false as const, reason: 'invalid' as const };
    const row = updated.rows[0];
    await client.query('DELETE FROM sessions WHERE user_id = $1', [row.id]);
    return { ok: true as const, user: { id: row.id, email: row.email, role: row.role as Role } };
  });
}

// ---------------------------------------------------------------------------------------------------------
// The first admin. The chart makes a random token in a Secret; the gateway reads it from a file at start.
// ---------------------------------------------------------------------------------------------------------
export class BootstrapError extends Error {}

export type BootstrapAction = 'created' | 'armed' | 'unchanged';

// One number for the advisory lock, so that gateway pods that start together do this one after another.
const BOOTSTRAP_LOCK_KEY = 7_242_003;

// Reads the token from the mounted Secret. The message never contains the value.
export function readBootstrapToken(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    throw new BootstrapError('BOOTSTRAP_TOKEN_FILE cannot be read');
  }
  if (!looksLikeInviteToken(text)) throw new BootstrapError('BOOTSTRAP_TOKEN_FILE must hold an invite token');
  return text;
}

// - the admin does not exist: it is created as "invited" with this token (valid for 7 days);
// - it exists, is an admin, has no password yet and is not disabled: the token is armed again (a new 7 days), so a
//   restart repairs an invite that expired;
// - anything else (a password is set, a member, a disabled user) is left alone.
export async function applyBootstrap(db: Database, email: string, token: string): Promise<BootstrapAction> {
  const hash = hashInviteToken(token);
  try {
    return await withTransaction(db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
      const user = await client.query('SELECT id, role, status, password_hash FROM users WHERE email = $1', [email]);
      if (user.rowCount === 0) {
        await client.query(
          `INSERT INTO users (email, role, status, invite_token_hash, invite_expires_at)
           VALUES ($1, 'admin', 'invited', $2, now() + make_interval(secs => $3::double precision))`,
          [email, hash, BOOTSTRAP_TTL_SECONDS],
        );
        return 'created' as const;
      }
      const row = user.rows[0];
      if (row.role !== 'admin' || row.password_hash !== null || row.status === 'disabled') return 'unchanged' as const;
      await client.query(
        'UPDATE users SET invite_token_hash = $2, invite_expires_at = now() + make_interval(secs => $3::double precision) WHERE id = $1',
        [row.id, hash, BOOTSTRAP_TTL_SECONDS],
      );
      return 'armed' as const;
    });
  } catch (error) {
    // The token hash is unique: the same token cannot belong to two users.
    if ((error as { code?: string }).code === '23505') throw new BootstrapError('the bootstrap token is already in use by another user');
    throw error;
  }
}
