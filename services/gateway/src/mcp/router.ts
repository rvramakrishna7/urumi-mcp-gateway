import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Queryable } from '../db/queryable.ts';
import type { Logger } from '../logger.ts';
import type { Gateway } from '../core/gateway.ts';
import { authenticate, callerOf } from '../auth/middleware.ts';
import { authInfoFor, createMcpServerFactory } from './server.ts';

// A tools/call carries small JSON arguments. Anything bigger is refused before it is parsed.
export const MAX_BODY_BYTES = 100 * 1024;

export interface McpRouterDeps {
  db: Queryable;
  gateway: Gateway;
  logger: Logger;
  // Host names (without port) that this endpoint answers to. It protects against DNS rebinding.
  allowedHosts: string[];
  now?: () => number;
}

export interface McpRouter {
  router: express.Router;
  close: () => Promise<void>;
}

// The public MCP endpoint. Order matters: Host check, then the API key (checked in the database on every request,
// so a revoked key fails on its next one), and only then the body is read.
export function createMcpRouter({ db, gateway, logger, allowedHosts, now }: McpRouterDeps): McpRouter {
  // Default mode: 2026-07-28 clients and 2025-era clients (MCP Inspector) are served on the same URL (decision 32).
  const handler = createMcpHandler(createMcpServerFactory(gateway), {
    onerror: (error) => logger.error('mcp handler error', { errorName: error.name }),
  });
  const serve = toNodeHandler(handler, {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => logger.error('mcp adapter error', { errorName: error.name }),
  });

  const checkHost = hostHeaderValidation(allowedHosts);
  const hostGuard: RequestHandler = (req, res, next) => {
    if (checkHost(req, res)) next();
  };

  // Hands the identity of the key to the SDK. The key itself stays out of it.
  const passIdentity: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    (req as Request & { auth?: AuthInfo }).auth = authInfoFor(callerOf(res));
    next();
  };

  const router = express.Router();
  router.use(hostGuard, authenticate({ db, logger, now }), passIdentity, express.json({ limit: MAX_BODY_BYTES }));
  router.all('/', (req, res, next) => {
    serve(req, res, req.body).catch(next);
  });

  return { router, close: () => handler.close() };
}
