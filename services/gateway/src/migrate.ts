// Entry point of the migration runner. It runs in the initContainer of the gateway pod, before the server starts.
import pg from 'pg';
import { ConfigError, loadDbConfig } from './config.ts';
import { clientConfig } from './db/pool.ts';
import { loadMigrationFiles, MigrationError, runMigrations } from './db/migrate.ts';
import { createLogger } from './logger.ts';

const logger = createLogger();
const ATTEMPTS = 60;
const DELAY_MS = 2000;

// PostgreSQL may still be starting when this pod starts (after an install, or after a node restart).
async function connectWithRetry(config: pg.ClientConfig): Promise<pg.Client> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const client = new pg.Client(config);
    // A connection that fails later must not crash the process with an unhandled event.
    client.on('error', () => {});
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      const code = (error as { code?: unknown }).code;
      if (attempt === ATTEMPTS) throw new MigrationError('the database is not reachable');
      if (attempt === 1 || attempt % 5 === 0) {
        logger.info('waiting for the database', { attempt, code: typeof code === 'string' ? code : undefined });
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
  throw new MigrationError('the database is not reachable');
}

try {
  const db = loadDbConfig();
  const files = await loadMigrationFiles();
  const client = await connectWithRetry(clientConfig(db));
  try {
    const result = await runMigrations(client, files, logger);
    logger.info('migrations done', { applied: result.applied.length, alreadyApplied: result.alreadyApplied.length, unknown: result.unknown.length });
  } finally {
    await client.end().catch(() => {});
  }
} catch (error) {
  // Both error classes carry messages that name a variable or a migration and never a value.
  const known = error instanceof ConfigError || error instanceof MigrationError;
  logger.error('migration failed', { reason: known ? error.message : 'unexpected error', errorName: error instanceof Error ? error.name : undefined });
  process.exit(1);
}
