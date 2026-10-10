import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createLogger } from './logger.ts';
import { WooClient } from './wooClient.ts';

const logger = createLogger();

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // ConfigError messages name the variable and never contain a value.
  logger.error('startup failed', { reason: error instanceof ConfigError ? error.message : 'unexpected error' });
  process.exit(1);
}

const woo = new WooClient({
  baseUrl: config.wooBaseUrl,
  publicUrl: config.wooPublicUrl,
  consumerKey: config.wooConsumerKey,
  consumerSecret: config.wooConsumerSecret,
  timeoutMs: config.wooRequestTimeoutMs,
});
const { app, beginShutdown } = createApp(config, logger, { woo, storeTimezone: config.storeTimezone, now: () => new Date() });
const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port });
});

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  beginShutdown();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
