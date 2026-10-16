import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { bearerAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { createMcpServer } from './server.ts';
import type { ToolDeps } from './tools/common.ts';

export interface FxMcpApp {
  app: express.Express;
  // Makes /readyz answer 503 so that the Service stops sending traffic before the process exits.
  beginShutdown: () => void;
}

export function createApp(config: Pick<Config, 'allowedHosts' | 'mcpAuthToken'>, logger: Logger, tools: ToolDeps): FxMcpApp {
  const app = express();
  app.disable('x-powered-by');
  let shuttingDown = false;

  // One log line per request: method, path without the query string, status and duration.
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const start = process.hrtime.bigint();
    // Read the path now: inside a mounted router, req.path is relative to the mount point.
    const { method, path } = req;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
      logger.info('request', { requestId, method, path, status: res.statusCode, durationMs });
    });
    next();
  });

  // Health routes come before the Host check and the token check: the kubelet probes the pod IP, and the
  // probes carry no credential.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    res.json({ status: 'ready' });
  });

  // Order matters: Host check, then token, and only then the body is read.
  const mcp = express.Router();
  mcp.use(hostHeaderValidation(config.allowedHosts), bearerAuth(config.mcpAuthToken), express.json({ limit: '100kb' }));

  mcp.post('/', async (req, res) => {
    const server = createMcpServer(tools, logger);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('mcp request failed', { error: error instanceof Error ? error.name : 'unknown' });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // Stateless server: there is no event stream to open and no session to close.
  mcp.all('/', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'method not allowed' });
  });
  app.use('/mcp', mcp);

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
      logger.error('unhandled error', { error: error instanceof Error ? error.name : 'unknown' });
    }
    res.status(status).json({ error: status === 413 ? 'payload too large' : status < 500 ? 'bad request' : 'internal error' });
  };
  app.use(onError);

  return {
    app,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}
