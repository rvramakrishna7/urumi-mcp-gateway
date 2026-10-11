import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';
import { acceptInvite, applyBootstrap, BOOTSTRAP_TTL_SECONDS, BootstrapError, generateInviteToken, hashInviteToken, readBootstrapToken } from '../src/identity/invites.ts';
import { createUser } from '../src/identity/repository.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createLogger } from '../src/logger.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

describe('readBootstrapToken', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-bootstrap-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads a token from a file, with the trailing newline of a mounted Secret', () => {
    const token = generateInviteToken();
    writeFileSync(join(dir, 'ok'), `${token}\n`);
    assert.equal(readBootstrapToken(join(dir, 'ok')), token);
  });

  test('a missing file and a file that holds something else are refused, and the message holds no value', () => {
    writeFileSync(join(dir, 'bad'), 'not-a-token-but-a-secret-value');
    assert.throws(() => readBootstrapToken(join(dir, 'bad')), (error: unknown) => error instanceof BootstrapError && !error.message.includes('secret-value') && /invite token/.test(error.message));
    assert.throws(() => readBootstrapToken(join(dir, 'missing')), (error: unknown) => error instanceof BootstrapError && !error.message.includes(dir));
  });
});

describe('applyBootstrap (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  before(async () => {
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
  });
  after(async () => {
    await db.drop();
  });

  const row = async (email: string) => (await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];

  test('creates the admin as invited, without a password, with the hash of the token and an expiry of 7 days', async () => {
    const token = generateInviteToken();
    assert.equal(await applyBootstrap(pool, 'first@example.com', token), 'created');
    const user = await row('first@example.com');
    assert.equal(user.role, 'admin');
    assert.equal(user.status, 'invited');
    assert.equal(user.password_hash, null);
    assert.deepEqual(user.invite_token_hash, hashInviteToken(token));
    assert.ok(Math.abs((user.invite_expires_at.getTime() - Date.now()) / 1000 - BOOTSTRAP_TTL_SECONDS) < 30);
  });

  test('a restart arms the same admin again: the same token, a new expiry, nothing else changed', async () => {
    const token = generateInviteToken();
    await applyBootstrap(pool, 'again@example.com', token);
    await pool.query("UPDATE users SET invite_expires_at = now() + interval '1 minute' WHERE email = 'again@example.com'");
    assert.equal(await applyBootstrap(pool, 'again@example.com', token), 'armed');
    const user = await row('again@example.com');
    assert.ok((user.invite_expires_at.getTime() - Date.now()) / 1000 > BOOTSTRAP_TTL_SECONDS - 60);
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM users WHERE email = 'again@example.com'")).rows[0].c, 1);
  });

  test('an expired invite works again after a restart', async () => {
    const token = generateInviteToken();
    await applyBootstrap(pool, 'expired@example.com', token);
    await pool.query("UPDATE users SET invite_expires_at = now() - interval '1 hour' WHERE email = 'expired@example.com'");
    assert.equal((await acceptInvite(pool, token, 'a password for the admin')).ok, false);
    assert.equal(await applyBootstrap(pool, 'expired@example.com', token), 'armed');
    assert.equal((await acceptInvite(pool, token, 'a password for the admin')).ok, true);
  });

  test('an active admin without a password (the local cluster) is armed, and stays active', async () => {
    await createUser(pool, 'old-admin@example.com', 'admin');
    const token = generateInviteToken();
    assert.equal(await applyBootstrap(pool, 'old-admin@example.com', token), 'armed');
    const user = await row('old-admin@example.com');
    assert.equal(user.status, 'active');
    assert.deepEqual(user.invite_token_hash, hashInviteToken(token));
    const result = await acceptInvite(pool, token, 'chosen by the admin 1');
    assert.equal(result.ok, true);
    assert.equal(await verifyPassword('chosen by the admin 1', (await row('old-admin@example.com')).password_hash), true);
  });

  test('an admin who has a password is never touched, not even by the same token', async () => {
    await createUser(pool, 'done@example.com', 'admin');
    const stored = await hashPassword('already chosen password');
    await pool.query("UPDATE users SET password_hash = $1 WHERE email = 'done@example.com'", [stored]);
    const before = await row('done@example.com');
    assert.equal(await applyBootstrap(pool, 'done@example.com', generateInviteToken()), 'unchanged');
    assert.deepEqual(await row('done@example.com'), before);
  });

  test('after the password is set, a restart changes nothing', async () => {
    const token = generateInviteToken();
    await applyBootstrap(pool, 'sequence@example.com', token);
    assert.equal((await acceptInvite(pool, token, 'chosen by the admin 2')).ok, true);
    const before = await row('sequence@example.com');
    assert.equal(await applyBootstrap(pool, 'sequence@example.com', token), 'unchanged');
    assert.deepEqual(await row('sequence@example.com'), before);
  });

  test('a member, and a disabled admin, with that email are left alone', async () => {
    await createUser(pool, 'member-first@example.com', 'member');
    await createUser(pool, 'disabled-first@example.com', 'admin');
    await pool.query("UPDATE users SET status = 'disabled' WHERE email = 'disabled-first@example.com'");
    for (const email of ['member-first@example.com', 'disabled-first@example.com']) {
      const before = await row(email);
      assert.equal(await applyBootstrap(pool, email, generateInviteToken()), 'unchanged');
      assert.deepEqual(await row(email), before);
    }
  });

  test('a token that already belongs to another user is refused with a message that holds no value', async () => {
    const token = generateInviteToken();
    await applyBootstrap(pool, 'owner@example.com', token);
    await assert.rejects(applyBootstrap(pool, 'other@example.com', token), (error: unknown) => error instanceof BootstrapError && !error.message.includes(token) && /already in use/.test(error.message));
    assert.equal(await row('other@example.com'), undefined);
  });

  test('several pods that start together create one admin', async () => {
    const token = generateInviteToken();
    const actions = await Promise.all(Array.from({ length: 6 }, () => applyBootstrap(pool, 'race@example.com', token)));
    assert.equal(actions.filter((action) => action === 'created').length, 1);
    assert.equal(actions.filter((action) => action === 'armed').length, 5);
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM users WHERE email = 'race@example.com'")).rows[0].c, 1);
  });
});
