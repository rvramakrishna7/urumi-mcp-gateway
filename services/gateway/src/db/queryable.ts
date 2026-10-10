import type pg from 'pg';

// What the repositories need: a pool or a single client. A transaction passes its client.
export type Queryable = Pick<pg.Pool, 'query'>;

// A pool, for code that needs a transaction.
export type Database = Pick<pg.Pool, 'query' | 'connect'>;

export async function withTransaction<T>(db: Database, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
