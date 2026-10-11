import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Logger } from './logger.ts';
import { createAdminRouter } from './routes/admin.ts';
import type { AdminDeps } from './routes/admin.ts';
import type { Router } from 'express';

export interface AppDeps {
  logger: Logger;
  // Resolves when the database answers and rejects when it does not.
  checkDatabase: () => Promise<void>;
  // The registry admin API. Left out in tests of the health routes only.
  admin?: AdminDeps;
  // The public MCP endpoint, mounted at /mcp with its own Host check, authentication and body limit.
  mcp?: Router;
  // Login, logout and the current session, mounted at /api/auth.
  auth?: Router;
}

export interface GatewayApp {
  app: express.Express;
  // Makes /readyz answer 503 so that the Service stops sending traffic before the process exits.
  beginShutdown: () => void;
}

export function createApp({ logger, checkDatabase, admin, mcp, auth }: AppDeps): GatewayApp {
  const app = express();
  app.disable('x-powered-by');
  let shuttingDown = false;

  // One log line per request: method, path without the query string, status and duration.
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const start = process.hrtime.bigint();
    const { method, path } = req;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
      logger.info('request', { requestId, method, path, status: res.statusCode, durationMs });
    });
    next();
  });

  // Liveness never depends on the database or on an upstream: a database outage must not restart a healthy process
  // (docs/architecture.md, decision 14).
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness depends on the database, because the gateway cannot serve anything without it. It never depends on an
  // upstream MCP server: a slow or dead upstream must not take the gateway out of the Service.
  app.get('/readyz', async (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    try {
      await checkDatabase();
      res.json({ status: 'ready' });
    } catch {
      // The reason is not sent to the caller. The kubelet only needs the status code.
      res.status(503).json({ status: 'database-unavailable' });
    }
  });

  if (mcp) app.use('/mcp', mcp);
  if (auth) app.use('/api/auth', auth);
  if (admin) app.use('/api/admin', createAdminRouter(admin));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Express would otherwise answer with an HTML page (and a stack trace outside production).
  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) {
      logger.error('unhandled error', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
    res.status(status).json({ error: status < 500 ? 'bad request' : 'internal error' });
  };
  app.use(onError);

  return {
    app,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}
