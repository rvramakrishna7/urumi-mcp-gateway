import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { hashApiKey, looksLikeApiKey } from '../identity/keys.ts';
import { findActiveKey, touchApiKey } from '../identity/repository.ts';
import type { ApiKeyIdentity } from '../identity/repository.ts';

// The caller of a request, set by authenticate() and read through callerOf().
const CALLER = 'caller';
const TOUCH_INTERVAL_MS = 60_000;

export interface AuthDeps {
  db: Queryable;
  logger: Logger;
  // Injected so that a test can move the clock.
  now?: () => number;
}

export function callerOf(res: Response): ApiKeyIdentity {
  return res.locals[CALLER] as ApiKeyIdentity;
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

    const time = now();
    const last = lastTouch.get(identity.keyId);
    if (last === undefined || time - last >= TOUCH_INTERVAL_MS) {
      lastTouch.set(identity.keyId, time);
      touchApiKey(db, identity.keyId).catch(() => logger.warn('last_used_at update failed'));
    }
    next();
  };
}

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (callerOf(res).role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
};
