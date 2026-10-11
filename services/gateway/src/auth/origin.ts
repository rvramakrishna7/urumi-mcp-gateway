import type { Request, RequestHandler } from 'express';

// CSRF protection for requests that carry the session cookie (docs/architecture.md, decision 35), on top of
// SameSite=Strict. A browser sets Origin on every POST, PATCH and DELETE and a page cannot change it, so a request from
// another site cannot pass. A missing Origin is refused too: it is not a browser request from the dashboard.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isSafeMethod = (req: Request): boolean => SAFE_METHODS.has(req.method);

export const originMatches = (req: Request, publicOrigin: string): boolean => req.headers.origin === publicOrigin;

// For routes that must always check (login, accept-invite).
export function requireSameOrigin(publicOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (!originMatches(req, publicOrigin)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
