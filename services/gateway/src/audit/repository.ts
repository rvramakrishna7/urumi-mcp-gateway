import type { Queryable } from '../db/queryable.ts';

// The two phases of the audit log (docs/architecture.md, decision 26). Arguments and results are never stored.

export type AuditOutcome = 'ok' | 'error' | 'timeout' | 'unreachable' | 'unknown_tool' | 'denied';

export interface AuditStart {
  userId: string;
  userEmail: string;
  serverId: string | null;
  serverSlug: string | null;
  requestedName: string;
  tool: string | null;
  via: 'mcp' | 'chat';
  requestId: string;
}

// The name that a caller typed is untrusted text. It is stored without control characters and cut to the column limit.
export function auditSafeName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

// Phase 1: before the upstream is called. If this throws, the call must not be made.
export async function startAudit(db: Queryable, entry: AuditStart): Promise<number> {
  const result = await db.query(
    `INSERT INTO audit_log (user_id, user_email, server_id, server_slug, requested_name, tool, via, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [entry.userId, entry.userEmail, entry.serverId, entry.serverSlug, auditSafeName(entry.requestedName), entry.tool, entry.via, entry.requestId],
  );
  return Number(result.rows[0].id);
}

// Phase 2: when the call has ended. Only a row that is still "started" is changed.
export async function finishAudit(db: Queryable, id: number, outcome: AuditOutcome, errorKind: string | null, durationMs: number): Promise<void> {
  await db.query(
    `UPDATE audit_log SET outcome = $2, error_kind = $3, finished_at = now(), duration_ms = $4 WHERE id = $1 AND outcome = 'started'`,
    [id, outcome, errorKind, Math.max(0, Math.round(durationMs))],
  );
}
