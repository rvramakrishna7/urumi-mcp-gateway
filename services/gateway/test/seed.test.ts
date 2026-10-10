import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { loadKeyring } from '../src/crypto/credentials.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createLogger } from '../src/logger.ts';
import { deleteServer, getServerBySlug, patchServer, readCredential } from '../src/registry/repository.ts';
import { applySeed, loadSeedFile, SeedError } from '../src/registry/seed.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

describe('install seed (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keyring: Keyring;
  let dir: string;
  const logLines: string[] = [];
  const logger = createLogger((line) => logLines.push(line));

  const URL_ONE = 'http://woo-mcp.mcp-servers.svc.cluster.local:8080/mcp';

  // Writes a seed file and the credential file it points at, and loads it, like the gateway does at start.
  const seedWith = (token: string | null, url = URL_ONE) => {
    const tokenFile = join(dir, 'token');
    if (token !== null) writeFileSync(tokenFile, `${token}\n`);
    const file = join(dir, 'seed.json');
    writeFileSync(file, JSON.stringify({
      servers: [{ slug: 'woo', name: 'WooCommerce', url, ...(token !== null ? { credential: { kind: 'bearer', file: tokenFile } } : {}) }],
    }));
    return loadSeedFile(file);
  };
  const state = async () => (await pool.query('SELECT id, url, enabled, seed_managed, updated_at, credential_ciphertext, credential_nonce FROM upstream_servers WHERE slug = $1', ['woo'])).rows[0];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-seed-'));
    writeFileSync(join(dir, 'master'), randomBytes(32).toString('base64'));
    keyring = loadKeyring(join(dir, 'master'), 'k1');
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
  });
  after(async () => {
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM upstream_servers');
    await pool.query('DELETE FROM applied_seeds');
  });

  test('inserts the server with an encrypted, decryptable credential and marks it seed managed', async () => {
    const actions = await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.deepEqual(actions, { woo: 'inserted' });
    const server = await getServerBySlug(pool, 'woo');
    assert.equal(server?.credential.set, true);
    assert.equal(server?.seedManaged, true);
    assert.equal(server?.enabled, true);
    assert.equal((await readCredential(pool, keyring, server!.id))?.value, 'seed-token-aaaaaaaa');
    assert.equal((await pool.query('SELECT count(*)::int AS c FROM applied_seeds')).rows[0].c, 1);
  });

  test('a second start changes nothing: same row, same ciphertext, same updated_at', async () => {
    await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    const before = await state();
    const actions = await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.deepEqual(actions, { woo: 'unchanged' });
    assert.deepEqual(await state(), before);
  });

  test('a rotated token and a new url follow the seed while the row is seed managed', async () => {
    await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    const id = (await state()).id;
    const actions = await applySeed(pool, keyring, seedWith('seed-token-bbbbbbbb', 'http://woo-mcp:9090/mcp'), logger);
    assert.deepEqual(actions, { woo: 'synced' });
    assert.equal((await readCredential(pool, keyring, id))?.value, 'seed-token-bbbbbbbb');
    assert.equal((await state()).url, 'http://woo-mcp:9090/mcp');
    assert.equal((await state()).seed_managed, true);
  });

  test('the seed never writes enabled: a server that an admin disabled stays disabled across restarts', async () => {
    await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    const id = (await state()).id;
    await patchServer(pool, keyring, id, { enabled: false });
    assert.equal((await state()).seed_managed, true, 'disabling is not an edit of the seeded fields');
    // A restart with an unchanged seed and a restart with a rotated token.
    await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.equal((await state()).enabled, false);
    await applySeed(pool, keyring, seedWith('seed-token-cccccccc'), logger);
    assert.equal((await state()).enabled, false);
    assert.equal((await readCredential(pool, keyring, id))?.value, 'seed-token-cccccccc');
  });

  test('an admin edit of url, credential, name or timeout stops the seed from touching the row', async () => {
    const edits = [{ url: 'http://edited.test/mcp' }, { name: 'Edited' }, { callTimeoutMs: 5000 }, { credential: { kind: 'bearer' as const, value: 'admin-chosen-token' } }];
    for (const edit of edits) {
      await pool.query('DELETE FROM upstream_servers');
      await pool.query('DELETE FROM applied_seeds');
      await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
      const id = (await state()).id;
      await patchServer(pool, keyring, id, edit);
      assert.equal((await state()).seed_managed, false, JSON.stringify(Object.keys(edit)));
      const before = await state();
      const actions = await applySeed(pool, keyring, seedWith('seed-token-zzzzzzzz', 'http://woo-mcp:7070/mcp'), logger);
      assert.deepEqual(actions, { woo: 'skipped-not-managed' });
      assert.deepEqual(await state(), before);
    }
  });

  test('seed, delete the server, restart: it stays deleted', async () => {
    await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.equal(await deleteServer(pool, (await state()).id), true);
    const actions = await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.deepEqual(actions, { woo: 'skipped-removed' });
    assert.equal(await getServerBySlug(pool, 'woo'), null);
    // And again after another restart.
    await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.equal((await pool.query('SELECT count(*)::int AS c FROM upstream_servers')).rows[0].c, 0);
  });

  test('a server that an admin registered with the same slug before the seed is not touched', async () => {
    await pool.query("INSERT INTO upstream_servers (slug, name, url) VALUES ('woo', 'Mine', 'http://mine.test/mcp')");
    const actions = await applySeed(pool, keyring, seedWith('seed-token-aaaaaaaa'), logger);
    assert.deepEqual(actions, { woo: 'skipped-not-managed' });
    assert.equal((await state()).url, 'http://mine.test/mcp');
  });

  test('start-up of several gateway pods at once applies the seed once', async () => {
    const seed = seedWith('seed-token-aaaaaaaa');
    const results = await Promise.all(Array.from({ length: 4 }, () => applySeed(pool, keyring, seed, logger)));
    assert.equal(results.filter((result) => result.woo === 'inserted').length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS c FROM upstream_servers')).rows[0].c, 1);
  });

  test('a bad seed file or an unreadable credential file is a SeedError that names no value', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ servers: [{ slug: 'Bad Slug', name: 'x', url: 'http://user:pw-in-url@x.test/mcp' }] }));
    assert.throws(() => loadSeedFile(bad), (error: unknown) => {
      assert.ok(error instanceof SeedError);
      assert.ok(!error.message.includes('pw-in-url'));
      return true;
    });
    assert.throws(() => loadSeedFile(join(dir, 'missing.json')), SeedError);
    writeFileSync(bad, 'not json');
    assert.throws(() => loadSeedFile(bad), SeedError);
  });

  test('the seed log names the slug and the action and no value', async () => {
    logLines.length = 0;
    await applySeed(pool, keyring, seedWith('seed-token-logcheck-1234'), logger);
    assert.ok(logLines.some((line) => line.includes('"slug":"woo"') && line.includes('"action":"inserted"')));
    assert.ok(!logLines.join('\n').includes('seed-token-logcheck-1234'));
  });
});
