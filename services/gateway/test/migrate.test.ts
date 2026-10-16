import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createLogger } from '../src/logger.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationFiles, MIGRATION_LOCK_KEY, MigrationError, runMigrations } from '../src/db/migrate.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const quiet = createLogger(() => {});

describe('loadMigrationFiles (no database needed)', () => {
  test('the real migrations folder loads, in order, with a checksum for each file', async () => {
    const files = await loadMigrationFiles();
    assert.equal(DEFAULT_MIGRATIONS_DIR.endsWith('migrations/') || DEFAULT_MIGRATIONS_DIR.endsWith('migrations\\'), true);
    assert.ok(files.length >= 1);
    assert.equal(files[0]!.version, '0001_init');
    assert.match(files[0]!.checksum, /^[0-9a-f]{64}$/);
    assert.deepEqual(files.map((file) => file.version), [...files.map((file) => file.version)].sort());
  });

  test('the checksum follows the content', async () => {
    const a = mkdtempSync(join(tmpdir(), 'gw-mig-a-'));
    writeFileSync(join(a, '0001_x.sql'), 'SELECT 1;');
    const first = (await loadMigrationFiles(a))[0]!.checksum;
    writeFileSync(join(a, '0001_x.sql'), 'SELECT 2;');
    const second = (await loadMigrationFiles(a))[0]!.checksum;
    rmSync(a, { recursive: true, force: true });
    assert.notEqual(first, second);
  });

  test('rejects a file name that is not of the form 0001_name.sql', async () => {
    for (const name of ['init.sql', '1_init.sql', '0001-init.sql', '0001_Init.sql', '0001_.sql.sql']) {
      const d = mkdtempSync(join(tmpdir(), 'gw-mig-b-'));
      writeFileSync(join(d, name), 'SELECT 1;');
      await assert.rejects(loadMigrationFiles(d), MigrationError, name);
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('rejects two files with the same number', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gw-mig-c-'));
    writeFileSync(join(d, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(d, '0001_b.sql'), 'SELECT 1;');
    await assert.rejects(loadMigrationFiles(d), /the number 0001/);
    rmSync(d, { recursive: true, force: true });
  });

  test('ignores files that are not .sql', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gw-mig-d-'));
    writeFileSync(join(d, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(d, 'README.md'), 'notes');
    assert.equal((await loadMigrationFiles(d)).length, 1);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('runMigrations (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let testDb: TestDatabase;
  const tempDirs: string[] = [];

  before(async () => {
    testDb = await createTestDatabase();
  });
  after(async () => {
    await testDb.drop();
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  // A migrations folder with the real 0001 and extra files, to test behaviour without touching the real folder.
  const folder = (extra: Record<string, string> = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'gw-mig-db-'));
    tempDirs.push(d);
    writeFileSync(join(d, '0001_init.sql'), readFileSync(join(DEFAULT_MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
    for (const [name, sql] of Object.entries(extra)) writeFileSync(join(d, name), sql);
    return d;
  };
  const fresh = async (): Promise<TestDatabase> => createTestDatabase();
  const tableNames = async (client: pg.Client) =>
    (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((row) => row.tablename);

  test('applies every real migration on an empty database and records the checksums', async () => {
    const db = await fresh();
    try {
      const client = await db.connect();
      const files = await loadMigrationFiles();
      const result = await runMigrations(client, files, quiet);
      assert.deepEqual(result, { applied: files.map((file) => file.version), alreadyApplied: [], unknown: [] });
      assert.deepEqual(await tableNames(client), ['api_keys', 'applied_seeds', 'audit_log', 'chat_rate', 'login_throttle', 'schema_migrations', 'sessions', 'upstream_servers', 'upstream_tools', 'users']);
      const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
      assert.deepEqual(rows, files.map((file) => ({ version: file.version, checksum: file.checksum })));
    } finally {
      await db.drop();
    }
  });

  test('is idempotent: a second run applies nothing and changes nothing', async () => {
    const db = await fresh();
    try {
      const client = await db.connect();
      const files = await loadMigrationFiles();
      await runMigrations(client, files, quiet);
      const before = (await client.query('SELECT version, checksum, applied_at FROM schema_migrations')).rows;
      const again = await runMigrations(client, files, quiet);
      const after = (await client.query('SELECT version, checksum, applied_at FROM schema_migrations')).rows;
      assert.deepEqual(again, { applied: [], alreadyApplied: files.map((file) => file.version), unknown: [] });
      assert.deepEqual(after, before);
    } finally {
      await db.drop();
    }
  });

  test('is safe when several runners start at once: every file is applied exactly once and nobody fails', async () => {
    const db = await fresh();
    try {
      const files = await loadMigrationFiles(
        folder({
          '0002_counter.sql': 'CREATE TABLE counter (n integer NOT NULL); INSERT INTO counter VALUES (1);',
          '0003_more.sql': 'CREATE TABLE more (id integer PRIMARY KEY);',
        }),
      );
      const clients = await Promise.all(Array.from({ length: 8 }, () => db.connect()));
      const results = await Promise.all(clients.map((client) => runMigrations(client, files, quiet)));

      const appliedBy = (version: string) => results.filter((result) => result.applied.includes(version)).length;
      for (const version of ['0001_init', '0002_counter', '0003_more']) assert.equal(appliedBy(version), 1, version);
      for (const result of results) assert.equal(result.applied.length + result.alreadyApplied.length, 3);

      const check = await db.connect();
      assert.deepEqual((await check.query('SELECT n FROM counter')).rows, [{ n: 1 }]);
      assert.equal((await check.query('SELECT count(*)::int AS c FROM schema_migrations')).rows[0].c, 3);
    } finally {
      await db.drop();
    }
  });

  test('a second runner waits while the first holds the lock, then finds nothing to do', async () => {
    const db = await fresh();
    try {
      const holder = await db.connect();
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const runner = await db.connect();
      let finished = false;
      const running = runMigrations(runner, await loadMigrationFiles(), quiet).then((result) => {
        finished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(finished, false, 'the runner must wait for the lock');
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      const result = await running;
      assert.deepEqual(result.applied, (await loadMigrationFiles()).map((file) => file.version));
    } finally {
      await db.drop();
    }
  });

  test('a failing migration is rolled back completely, records nothing, names only the version and the error code, and releases the lock', async () => {
    const db = await fresh();
    try {
      const dir = folder({ '0002_bad.sql': "CREATE TABLE half_done (secret_column text); INSERT INTO half_done VALUES ('top-secret'); SELECT 1/0;" });
      const client = await db.connect();
      await assert.rejects(runMigrations(client, await loadMigrationFiles(dir), quiet), (error: unknown) => {
        assert.ok(error instanceof MigrationError);
        assert.equal(error.message, 'migration 0002_bad failed (PostgreSQL error 22012)');
        assert.ok(!error.message.includes('half_done') && !error.message.includes('top-secret'));
        return true;
      });
      assert.ok(!(await tableNames(client)).includes('half_done'));
      assert.deepEqual((await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows, [{ version: '0001_init' }]);

      // The lock is free again and a corrected file (same number, never recorded) is applied by the next run.
      writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE fixed (id integer);');
      const next = await db.connect();
      const result = await runMigrations(next, await loadMigrationFiles(dir), quiet);
      assert.deepEqual(result.applied, ['0002_bad']);
    } finally {
      await db.drop();
    }
  });

  test('refuses a file that was changed after it was applied', async () => {
    const db = await fresh();
    try {
      const dir = folder({ '0002_x.sql': 'CREATE TABLE x (id integer);' });
      const client = await db.connect();
      await runMigrations(client, await loadMigrationFiles(dir), quiet);
      writeFileSync(join(dir, '0002_x.sql'), 'CREATE TABLE x (id integer, extra text);');
      await assert.rejects(runMigrations(client, await loadMigrationFiles(dir), quiet), /migration 0002_x was changed after it was applied/);
    } finally {
      await db.drop();
    }
  });

  test('a database that is ahead of this build is reported, not rejected', async () => {
    const db = await fresh();
    try {
      const client = await db.connect();
      const files = await loadMigrationFiles();
      await runMigrations(client, files, quiet);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ('0099_from_a_newer_build', 'abc')");
      const warnings: string[] = [];
      const result = await runMigrations(client, files, createLogger((line) => warnings.push(line)));
      assert.deepEqual(result.unknown, ['0099_from_a_newer_build']);
      assert.equal(warnings.filter((line) => JSON.parse(line).level === 'warn').length, 1);
    } finally {
      await db.drop();
    }
  });
});
