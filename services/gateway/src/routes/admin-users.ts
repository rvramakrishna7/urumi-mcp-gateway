import express from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import type { Database } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { identityOf } from '../auth/middleware.ts';
import { createInvitedMember, issueInviteWithExpiry } from '../identity/invites.ts';
import { findUserForAdmin, listKeysOfUser, listUsersForAdmin, revokeKeyForUser, setUserStatus } from '../identity/repository.ts';
import type { AdminUserView, KeyView } from '../identity/repository.ts';

export interface AdminUsersDeps {
  db: Database;
  logger: Logger;
  // The origin of the dashboard, for the invite link. The token is in the fragment, so it never reaches a server log.
  publicOrigin: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// No "role" field exists: .strict() turns a request that names one into a 400 (the admin API makes members only).
const createSchema = z.object({ email: z.string().trim().min(3).max(254) }).strict();
const statusSchema = z.object({ status: z.enum(['active', 'disabled']) }).strict();

function presentUser(user: AdminUserView) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    disabledAt: user.disabledAt,
  };
}

function presentKey(view: KeyView) {
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

function internalError(res: Response, logger: Logger, what: string, error: unknown): void {
  // Only the class name: an error from the database must not carry a value into a log.
  logger.error(what, { errorName: error instanceof Error ? error.name : 'unknown' });
  res.status(500).json({ error: 'internal error' });
}

// The users and the keys of other users, for an admin (docs/architecture.md, decisions 35 and 36). It is mounted inside the
// admin router, which has already checked the API key or the session, the admin role and the JSON body limit. An admin acts
// on another user's keys only here, with the user id from the path in the WHERE clause next to the key id.
// An invite token is in the response of one request only and is never logged.
export function createAdminUsersRouter({ db, logger, publicOrigin }: AdminUsersDeps): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const presentInvite = (invite: { token: string; expiresAt: Date }) => ({
    token: invite.token,
    link: `${publicOrigin}/accept-invite#token=${invite.token}`,
    expiresAt: invite.expiresAt,
  });

  router.get('/', async (_req, res) => {
    try {
      res.json({ users: (await listUsersForAdmin(db)).map(presentUser) });
    } catch (error) {
      internalError(res, logger, 'list users failed', error);
    }
  });

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { userId } = identityOf(res);
    try {
      const result = await createInvitedMember(db, parsed.data.email, userId);
      if (!result.ok) {
        if (result.reason === 'exists') res.status(409).json({ error: 'conflict' });
        else res.status(400).json({ error: 'invalid request' });
        return;
      }
      logger.info('member invited', { by: userId, userId: result.user.id });
      res.status(201).json({ user: result.user, invite: presentInvite(result.invite) });
    } catch (error) {
      internalError(res, logger, 'create member failed', error);
    }
  });

  router.post('/:id/invite', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const target = await findUserForAdmin(db, id);
      if (!target) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      // A new invite is a password reset. If one admin could reset another admin, they could take over that account and act
      // under that name in the audit log, so the password of an admin is reset with the command-line tool only.
      if (target.role === 'admin') {
        res.status(409).json({ error: 'conflict', reason: 'the password of an admin is reset with the command-line tool' });
        return;
      }
      const invite = await issueInviteWithExpiry(db, id);
      if (!invite) {
        res.status(409).json({ error: 'conflict', reason: 'the user is disabled' });
        return;
      }
      logger.info('invite issued', { by: identityOf(res).userId, userId: id });
      res.status(201).json({ invite: presentInvite(invite) });
    } catch (error) {
      internalError(res, logger, 'issue invite failed', error);
    }
  });

  router.patch('/:id', async (req, res) => {
    const id = req.params.id;
    const parsed = statusSchema.safeParse(req.body);
    if (!UUID.test(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const caller = identityOf(res).userId;
    if (parsed.data.status === 'disabled' && id === caller) {
      res.status(409).json({ error: 'conflict', reason: 'you cannot disable yourself' });
      return;
    }
    try {
      const result = await setUserStatus(db, id, parsed.data.status);
      if (!result.ok) {
        if (result.reason === 'not_found') res.status(404).json({ error: 'not found' });
        else res.status(409).json({ error: 'conflict', reason: 'the last active admin cannot be disabled' });
        return;
      }
      logger.info('user status set', { by: caller, userId: id, status: result.user.status });
      res.json({ user: presentUser(result.user) });
    } catch (error) {
      internalError(res, logger, 'set user status failed', error);
    }
  });

  router.get('/:id/keys', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      if (!(await findUserForAdmin(db, id))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ keys: (await listKeysOfUser(db, id)).map(presentKey) });
    } catch (error) {
      internalError(res, logger, 'list keys of a user failed', error);
    }
  });

  // The key id and the user id are both in the SQL: a key of someone else under this path is a 404 and stays as it was.
  router.delete('/:id/keys/:keyId', async (req, res) => {
    const { id, keyId } = req.params;
    if (!UUID.test(id) || !UUID.test(keyId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      if (!(await revokeKeyForUser(db, id, keyId))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      logger.info('api key revoked by an admin', { by: identityOf(res).userId, userId: id, keyId });
      res.status(204).end();
    } catch (error) {
      internalError(res, logger, 'revoke key of a user failed', error);
    }
  });

  return router;
}
