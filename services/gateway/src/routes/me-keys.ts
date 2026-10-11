import express from 'express';
import { z } from 'zod';
import type { Database } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { authenticateSession, identityOf } from '../auth/middleware.ts';
import type { SessionAuthConfig } from '../auth/session.ts';
import { createKeyForUser, listKeysOfUser, revokeKeyForUser } from '../identity/repository.ts';
import type { KeyView } from '../identity/repository.ts';

export interface MeKeysDeps {
  db: Database;
  logger: Logger;
  sessions: SessionAuthConfig;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

function present(view: KeyView) {
  return {
    id: view.id,
    name: view.name,
    keyPrefix: view.keyPrefix,
    createdAt: view.createdAt,
    lastUsedAt: view.lastUsedAt,
    revokedAt: view.revokedAt,
    status: view.revokedAt ? 'revoked' : 'active',
  };
}

// The API keys of the logged-in user (docs/architecture.md, decision 35). Session only: an API key is never accepted here.
// The user id always comes from the session, never from the path, the query or the body, and every query has it in its
// WHERE clause, so one member cannot see or revoke the key of another. The plain key is in one response only.
export function createMeKeysRouter({ db, logger, sessions, now }: MeKeysDeps): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticateSession({ db, logger, sessions, now }));

  router.get('/keys', async (_req, res) => {
    try {
      const keys = await listKeysOfUser(db, identityOf(res).userId);
      res.json({ keys: keys.map(present) });
    } catch (error) {
      logger.error('list keys failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/keys', express.json({ limit: '4kb' }), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { userId } = identityOf(res);
    try {
      const result = await createKeyForUser(db, userId, parsed.data.name);
      if (!result.ok) {
        if (result.reason === 'limit') res.status(409).json({ error: 'key limit reached' });
        else res.status(401).json({ error: 'unauthorized' });
        return;
      }
      logger.info('api key created', { userId, keyId: result.view.id });
      res.status(201).json({ key: result.key, meta: present(result.view) });
    } catch (error) {
      logger.error('create key failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.delete('/keys/:id', async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID.test(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { userId } = identityOf(res);
    try {
      if (!(await revokeKeyForUser(db, userId, id))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      logger.info('api key revoked', { userId, keyId: id });
      res.status(204).end();
    } catch (error) {
      logger.error('revoke key failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
