import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Logger } from '../logger.ts';

// Raised for a problem with the migration files or with the state of the database. The message holds file versions
// and PostgreSQL error codes, never SQL text or data.
export class MigrationError extends Error {}

export interface MigrationFile {
  // The file name without ".sql", for example 0001_init. It is the key in schema_migrations.
  version: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  // Versions that the database has but this build has no file for (a newer build ran before a rollback).
  unknown: string[];
}

// The default folder is the same relative to src/db and to dist/db, so it works in development and in the image.
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

// One number for the whole project. Two runners that start together queue on this lock.
export const MIGRATION_LOCK_KEY = 7_242_001;
const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function loadMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = FILE_NAME.exec(name);
    if (!match) throw new MigrationError(`migration file name is not of the form 0001_name.sql: ${name}`);
    if (seen.has(match[1]!)) throw new MigrationError(`two migration files have the number ${match[1]}`);
    seen.add(match[1]!);
    const sql = await readFile(`${dir}/${name}`, 'utf8');
    files.push({ version: name.slice(0, -'.sql'.length), checksum: createHash('sha256').update(sql).digest('hex'), sql });
  }
  return files;
}

// Applies the pending files, in order, each in its own transaction. Forward only: there is no "down".
// The advisory lock makes this safe when several runners start at once (several pods, or a pod that restarts
// during a rollout): the first one applies the files, the others wait and then find nothing to do.
export async function runMigrations(client: pg.Client, files: MigrationFile[], logger: Logger): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], alreadyApplied: [], unknown: [] };

  // Bound the wait for the lock, so that a runner stuck behind a hung one fails instead of waiting for ever.
  await client.query("SET statement_timeout = '120s'");
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    // A migration may take longer than a normal query, but not for ever.
    await client.query("SET statement_timeout = '600s'");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const recorded = new Map(rows.map((row) => [row.version, row.checksum]));

    for (const file of files) {
      const checksum = recorded.get(file.version);
      if (checksum !== undefined) {
        // A file that was edited after it was applied means that the database and the code disagree.
        if (checksum !== file.checksum) throw new MigrationError(`migration ${file.version} was changed after it was applied`);
        result.alreadyApplied.push(file.version);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file.version, file.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const code = (error as { code?: unknown }).code;
        throw new MigrationError(`migration ${file.version} failed${typeof code === 'string' ? ` (PostgreSQL error ${code})` : ''}`);
      }
      result.applied.push(file.version);
      logger.info('migration applied', { version: file.version });
    }

    const known = new Set(files.map((file) => file.version));
    result.unknown = [...recorded.keys()].filter((version) => !known.has(version));
    if (result.unknown.length > 0) {
      logger.warn('the database has migrations that this build does not know', { versions: result.unknown.join(',') });
    }
  } finally {
    // Closing the connection would release the lock as well. This releases it as early as possible.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
  }
  return result;
}
