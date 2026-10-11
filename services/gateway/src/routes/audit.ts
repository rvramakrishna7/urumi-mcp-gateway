import express from 'express';
import { z } from 'zod';
import type { Database } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { authenticateSession, identityOf } from '../auth/middleware.ts';
import type { SessionAuthConfig } from '../auth/session.ts';
import { AUDIT_OUTCOMES, DEFAULT_LIMIT, MAX_LIMIT, queryAudit } from '../audit/query.ts';
import type { AuditItem, AuditQuery, AuditScope } from '../audit/query.ts';
import { describeIssues } from '../registry/validation.ts';

export interface AuditRouterDeps {
  db: Database;
  logger: Logger;
  sessions: SessionAuthConfig;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9-]{0,19}$/;
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

// A query parameter that may be repeated (?outcome=ok&outcome=error) arrives as a string or an array of strings.
const oneOrMany = <T extends z.ZodType>(item: T) => z.union([item, z.array(item).min(1).max(AUDIT_OUTCOMES.length)]).transform((value) => (Array.isArray(value) ? value : [value]));

// Unknown parameters are refused, so a typo in a filter is a 400 and not an unfiltered answer.
const querySchema = z.strictObject({
  limit: z.string().regex(/^[0-9]{1,4}$/).transform(Number).pipe(z.number().int().min(1).max(MAX_LIMIT)).optional(),
  cursor: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
  userId: z.string().regex(UUID).optional(),
  server: z.string().regex(SLUG).optional(),
  tool: z.string().min(1).max(200).optional(),
  outcome: oneOrMany(z.enum(AUDIT_OUTCOMES)).optional(),
  via: z.enum(['mcp', 'chat']).optional(),
  from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
});

function present(item: AuditItem) {
  return {
    id: item.id,
    ts: item.ts,
    finishedAt: item.finishedAt,
    userId: item.userId,
    userEmail: item.userEmail,
    serverSlug: item.serverSlug,
    tool: item.tool,
    requestedName: item.requestedName,
    outcome: item.outcome,
    errorKind: item.errorKind,
    durationMs: item.durationMs,
    via: item.via,
    requestId: item.requestId,
  };
}

// The audit log for the dashboard (docs/architecture.md, decision 38). Session only: an API key is never accepted here.
// The scope comes from the session and is applied in the SQL (queryAudit), never from the query string: a member sees
// only their own rows, and a member who sends userId is refused with 400.
export function createAuditRouter({ db, logger, sessions, now }: AuditRouterDeps): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticateSession({ db, logger, sessions, now }));

  router.get('/', async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: describeIssues(parsed.error) });
      return;
    }
    const { limit, cursor, userId, server, tool, outcome, via, from, to } = parsed.data;
    const { userId: callerId, role } = identityOf(res);
    const problem = (field: string, kind: string) => res.status(400).json({ error: 'invalid request', issues: [{ field, problem: kind }] });
    if (role !== 'admin' && userId !== undefined) {
      problem('userId', 'admin_only');
      return;
    }
    if (from && to && (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS)) {
      problem('to', 'range');
      return;
    }
    const scope: AuditScope = role === 'admin' ? { role: 'admin' } : { role: 'member', userId: callerId };
    const query: AuditQuery = { limit: limit ?? DEFAULT_LIMIT, cursor, userId, server, tool, outcomes: outcome, via, from, to };
    try {
      const page = await queryAudit(db, scope, query);
      res.json({ items: page.items.map(present), nextCursor: page.nextCursor });
    } catch (error) {
      logger.error('audit query failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
