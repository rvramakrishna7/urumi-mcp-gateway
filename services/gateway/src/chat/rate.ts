import type { Queryable } from '../db/queryable.ts';

// The per-user rate limit of POST /api/chat (docs/architecture.md, decision 40). A fixed window of one minute and a cap
// per user. The attempt is reserved BEFORE any work, with one atomic statement: the row of the user is locked by the
// ON CONFLICT clause, so a burst of parallel requests is counted one after the other and exactly "max" of them pass.
// Unlike the login throttle (decision 35) there is no check-then-act.
export const CHAT_RATE_WINDOW_SECONDS = 60;

export interface RateDecision {
  allowed: boolean;
  // Seconds until the window ends. Only meaningful when allowed is false (at least 1).
  retryAfterSeconds: number;
}

// A new window starts when the old one is older than windowSeconds. A refused request does not extend the window, and
// the counter stops at max + 1, so the number cannot grow without limit.
export async function reserveChatRequest(
  db: Queryable,
  userId: string,
  max: number,
  windowSeconds: number = CHAT_RATE_WINDOW_SECONDS,
): Promise<RateDecision> {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  const result = await db.query(
    `INSERT INTO chat_rate AS r (user_id, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (user_id) DO UPDATE SET
       window_start = CASE WHEN r.window_start <= now() - make_interval(secs => $3::double precision) THEN now() ELSE r.window_start END,
       count = CASE WHEN r.window_start <= now() - make_interval(secs => $3::double precision) THEN 1 ELSE LEAST(r.count + 1, $2::integer + 1) END
     RETURNING count, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $3::double precision) - now())))::int AS seconds`,
    [userId, max, windowSeconds],
  );
  const row = result.rows[0] as { count: number; seconds: number };
  return { allowed: row.count <= max, retryAfterSeconds: Math.max(1, row.seconds) };
}
