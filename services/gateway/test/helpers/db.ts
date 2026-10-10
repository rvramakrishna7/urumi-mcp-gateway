import { randomBytes } from 'node:crypto';
import pg from 'pg';

// The database tests need a real PostgreSQL. "npm run test:db" starts one in Docker and sets these variables.
// Without them the database tests are skipped, so plain "npm test" works without Docker.
export const dbAvailable = Boolean(process.env.TEST_DB_PORT);
export const skipWithoutDb = dbAvailable ? false : 'needs PostgreSQL (run: npm run test:db)';

function config(database: string): pg.ClientConfig {
  return {
    host: process.env.TEST_DB_HOST,
    port: Number(process.env.TEST_DB_PORT),
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD,
    database,
  };
}

export interface TestDatabase {
  name: string;
  connect: () => Promise<pg.Client>;
  pool: () => pg.Pool;
  drop: () => Promise<void>;
}

// Every test file gets its own database, so files can run in parallel and never see each other's rows.
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `gw_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client(config('postgres'));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const open: pg.Client[] = [];
  const pools: pg.Pool[] = [];
  return {
    name,
    connect: async () => {
      const client = new pg.Client(config(name));
      await client.connect();
      open.push(client);
      return client;
    },
    pool: () => {
      const pool = new pg.Pool({ ...config(name), max: 4 });
      pools.push(pool);
      return pool;
    },
    drop: async () => {
      await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
      await Promise.all(open.map((client) => client.end().catch(() => {})));
      const dropper = new pg.Client(config('postgres'));
      await dropper.connect();
      await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await dropper.end();
    },
  };
}
