import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

// Comparing SHA-256 digests gives both sides the same length, so timingSafeEqual never throws
// and the comparison time does not reveal the length of the real token.
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function bearerAuth(expectedToken: string): RequestHandler {
  const expected = digest(expectedToken);
  return (req, res, next) => {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    const presented = digest(match?.[1] ?? '');
    const valid = timingSafeEqual(presented, expected) && match !== null;
    if (!valid) {
      // Missing, malformed and wrong tokens get the same answer.
      res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
