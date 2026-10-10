import { createApp } from './app.ts';
import { ConfigError, loadConfig, loadSecurityConfig } from './config.ts';
import type { Config, SecurityConfig } from './config.ts';
import { CryptoError, loadKeyring } from './crypto/credentials.ts';
import type { Keyring } from './crypto/credentials.ts';
import { checkDatabase, createPool } from './db/pool.ts';
import { createLogger } from './logger.ts';
import { applySeed, loadSeedFile, SeedError } from './registry/seed.ts';

const logger = createLogger();

let config: Config;
let security: SecurityConfig;
let keyring: Keyring;
try {
  config = loadConfig();
  security = loadSecurityConfig();
  // The master key must be exactly 32 bytes. A wrong or missing key stops the start with a clear reason.
  keyring = loadKeyring(security.masterKeyFile, security.masterKeyId);
} catch (error) {
  // These messages name the variable and never contain a value.
  const known = error instanceof ConfigError || error instanceof CryptoError;
  logger.error('startup failed', { reason: known ? error.message : 'unexpected error' });
  process.exit(1);
}

const pool = createPool(config.db, (error) => {
  logger.error('database connection error', { errorName: error.name });
});

// The seed runs before the server listens, so the registry is complete when the first request arrives. A seed that
// cannot be applied stops the start: it is a configuration error that an operator must see.
try {
  if (security.seedFile) await applySeed(pool, keyring, loadSeedFile(security.seedFile), logger);
} catch (error) {
  logger.error('startup failed', { reason: error instanceof SeedError ? error.message : 'the seed could not be applied', errorName: error instanceof Error ? error.name : 'unknown' });
  process.exit(1);
}

const { app, beginShutdown } = createApp({ logger, checkDatabase: () => checkDatabase(pool), admin: { db: pool, keyring, logger } });
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
