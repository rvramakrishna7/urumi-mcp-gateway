import { createHash } from 'node:crypto';
import type { Database, Queryable } from '../db/queryable.ts';
import { withTransaction } from '../db/queryable.ts';

// The login throttle (docs/architecture.md, decision 35). Five failures for one email within 15 minutes lock that email for
// 15 minutes; a correct password does not pass during the lock. A failure for an email that does not exist is counted
// the same way, so the answer does not tell which emails exist. The key is a hash, so the table holds no email.
export const MAX_FAILURES = 5;
export const WINDOW_SECONDS = 15 * 60;
export const LOCK_SECONDS = 15 * 60;
// Rows that are old and not locked are removed whenever a failure is written, so the table cannot grow without limit.
const KEEP_SECONDS = 60 * 60;

export function emailThrottleKey(email: string): Buffer {
  return createHash('sha256').update(`email:${email.trim().toLowerCase()}`, 'utf8').digest();
}

// The seconds that the key is still locked, or 0 when it is not.
export async function lockedSeconds(db: Queryable, key: Buffer): Promise<number> {
  const result = await db.query(
    'SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int AS seconds FROM login_throttle WHERE key_hash = $1 AND locked_until > now()',
    [key],
  );
  return result.rowCount === 0 ? 0 : Math.max(1, result.rows[0].seconds);
}

export async function recordFailure(db: Database, key: Buffer): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query('INSERT INTO login_throttle (key_hash, failures) VALUES ($1, 0) ON CONFLICT (key_hash) DO NOTHING', [key]);
    // The row is locked for this transaction, so two failures at the same time are counted one after the other.
    const row = (
      await client.query('SELECT failures, window_started_at < now() - make_interval(secs => $2::double precision) AS expired FROM login_throttle WHERE key_hash = $1 FOR UPDATE', [key, WINDOW_SECONDS])
    ).rows[0];
    const failures: number = row.expired ? 1 : row.failures + 1;
    await client.query(
      `UPDATE login_throttle SET failures = $2::integer,
         window_started_at = CASE WHEN $3::boolean THEN now() ELSE window_started_at END,
         locked_until = CASE WHEN $2::integer >= $4::integer THEN now() + make_interval(secs => $5::double precision) ELSE locked_until END
       WHERE key_hash = $1`,
      [key, failures, row.expired, MAX_FAILURES, LOCK_SECONDS],
    );
    await client.query('DELETE FROM login_throttle WHERE window_started_at < now() - make_interval(secs => $1) AND (locked_until IS NULL OR locked_until < now())', [KEEP_SECONDS]);
  });
}

// A correct login clears the count.
export async function clearFailures(db: Queryable, key: Buffer): Promise<void> {
  await db.query('DELETE FROM login_throttle WHERE key_hash = $1', [key]);
}
