import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { createLogger } from '../src/logger.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { CHAT_RATE_WINDOW_SECONDS, reserveChatRequest } from '../src/chat/rate.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const CAP = 10;
const FOREIGN_KEY = '23503';
const CHECK = '23514';

describe('migration 0005 and the chat rate limit (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let client: pg.Client;
  let pool: pg.Pool;
  let usersBefore = '';

  before(async () => {
    db = await createTestDatabase();
    client = await db.connect();
    const files = await loadMigrationFiles();
    // A user exists before this migration, as on the local cluster.
    await runMigrations(client, files.filter((file) => file.version < '0005'), createLogger(() => {}));
    await client.query("INSERT INTO users (email, role, status) VALUES ('old-admin@example.test', 'admin', 'active')");
    usersBefore = JSON.stringify((await client.query('SELECT id, email, role, status FROM users ORDER BY email')).rows);
    await runMigrations(client, files, createLogger(() => {}));
    pool = db.pool();
  });
  after(async () => {
    await db.drop();
  });

  const newUser = async (email: string) => (await client.query<{ id: string }>("INSERT INTO users (email, role, status) VALUES ($1, 'member', 'active') RETURNING id", [email])).rows[0]!.id;
  const count = async (userId: string) => (await client.query<{ count: number }>('SELECT count FROM chat_rate WHERE user_id = $1', [userId])).rows[0]?.count;
  const expireWindow = (userId: string, seconds: number) => client.query('UPDATE chat_rate SET window_start = now() - make_interval(secs => $2::double precision) WHERE user_id = $1', [userId, seconds]);
  const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

  test('the migration is recorded, the table is empty, and the user that existed is unchanged', async () => {
    assert.equal((await client.query("SELECT 1 FROM schema_migrations WHERE version = '0005_chat_rate'")).rowCount, 1);
    assert.equal((await client.query('SELECT count(*)::int AS c FROM chat_rate')).rows[0].c, 0);
    assert.equal(JSON.stringify((await client.query("SELECT id, email, role, status FROM users WHERE email = 'old-admin@example.test'")).rows), usersBefore);
    const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_rate' ORDER BY column_name")).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['count', 'user_id', 'window_start']);
  });

  test('the first CAP requests pass and the next is refused with a Retry-After inside the window', async () => {
    const user = await newUser('seq@example.test');
    for (let i = 1; i <= CAP; i += 1) assert.equal((await reserveChatRequest(pool, user, CAP)).allowed, true, `request ${i}`);
    const refused = await reserveChatRequest(pool, user, CAP);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= CHAT_RATE_WINDOW_SECONDS, String(refused.retryAfterSeconds));
  });

  test('the counter stops at the cap plus one, and refused requests do not extend the window', async () => {
    const user = await newUser('bound@example.test');
    for (let i = 0; i < CAP + 25; i += 1) await reserveChatRequest(pool, user, CAP);
    assert.equal(await count(user), CAP + 1);
    const started = (await client.query('SELECT window_start FROM chat_rate WHERE user_id = $1', [user])).rows[0].window_start;
    await reserveChatRequest(pool, user, CAP);
    assert.deepEqual((await client.query('SELECT window_start FROM chat_rate WHERE user_id = $1', [user])).rows[0].window_start, started);
  });

  test('users are counted separately', async () => {
    const a = await newUser('sep-a@example.test');
    const b = await newUser('sep-b@example.test');
    for (let i = 0; i < CAP + 3; i += 1) await reserveChatRequest(pool, a, CAP);
    assert.equal((await reserveChatRequest(pool, a, CAP)).allowed, false);
    assert.equal((await reserveChatRequest(pool, b, CAP)).allowed, true);
  });

  test('a window of 59 seconds still refuses, one of 61 seconds starts again at one', async () => {
    const user = await newUser('window@example.test');
    for (let i = 0; i < CAP + 1; i += 1) await reserveChatRequest(pool, user, CAP);
    await expireWindow(user, 59);
    const still = await reserveChatRequest(pool, user, CAP);
    assert.equal(still.allowed, false);
    assert.ok(still.retryAfterSeconds <= 1, String(still.retryAfterSeconds));
    await expireWindow(user, 61);
    assert.equal((await reserveChatRequest(pool, user, CAP)).allowed, true);
    assert.equal(await count(user), 1);
  });

  test('a burst of 50 parallel requests of one user lets exactly CAP pass, in 8 of 8 rounds', async () => {
    const user = await newUser('burst@example.test');
    await reserveChatRequest(pool, user, CAP);
    for (let round = 1; round <= 8; round += 1) {
      await expireWindow(user, 61);
      const decisions = await Promise.all(Array.from({ length: 50 }, () => reserveChatRequest(pool, user, CAP)));
      assert.equal(decisions.filter((decision) => decision.allowed).length, CAP, `round ${round}`);
    }
  });

  test('a burst across two users keeps each bound', async () => {
    const a = await newUser('burst-a@example.test');
    const b = await newUser('burst-b@example.test');
    const decisions = await Promise.all(Array.from({ length: 60 }, (_, i) => reserveChatRequest(pool, i % 2 === 0 ? a : b, CAP)));
    assert.equal(decisions.filter((decision, i) => decision.allowed && i % 2 === 0).length, CAP);
    assert.equal(decisions.filter((decision, i) => decision.allowed && i % 2 === 1).length, CAP);
  });

  test('a user that does not exist is an error, not a pass', async () => {
    await assert.rejects(reserveChatRequest(pool, '33333333-3333-4333-8333-333333333333', CAP), code(FOREIGN_KEY));
  });

  test('a bad cap is refused before the database is asked', async () => {
    const user = await newUser('cap@example.test');
    for (const max of [0, -1, 1.5, Number.NaN]) await assert.rejects(reserveChatRequest(pool, user, max), RangeError);
    assert.equal(await count(user), undefined);
  });

  test('the table accepts no zero count, and a deleted user takes the row with them', async () => {
    const user = await newUser('cascade@example.test');
    await reserveChatRequest(pool, user, CAP);
    await assert.rejects(client.query('UPDATE chat_rate SET count = 0 WHERE user_id = $1', [user]), code(CHECK));
    await client.query('DELETE FROM users WHERE id = $1', [user]);
    assert.equal(await count(user), undefined);
  });
});
