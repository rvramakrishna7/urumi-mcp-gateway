import express from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import type { Database } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { authenticateSession, identityOf, sessionOf } from '../auth/middleware.ts';
import { requireSameOrigin } from '../auth/origin.ts';
import { verifyOrDummy } from '../auth/password.ts';
import { createSession, deleteSession, sessionClearCookie, sessionSetCookie } from '../auth/session.ts';
import type { SessionAuthConfig } from '../auth/session.ts';
import { clearFailures, emailThrottleKey, lockedSeconds, recordFailure } from '../auth/throttle.ts';
import { findUserForLogin, markLogin } from '../identity/repository.ts';
import { acceptInvite } from '../identity/invites.ts';

export interface AuthRouterDeps {
  db: Database;
  logger: Logger;
  sessions: SessionAuthConfig;
  now?: () => number;
}

const loginSchema = z.object({
  email: z.string().min(3).max(254),
  // Long enough for any real password (the limit for a new one is 128), short enough to bound the work of one request.
  password: z.string().min(1).max(1024),
});

const acceptSchema = z.object({
  token: z.string().min(1).max(100),
  password: z.string().min(1).max(1024),
});

const INVALID_CREDENTIALS = { error: 'invalid credentials' };

function tooManyAttempts(res: Response, seconds: number): void {
  res.setHeader('Retry-After', String(seconds));
  res.status(429).json({ error: 'too many attempts' });
}

// Login and the state of the current session (docs/architecture.md, decision 35). Nothing here is cached, and no log line
// holds an email, a password or a cookie.
export function createAuthRouter({ db, logger, sessions, now }: AuthRouterDeps): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // The origin is checked first and the body is read only after it, so a request from another site is not even parsed.
  router.post('/login', requireSameOrigin(sessions.publicOrigin), express.json({ limit: '4kb' }), async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { email, password } = parsed.data;
    try {
      const key = emailThrottleKey(email);
      const locked = await lockedSeconds(db, key);
      if (locked > 0) {
        logger.warn('login refused', { reason: 'locked' });
        tooManyAttempts(res, locked);
        return;
      }
      const user = await findUserForLogin(db, email);
      // An unknown email, a user without a password and a disabled user all take the same path as a wrong password.
      const usable = user !== null && user.status === 'active' ? user : null;
      const accepted = await verifyOrDummy(password, usable?.passwordHash ?? null);
      if (!accepted || !usable) {
        await recordFailure(db, key);
        logger.warn('login failed', { reason: 'bad_credentials' });
        res.status(401).json(INVALID_CREDENTIALS);
        return;
      }
      await clearFailures(db, key);
      const { token } = await createSession(db, usable.id);
      await markLogin(db, usable.id);
      res.setHeader('Set-Cookie', sessionSetCookie(sessions.cookie, token));
      logger.info('login ok', { userId: usable.id });
      res.json({ user: { id: usable.id, email: usable.email, role: usable.role } });
    } catch (error) {
      logger.error('login request failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Sets the password of the person whom the invite belongs to and signs them in. The token is the proof of identity: it has
  // 256 bits of randomness, so guessing it is not possible and the route needs no throttle (the slow hash runs only after
  // a valid token). Every wrong, expired, used or disabled-user token gets the same answer.
  router.post('/accept-invite', requireSameOrigin(sessions.publicOrigin), express.json({ limit: '4kb' }), async (req, res) => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    try {
      const result = await acceptInvite(db, parsed.data.token, parsed.data.password);
      if (!result.ok) {
        logger.warn('invite refused', { reason: result.reason });
        if (result.reason === 'weak') res.status(400).json({ error: 'weak password', reason: result.problem });
        else res.status(400).json({ error: 'invalid or expired invite' });
        return;
      }
      const { token } = await createSession(db, result.user.id);
      res.setHeader('Set-Cookie', sessionSetCookie(sessions.cookie, token));
      logger.info('invite accepted', { userId: result.user.id });
      res.json({ user: result.user });
    } catch (error) {
      logger.error('accept-invite request failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  const session = authenticateSession({ db, logger, sessions, now });

  router.post('/logout', session, async (_req, res) => {
    try {
      await deleteSession(db, sessionOf(res)!.sessionId);
      res.setHeader('Set-Cookie', sessionClearCookie(sessions.cookie));
      res.status(204).end();
    } catch (error) {
      logger.error('logout request failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/me', session, (_req, res) => {
    const { userId, email, role } = identityOf(res);
    res.json({ user: { id: userId, email, role }, session: { expiresAt: sessionOf(res)!.expiresAt } });
  });

  return router;
}
