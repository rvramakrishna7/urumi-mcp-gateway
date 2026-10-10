import pg from 'pg';
import type { DbConfig } from '../config.ts';

// Settings shared by the pool of the server and the single client of the migration runner.
export function clientConfig(db: DbConfig): pg.ClientConfig {
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    application_name: 'gateway',
    connectionTimeoutMillis: 3000,
    // A query that runs for more than 30 s, or a transaction that sits idle for more than 60 s, is cancelled by the
    // server, so a bug cannot hold a connection (and its locks) for ever.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  };
}

export function createPool(db: DbConfig, onError: (error: Error) => void): pg.Pool {
  const pool = new pg.Pool({ ...clientConfig(db), max: db.poolMax, idleTimeoutMillis: 30_000 });
  // An idle connection can fail (for example when PostgreSQL restarts). Without this handler the process would crash.
  pool.on('error', onError);
  return pool;
}

// Used by /readyz: a trivial query with its own deadline. The result of a late answer is ignored.
export async function checkDatabase(pool: Pick<pg.Pool, 'query'>, timeoutMs = 2000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('database check timed out')), timeoutMs);
  });
  try {
    await Promise.race([pool.query('SELECT 1'), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
