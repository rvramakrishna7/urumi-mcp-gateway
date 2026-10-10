import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { checkDatabase, createPool } from './db/pool.ts';
import { createLogger } from './logger.ts';

const logger = createLogger();

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // ConfigError messages name the variable and never contain a value.
  logger.error('startup failed', { reason: error instanceof ConfigError ? error.message : 'unexpected error' });
  process.exit(1);
}

const pool = createPool(config.db, (error) => {
  logger.error('database connection error', { errorName: error.name });
});

const { app, beginShutdown } = createApp({ logger, checkDatabase: () => checkDatabase(pool) });
const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port });
});

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  beginShutdown();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
