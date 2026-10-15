import type { Database, Queryable } from '../db/queryable.ts';
import { withTransaction } from '../db/queryable.ts';
import type { ToolReview } from './sanitize.ts';

// The cached tool list and the status of the servers (docs/architecture.md, decision 28). The poller writes it,
// listTools reads it, and a call changes the status only in the cases that markUnreachable and markConnectedByCall
// document.

// Replaces the whole list of one server in one transaction, so a reader sees the old list or the new one, never half.
export async function replaceTools(db: Database, serverId: string, review: ToolReview): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query('DELETE FROM upstream_tools WHERE server_id = $1', [serverId]);
    for (const tool of review.accepted) {
      await client.query(
        `INSERT INTO upstream_tools (server_id, name, description, input_schema, annotations, description_hash)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) ON CONFLICT (server_id, name) DO NOTHING`,
        [serverId, tool.name, tool.description, JSON.stringify(tool.inputSchema), tool.annotations === null ? null : JSON.stringify(tool.annotations), tool.descriptionHash],
      );
    }
    for (const tool of review.skipped) {
      await client.query(
        `INSERT INTO upstream_tools (server_id, name, description_hash, skipped_reason)
         VALUES ($1, $2, $3, $4) ON CONFLICT (server_id, name) DO NOTHING`,
        [serverId, tool.name, tool.descriptionHash, tool.reason],
      );
    }
  });
}

// A probe succeeded. The note says that something about the list was cut (too many tools, repeated names).
export async function markConnected(db: Queryable, serverId: string, note: string | null): Promise<void> {
  await db.query(
    `UPDATE upstream_servers
     SET status = 'connected', status_reason = $2, status_checked_at = now(), last_success_at = now()
     WHERE id = $1`,
    [serverId, note],
  );
}

// The reason is a short code such as "timeout" or "refused", never a message of the upstream.
export async function markUnreachable(db: Queryable, serverId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE upstream_servers SET status = 'unreachable', status_reason = $2, status_checked_at = now() WHERE id = $1`,
    [serverId, reason],
  );
}

// A call that worked proves the server is reachable. It only changes a server that is not marked connected yet, so a
// healthy server is not written to on every call and the note of the last probe is kept.
export async function markConnectedByCall(db: Queryable, serverId: string): Promise<void> {
  await db.query(
    `UPDATE upstream_servers
     SET status = 'connected', status_reason = NULL, status_checked_at = now(), last_success_at = now()
     WHERE id = $1 AND status <> 'connected'`,
    [serverId],
  );
}

export interface ServerToolNames {
  serverId: string;
  slug: string;
  // The name as the upstream calls it, and as a client sees it (<slug>__<name>, decision 5).
  tools: Array<{ name: string; exposedName: string }>;
  skipped: Array<{ name: string; reason: string }>;
  // When the poller last stored the list. Null when the server was never probed successfully.
  fetchedAt: Date | null;
}

// The cached tool names of every server, for the admin screen. Names only: a description or a schema is text from the
// upstream and is not needed here. A server with no cached tools is still listed, with empty lists. The cache is kept
// when a server turns unreachable or is disabled, so the caller reads the status of the server from the registry.
export async function listToolNamesByServer(db: Queryable): Promise<ServerToolNames[]> {
  const result = await db.query(
    `SELECT s.id, s.slug, t.name, t.skipped_reason, t.fetched_at
     FROM upstream_servers s LEFT JOIN upstream_tools t ON t.server_id = s.id
     ORDER BY s.slug, t.name`,
  );
  const byServer = new Map<string, ServerToolNames>();
  for (const row of result.rows) {
    let entry = byServer.get(row.id as string);
    if (!entry) {
      entry = { serverId: row.id as string, slug: row.slug as string, tools: [], skipped: [], fetchedAt: null };
      byServer.set(entry.serverId, entry);
    }
    if (row.name === null) continue;
    if (row.skipped_reason === null) entry.tools.push({ name: row.name as string, exposedName: `${row.slug}__${row.name}` });
    else entry.skipped.push({ name: row.name as string, reason: row.skipped_reason as string });
    const fetchedAt = row.fetched_at as Date;
    if (entry.fetchedAt === null || fetchedAt > entry.fetchedAt) entry.fetchedAt = fetchedAt;
  }
  return [...byServer.values()];
}
