import express from 'express';
import { z } from 'zod';
import type { Database } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import { authenticateSession, identityOf } from '../auth/middleware.ts';
import type { SessionAuthConfig } from '../auth/session.ts';
import { InvalidConfirmationError } from '../chat/agent.ts';
import type { Agent } from '../chat/agent.ts';
import { GroqError } from '../chat/groq.ts';
import { reserveChatRequest } from '../chat/rate.ts';

export interface ChatRouterDeps {
  db: Database;
  logger: Logger;
  sessions: SessionAuthConfig;
  // Undefined when no Groq key is configured: the route then answers 503 and the rest of the gateway is unchanged.
  agent: Agent | undefined;
  ratePerMinute: number;
  now?: () => number;
}

export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TOTAL_CHARS = 16_000;
const MAX_RETRY_AFTER_SECONDS = 3600;

const message = z.strictObject({
  // "system" and "tool" are not accepted: the client cannot write the system prompt or forge a tool result.
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_MESSAGE_CHARS).refine((text) => text.trim().length > 0, 'blank'),
});

const confirm = z.strictObject({
  token: z.string().min(1).max(100),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  args: z.record(z.string(), z.unknown()),
});

const bodySchema = z
  .strictObject({
    messages: z.array(message).min(1).max(MAX_MESSAGES),
    confirm: confirm.optional(),
  })
  .refine((body) => body.messages.at(-1)?.role === 'user', { message: 'the last message must be from the user' })
  .refine((body) => body.messages.reduce((sum, item) => sum + item.content.length, 0) <= MAX_TOTAL_CHARS, { message: 'too long' });

// The chat agent for the dashboard (docs/architecture.md, decision 40). Session only: an API key is never accepted here, and
// the route is not for external MCP clients. The user comes from the session and nothing in the body can change it. Every
// answer is fixed text: nothing from Groq, from a tool or from an error reaches the browser.
export function createChatRouter({ db, logger, sessions, agent, ratePerMinute, now }: ChatRouterDeps): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticateSession({ db, logger, sessions, now }));

  router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
    // Not configured is checked before anything is counted: a request that cannot be served must not use the quota.
    if (!agent) {
      res.status(503).json({ error: 'chat not configured' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }

    const identity = identityOf(res);
    // The attempt is reserved before the model is asked. If the database cannot say, the request is refused (fail closed).
    try {
      const decision = await reserveChatRequest(db, identity.userId, ratePerMinute);
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        res.status(429).json({ error: 'too many requests' });
        return;
      }
    } catch (error) {
      logger.error('chat rate limit failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(503).json({ error: 'service unavailable' });
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await agent.runTurn({ userId: identity.userId, email: identity.email, role: identity.role }, parsed.data.messages, parsed.data.confirm);
      logger.info('chat turn', { userId: identity.userId, toolCalls: result.toolCalls.length, pending: result.pending !== undefined, durationMs: Date.now() - startedAt });
      res.json({ reply: result.reply, toolCalls: result.toolCalls, ...(result.pending ? { pending: result.pending } : {}) });
    } catch (error) {
      if (error instanceof InvalidConfirmationError) {
        res.status(400).json({ error: 'invalid confirmation' });
        return;
      }
      if (error instanceof GroqError) {
        // Only the kind is logged: never a body, a header or the key.
        logger.warn('chat model call failed', { userId: identity.userId, kind: error.kind });
        switch (error.kind) {
          case 'rate_limited':
            if (error.retryAfterSeconds !== null) res.setHeader('Retry-After', String(Math.min(error.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS)));
            res.status(429).json({ error: 'model rate limited' });
            return;
          case 'timeout':
            res.status(504).json({ error: 'model timeout' });
            return;
          case 'bad_request':
            res.status(502).json({ error: 'model rejected the request' });
            return;
          case 'auth':
            // The key was refused: that is a deployment problem, not something the user can fix or should see.
            logger.error('the model service refused the configured key');
            res.status(502).json({ error: 'model unavailable' });
            return;
          default:
            res.status(502).json({ error: 'model unavailable' });
            return;
        }
      }
      logger.error('chat turn failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
