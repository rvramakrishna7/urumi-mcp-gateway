import express from 'express';
import type { Response } from 'express';
import type { Database } from '../db/queryable.ts';
import type { Keyring } from '../crypto/credentials.ts';
import type { Logger } from '../logger.ts';
import { authenticate, authenticateKeyOrSession, identityOf, requireAdmin } from '../auth/middleware.ts';
import type { SessionAuthConfig } from '../auth/session.ts';
import { deleteServer, getServer, insertServer, listServers, patchServer, RegistryError } from '../registry/repository.ts';
import { listToolNamesByServer } from '../upstream/tools-repository.ts';
import { createAdminUsersRouter } from './admin-users.ts';
import { createServerSchema, describeIssues, patchServerSchema } from '../registry/validation.ts';

export interface AdminDeps {
  db: Database;
  keyring: Keyring;
  logger: Logger;
  now?: () => number;
  // When set, a dashboard session is accepted as well as an API key. Left out in tests of the API key only.
  sessions?: SessionAuthConfig;
  // Called after a server was created or changed (enabled, disabled, edited, new credential). It is not awaited, so a
  // slow or failing refresh cannot change the answer to the admin. It is the poller's refreshNow in production.
  onServerChanged?: () => Promise<unknown> | void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(res: Response, error: unknown, logger: Logger): void {
  if (error instanceof RegistryError) {
    res.status(error.code === 'conflict' ? 409 : 404).json({ error: error.code === 'conflict' ? 'conflict' : 'not found' });
    return;
  }
  // Only the class name: an error from the database or from the crypto code must not carry a value into a log.
  logger.error('admin request failed', { errorName: error instanceof Error ? error.name : 'unknown' });
  res.status(500).json({ error: 'internal error' });
}

// The admin API of the registry. Every route needs an API key or a session (401) and the admin role (403). The body is
// parsed only after both checks, so an unauthenticated caller cannot make the gateway parse anything.
export function createAdminRouter({ db, keyring, logger, now, sessions, onServerChanged }: AdminDeps): express.Router {
  // Starts the refresh and returns at once. A rejection (or a throw) is logged here: nobody awaits it, and an unhandled
  // rejection would stop the process.
  const refreshInBackground = (): void => {
    if (!onServerChanged) return;
    const failed = (error: unknown) => logger.error('refresh after a server change failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    try {
      Promise.resolve(onServerChanged()).catch(failed);
    } catch (error) {
      failed(error);
    }
  };
  const router = express.Router();
  router.use(sessions ? authenticateKeyOrSession({ db, logger, now, sessions }) : authenticate({ db, logger, now }), requireAdmin, express.json({ limit: '16kb' }));

  // The users and their keys need the origin of the dashboard for the invite link, so they exist only with sessions.
  if (sessions) router.use('/users', createAdminUsersRouter({ db, logger, publicOrigin: sessions.publicOrigin }));

  router.get('/servers', async (_req, res) => {
    try {
      res.json({ servers: await listServers(db) });
    } catch (error) {
      fail(res, error, logger);
    }
  });

  // The cached tool names of every server (read only, no call to an upstream).
  router.get('/tools', async (_req, res) => {
    try {
      res.json({ servers: await listToolNamesByServer(db) });
    } catch (error) {
      fail(res, error, logger);
    }
  });

  router.get('/servers/:id', async (req, res) => {
    try {
      const server = UUID.test(req.params.id) ? await getServer(db, req.params.id) : null;
      if (!server) throw new RegistryError('not_found', 'server not found');
      res.json({ server });
    } catch (error) {
      fail(res, error, logger);
    }
  });

  router.post('/servers', async (req, res) => {
    const parsed = createServerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: describeIssues(parsed.error) });
      return;
    }
    try {
      const server = await insertServer(db, keyring, parsed.data, { createdBy: identityOf(res).userId, seedManaged: false });
      logger.info('server registered', { slug: server.slug, by: identityOf(res).email });
      res.status(201).json({ server });
      refreshInBackground();
    } catch (error) {
      fail(res, error, logger);
    }
  });

  router.patch('/servers/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parsed = patchServerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: describeIssues(parsed.error) });
      return;
    }
    try {
      const server = await patchServer(db, keyring, req.params.id, parsed.data);
      // Field names only, never values.
      logger.info('server updated', { slug: server.slug, by: identityOf(res).email, fields: Object.keys(parsed.data).join(',') });
      res.json({ server });
      refreshInBackground();
    } catch (error) {
      fail(res, error, logger);
    }
  });

  router.delete('/servers/:id', async (req, res) => {
    try {
      const removed = UUID.test(req.params.id) ? await deleteServer(db, req.params.id) : false;
      if (!removed) throw new RegistryError('not_found', 'server not found');
      logger.info('server removed', { id: req.params.id, by: identityOf(res).email });
      res.status(204).end();
    } catch (error) {
      fail(res, error, logger);
    }
  });

  return router;
}
