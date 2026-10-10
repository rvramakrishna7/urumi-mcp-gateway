import express from 'express';
import type { Queryable } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { authenticate, callerOf, requireAdmin } from '../auth/middleware.ts';
import type { Gateway } from '../core/gateway.ts';
import type { Poller } from '../upstream/poller.ts';

export interface DebugDeps {
  db: Queryable;
  gateway: Gateway;
  poller: Poller;
  logger: Logger;
  now?: () => number;
}

// TEMPORARY (Step 8d): admin-only routes to exercise listTools and callTool before the public /mcp endpoint exists.
// They are removed in 8e. The caller is always the admin whose key was used, so a call is audited under that admin.
export function createDebugRouter({ db, gateway, poller, logger, now }: DebugDeps): express.Router {
  const router = express.Router();
  router.use(authenticate({ db, logger, now }), requireAdmin, express.json({ limit: '64kb' }));

  router.get('/tools', async (_req, res) => {
    try {
      res.json({ tools: await gateway.listTools({ userId: callerOf(res).userId, email: callerOf(res).email, via: 'mcp' }) });
    } catch (error) {
      logger.error('debug list failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/call', async (req, res) => {
    const { name, arguments: args } = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
    const plainArgs = args === undefined ? {} : args;
    if (typeof name !== 'string' || typeof plainArgs !== 'object' || plainArgs === null || Array.isArray(plainArgs)) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    try {
      const caller = callerOf(res);
      res.json(await gateway.callTool({ userId: caller.userId, email: caller.email, via: 'mcp' }, name, plainArgs as Record<string, unknown>));
    } catch (error) {
      logger.error('debug call failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/refresh', async (_req, res) => {
    res.json({ servers: await poller.refreshNow() });
  });

  return router;
}
