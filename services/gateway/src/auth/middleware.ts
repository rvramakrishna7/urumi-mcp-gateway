import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { hashApiKey, looksLikeApiKey } from '../identity/keys.ts';
import { findActiveKey, touchApiKey } from '../identity/repository.ts';
import type { ApiKeyIdentity, Role } from '../identity/repository.ts';
import { isSafeMethod, originMatches } from './origin.ts';
import { findSession, hashSessionToken, sessionTokenFromCookieHeader, touchSession } from './session.ts';
import type { SessionAuthConfig, SessionIdentity } from './session.ts';

// The caller of a request, set by authenticate() and read through callerOf(). Only an API key sets it.
const CALLER = 'caller';
// Who the request acts as, whether by API key or by session. Read through identityOf().
const IDENTITY = 'identity';
const SESSION = 'session';
const TOUCH_INTERVAL_MS = 60_000;

export interface AuthDeps {
  db: Queryable;
  logger: Logger;
  // Injected so that a test can move the clock.
  now?: () => number;
}

export interface SessionAuthDeps extends AuthDeps {
  sessions: SessionAuthConfig;
}

export interface Identity {
  userId: string;
  email: string;
  role: Role;
}

export function callerOf(res: Response): ApiKeyIdentity {
  return res.locals[CALLER] as ApiKeyIdentity;
}

export function identityOf(res: Response): Identity {
  return res.locals[IDENTITY] as Identity;
}

// Set only when the request was authenticated by a session cookie.
export function sessionOf(res: Response): SessionIdentity | undefined {
  return res.locals[SESSION] as SessionIdentity | undefined;
}

function unauthorized(res: Response): void {
  // One answer for a missing, malformed, unknown or revoked key: the caller learns nothing about which it was.
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.status(401).json({ error: 'unauthorized' });
}

// Checks the key against the database on every request, so a revoked key stops working on its next request.
// The key is read from the Authorization header only, never from the URL or the body, and is never logged.
export function authenticate({ db, logger, now = Date.now }: AuthDeps): RequestHandler {
  // When last_used_at was written for a key by this process. It keeps the write to at most one per minute per key
  // without a query on every request; the UPDATE has the same guard in SQL for the case of several pods.
  const lastTouch = new Map<string, number>();

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match || !looksLikeApiKey(match[1])) {
      unauthorized(res);
      return;
    }
    let identity: ApiKeyIdentity | null;
    try {
      identity = await findActiveKey(db, hashApiKey(match[1]));
    } catch {
      logger.error('authentication lookup failed');
      res.status(503).json({ error: 'service unavailable' });
      return;
    }
    if (!identity) {
      unauthorized(res);
      return;
    }
    res.locals[CALLER] = identity;
    res.locals[IDENTITY] = { userId: identity.userId, email: identity.email, role: identity.role } satisfies Identity;

    const time = now();
    const last = lastTouch.get(identity.keyId);
    if (last === undefined || time - last >= TOUCH_INTERVAL_MS) {
      lastTouch.set(identity.keyId, time);
      touchApiKey(db, identity.keyId).catch(() => logger.warn('last_used_at update failed'));
    }
    next();
  };
}

// The session of the dashboard (docs/architecture.md, decision 35). Only the cookie is read: a request that carries an
// Authorization header is refused here, because an API key is never a browser login. A request that changes something
// must also come from the dashboard's own origin (CSRF), which is checked before the database is asked.
export function authenticateSession({ db, logger, sessions, now = Date.now }: SessionAuthDeps): RequestHandler {
  const lastTouch = new Map<string, number>();

  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization === undefined ? sessionTokenFromCookieHeader(req.headers.cookie, sessions.cookie) : null;
    if (!isSafeMethod(req) && !originMatches(req, sessions.publicOrigin)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    let session: SessionIdentity | null;
    try {
      session = await findSession(db, hashSessionToken(token));
    } catch {
      logger.error('session lookup failed');
      res.status(503).json({ error: 'service unavailable' });
      return;
    }
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals[SESSION] = session;
    res.locals[IDENTITY] = { userId: session.userId, email: session.email, role: session.role } satisfies Identity;

    const time = now();
    const last = lastTouch.get(session.sessionId);
    if (last === undefined || time - last >= TOUCH_INTERVAL_MS) {
      lastTouch.set(session.sessionId, time);
      touchSession(db, session.sessionId).catch(() => logger.warn('last_seen_at update failed'));
    }
    next();
  };
}

// For routes that both a script (an API key) and the dashboard (a session) may call. If an Authorization header is
// present only the API key is considered, so a wrong key is 401 and never falls back to a cookie.
export function authenticateKeyOrSession(deps: SessionAuthDeps): RequestHandler {
  const byKey = authenticate(deps);
  const bySession = authenticateSession(deps);
  return (req, res, next) => (req.headers.authorization !== undefined ? byKey(req, res, next) : bySession(req, res, next));
}

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (identityOf(res).role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
};
