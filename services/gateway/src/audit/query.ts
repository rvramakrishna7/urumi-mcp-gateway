import type { Queryable } from '../db/queryable.ts';

// Reading the audit log for the dashboard (docs/architecture.md, decision 38). Arguments and results are not in the table,
// so they cannot be returned.

export const AUDIT_OUTCOMES = ['started', 'ok', 'error', 'timeout', 'unreachable', 'unknown_tool', 'denied', 'interrupted'] as const;
export type AuditOutcomeValue = (typeof AUDIT_OUTCOMES)[number];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// Who is asking. A member is always limited to their own rows, in the SQL itself.
export type AuditScope = { role: 'admin' } | { role: 'member'; userId: string };

export interface AuditQuery {
  limit?: number;
  // The id of the last row of the previous page. Only rows with a smaller id are returned.
  cursor?: string;
  // Admin only. A member who sets it is a programming error here (the route answers 400 before this is called).
  userId?: string;
  server?: string;
  tool?: string;
  outcomes?: readonly AuditOutcomeValue[];
  via?: 'mcp' | 'chat';
  // ts >= from and ts < to
  from?: Date;
  to?: Date;
}

export interface AuditItem {
  id: number;
  ts: Date;
  finishedAt: Date | null;
  userId: string | null;
  userEmail: string;
  serverSlug: string | null;
  tool: string | null;
  requestedName: string;
  outcome: AuditOutcomeValue;
  errorKind: string | null;
  durationMs: number | null;
  via: 'mcp' | 'chat';
  requestId: string;
}

export interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

const CURSOR = /^[1-9][0-9]{0,17}$/;

export function isValidCursor(value: string): boolean {
  return CURSOR.test(value);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function toItem(row: Record<string, unknown>): AuditItem {
  return {
    id: Number(row.id),
    ts: row.ts as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    userEmail: row.user_email as string,
    serverSlug: (row.server_slug as string | null) ?? null,
    tool: (row.tool as string | null) ?? null,
    requestedName: row.requested_name as string,
    outcome: row.outcome as AuditOutcomeValue,
    errorKind: (row.error_kind as string | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    via: row.via as 'mcp' | 'chat',
    requestId: row.request_id as string,
  };
}

// One page, newest first. Every condition is a fixed string with a placeholder: a value from the caller is never put into
// the SQL text. The page has one row more than asked for in the query, which only tells whether another page exists.
export async function queryAudit(db: Queryable, scope: AuditScope, query: AuditQuery = {}): Promise<AuditPage> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (condition: (placeholder: string) => string, value: unknown): void => {
    values.push(value);
    conditions.push(condition(`$${values.length}`));
  };

  if (scope.role === 'member') {
    if (query.userId !== undefined) throw new Error('a member cannot filter by user');
    // The scope comes first and comes from the session, never from the query.
    add((p) => `user_id = ${p}`, scope.userId);
  } else if (query.userId !== undefined) {
    add((p) => `user_id = ${p}`, query.userId);
  }
  if (query.cursor !== undefined) {
    if (!isValidCursor(query.cursor)) throw new Error('invalid cursor');
    add((p) => `id < ${p}::bigint`, query.cursor);
  }
  if (query.server !== undefined) add((p) => `server_slug = ${p}`, query.server);
  if (query.tool !== undefined) add((p) => `tool = ${p}`, query.tool);
  if (query.outcomes !== undefined && query.outcomes.length > 0) add((p) => `outcome = ANY(${p}::text[])`, [...query.outcomes]);
  if (query.via !== undefined) add((p) => `via = ${p}`, query.via);
  if (query.from !== undefined) add((p) => `ts >= ${p}`, query.from);
  if (query.to !== undefined) add((p) => `ts < ${p}`, query.to);

  const limit = clampLimit(query.limit);
  values.push(limit + 1);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query(
    `SELECT id, ts, finished_at, user_id, user_email, server_slug, tool, requested_name, outcome, error_kind, duration_ms, via, request_id
     FROM audit_log ${where} ORDER BY id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map(toItem);
  return { items, nextCursor: hasMore && items.length > 0 ? String(items[items.length - 1]!.id) : null };
}
