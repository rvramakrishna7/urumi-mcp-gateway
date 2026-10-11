import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createLogger } from '../src/logger.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

// PostgreSQL error codes: 23514 check violation, 23505 unique violation, 23502 not null violation, 23503 foreign key.
const CHECK = '23514';
const UNIQUE = '23505';
const NOT_NULL = '23502';
const FOREIGN_KEY = '23503';

describe('schema of migration 0003: sessions and login_throttle (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let client: pg.Client;

  before(async () => {
    db = await createTestDatabase();
    client = await db.connect();
    // The users of the local cluster exist before this migration: make them first, then apply everything.
    const files = await loadMigrationFiles();
    await runMigrations(client, files.filter((file) => file.version < '0003'), createLogger(() => {}));
    await client.query("INSERT INTO users (email, role, status) VALUES ('old-admin@example.test', 'admin', 'active'), ('old-member@example.test', 'member', 'active')");
    await runMigrations(client, files, createLogger(() => {}));
  });
  after(async () => {
    await db.drop();
  });

  const rejects = (text: string, values: unknown[], code: string) =>
    assert.rejects(client.query(text, values), (error: unknown) => (error as { code?: string }).code === code, `${text.slice(0, 60)} should fail with ${code}`);
  const newUser = async (email: string) => (await client.query<{ id: string }>("INSERT INTO users (email, role, status) VALUES ($1, 'member', 'active') RETURNING id", [email])).rows[0]!.id;
  const newSession = async (userId: string, hash = randomBytes(32)) =>
    (await client.query<{ id: string }>("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '12 hours') RETURNING id", [userId, hash])).rows[0]!.id;

  test('the users that existed before keep their data, and last_login_at is null for them', async () => {
    const { rows } = await client.query('SELECT email, role, status, password_hash, invite_token_hash, last_login_at FROM users ORDER BY email');
    const old = rows.filter((row) => row.email.startsWith('old-'));
    assert.deepEqual(old.map((row) => [row.email, row.role, row.status, row.password_hash, row.invite_token_hash, row.last_login_at]), [
      ['old-admin@example.test', 'admin', 'active', null, null, null],
      ['old-member@example.test', 'member', 'active', null, null, null],
    ]);
  });

  describe('sessions', () => {
    test('a valid session gets an id and the times', async () => {
      const userId = await newUser('s1@example.test');
      const { rows } = await client.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '12 hours') RETURNING id, created_at, last_seen_at, expires_at", [userId, randomBytes(32)]);
      assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
      assert.ok(rows[0].expires_at > rows[0].created_at);
      assert.ok(rows[0].last_seen_at instanceof Date);
    });

    test('the token hash is 32 bytes, unique, and required; the user is required and must exist', async () => {
      const userId = await newUser('s2@example.test');
      await rejects("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [userId, randomBytes(31)], CHECK);
      await rejects("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, NULL, now() + interval '1 hour')", [userId], NOT_NULL);
      const hash = randomBytes(32);
      await newSession(userId, hash);
      await rejects("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [userId, hash], UNIQUE);
      await rejects("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (NULL, $1, now() + interval '1 hour')", [randomBytes(32)], NOT_NULL);
      await rejects("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, now() + interval '1 hour')", [randomBytes(32)], FOREIGN_KEY);
    });

    test('the absolute expiry must be after the creation', async () => {
      const userId = await newUser('s3@example.test');
      await rejects("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 hour')", [userId, randomBytes(32)], CHECK);
      await rejects('INSERT INTO sessions (user_id, token_hash) VALUES ($1, $2)', [userId, randomBytes(32)], NOT_NULL);
    });

    test('deleting the user deletes the sessions of that user and no other', async () => {
      const a = await newUser('s4a@example.test');
      const b = await newUser('s4b@example.test');
      await newSession(a);
      await newSession(a);
      await newSession(b);
      await client.query('DELETE FROM users WHERE id = $1', [a]);
      assert.equal((await client.query('SELECT count(*)::int AS c FROM sessions WHERE user_id = $1', [a])).rows[0].c, 0);
      assert.equal((await client.query('SELECT count(*)::int AS c FROM sessions WHERE user_id = $1', [b])).rows[0].c, 1);
    });

    test('the lookup by token hash and the cleanup by expiry use an index', async () => {
      const { rows } = await client.query("SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' ORDER BY indexname");
      assert.deepEqual(rows.map((row) => row.indexname), ['sessions_expires_at_idx', 'sessions_pkey', 'sessions_token_hash_key', 'sessions_user_id_idx']);
    });
  });

  describe('login_throttle', () => {
    test('a new key starts with no failures and no lock', async () => {
      const key = randomBytes(32);
      const { rows } = await client.query('INSERT INTO login_throttle (key_hash) VALUES ($1) RETURNING failures, locked_until, window_started_at', [key]);
      assert.equal(rows[0].failures, 0);
      assert.equal(rows[0].locked_until, null);
      assert.ok(rows[0].window_started_at instanceof Date);
    });

    test('the key is 32 bytes and unique, and the count cannot be negative', async () => {
      await rejects('INSERT INTO login_throttle (key_hash) VALUES ($1)', [randomBytes(16)], CHECK);
      const key = randomBytes(32);
      await client.query('INSERT INTO login_throttle (key_hash) VALUES ($1)', [key]);
      await rejects('INSERT INTO login_throttle (key_hash) VALUES ($1)', [key], UNIQUE);
      await rejects('INSERT INTO login_throttle (key_hash, failures) VALUES ($1, -1)', [randomBytes(32)], CHECK);
    });

    test('it holds no email and no user id', async () => {
      const { rows } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'login_throttle' ORDER BY column_name");
      assert.deepEqual(rows.map((row) => row.column_name), ['failures', 'key_hash', 'locked_until', 'window_started_at']);
    });
  });
});
