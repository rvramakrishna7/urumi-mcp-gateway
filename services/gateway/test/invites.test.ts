import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';
import { createSession } from '../src/auth/session.ts';
import { acceptInvite, generateInviteToken, hashInviteToken, INVITE_TTL_SECONDS, issueInvite, issueInviteByEmail, looksLikeInviteToken } from '../src/identity/invites.ts';
import { createUser, IdentityError } from '../src/identity/repository.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createLogger } from '../src/logger.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const GOOD = 'a brand new password 42';

describe('invite tokens', () => {
  test('a token is inv_ and 43 characters of base64url, and every token is different', () => {
    const [a, b] = [generateInviteToken(), generateInviteToken()];
    assert.match(a, /^inv_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.equal(looksLikeInviteToken(a), true);
  });

  test('anything else is not a token', () => {
    for (const value of ['', 'inv_short', `inv_${'a'.repeat(44)}`, `INV_${'a'.repeat(43)}`, `mcpgw_${'a'.repeat(43)}`, `inv_${'a'.repeat(42)}!`]) {
      assert.equal(looksLikeInviteToken(value), false, value);
    }
  });

  test('the hash is SHA-256 of the token: 32 bytes, and the same for the same token', () => {
    const token = generateInviteToken();
    assert.equal(hashInviteToken(token).length, 32);
    assert.deepEqual(hashInviteToken(token), hashInviteToken(token));
    assert.notDeepEqual(hashInviteToken(token), hashInviteToken(generateInviteToken()));
  });
});

describe('issueInvite and acceptInvite (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let client: pg.Client;
  let counter = 0;

  before(async () => {
    db = await createTestDatabase();
    client = await db.connect();
    await runMigrations(client, await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
  });
  after(async () => {
    await db.drop();
  });

  const newUser = async (role: 'admin' | 'member' = 'member', status = 'active') => {
    counter += 1;
    const email = `user${counter}@example.com`;
    const user = await createUser(pool, email, role);
    if (status !== 'active') await pool.query('UPDATE users SET status = $2 WHERE id = $1', [user.id, status]);
    return { id: user.id, email };
  };
  const row = async (id: string) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

  describe('issueInvite', () => {
    test('stores only the hash and an expiry of 72 hours, and returns the token', async () => {
      const user = await newUser();
      const token = (await issueInvite(pool, user.id))!;
      assert.match(token, /^inv_/);
      const stored = await row(user.id);
      assert.deepEqual(stored.invite_token_hash, hashInviteToken(token));
      assert.equal(stored.invite_token_hash.includes(Buffer.from(token)), false);
      const seconds = (stored.invite_expires_at.getTime() - Date.now()) / 1000;
      assert.ok(Math.abs(seconds - INVITE_TTL_SECONDS) < 30, `expiry ${seconds}`);
    });

    test('a new invite replaces the old one: only the latest token works', async () => {
      const user = await newUser();
      const first = (await issueInvite(pool, user.id))!;
      const second = (await issueInvite(pool, user.id))!;
      assert.deepEqual((await acceptInvite(pool, first, GOOD)), { ok: false, reason: 'invalid' });
      assert.equal((await acceptInvite(pool, second, GOOD)).ok, true);
    });

    test('a disabled user and an unknown user get no invite', async () => {
      const user = await newUser('member', 'disabled');
      assert.equal(await issueInvite(pool, user.id), null);
      assert.equal(await issueInvite(pool, '00000000-0000-4000-8000-000000000000'), null);
      await assert.rejects(issueInviteByEmail(pool, user.email), (error: unknown) => error instanceof IdentityError && /disabled/.test(error.message));
      await assert.rejects(issueInviteByEmail(pool, 'nobody@example.com'), (error: unknown) => error instanceof IdentityError && /no user/.test(error.message));
    });

    test('issueInviteByEmail finds the user by a trimmed, lower case email', async () => {
      const user = await newUser();
      const token = await issueInviteByEmail(pool, `  ${user.email.toUpperCase()} `);
      assert.deepEqual((await row(user.id)).invite_token_hash, hashInviteToken(token));
    });
  });

  describe('acceptInvite', () => {
    test('sets an argon2id password, activates the user, uses up the token and records the login', async () => {
      const user = await newUser('member', 'invited');
      const token = (await issueInvite(pool, user.id))!;
      const result = await acceptInvite(pool, token, GOOD);
      assert.deepEqual(result, { ok: true, user: { id: user.id, email: user.email, role: 'member' } });
      const stored = await row(user.id);
      assert.equal(stored.status, 'active');
      assert.equal(stored.invite_token_hash, null);
      assert.equal(stored.invite_expires_at, null);
      assert.notEqual(stored.last_login_at, null);
      assert.match(stored.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      assert.equal(stored.password_hash.includes(GOOD), false);
      assert.equal(await verifyPassword(GOOD, stored.password_hash), true);
      assert.equal(await verifyPassword('some other password', stored.password_hash), false);
    });

    test('the token works once: the second use is refused', async () => {
      const user = await newUser();
      const token = (await issueInvite(pool, user.id))!;
      assert.equal((await acceptInvite(pool, token, GOOD)).ok, true);
      assert.deepEqual(await acceptInvite(pool, token, 'a different password 43'), { ok: false, reason: 'invalid' });
      assert.equal(await verifyPassword(GOOD, (await row(user.id)).password_hash), true);
    });

    test('five requests with the same token at the same time: exactly one wins', async () => {
      const user = await newUser();
      const token = (await issueInvite(pool, user.id))!;
      const results = await Promise.all(Array.from({ length: 5 }, (_, index) => acceptInvite(pool, token, `password number ${index} here`)));
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(results.filter((result) => !result.ok && result.reason === 'invalid').length, 4);
    });

    test('a token that does not exist, is malformed, has expired, or belongs to a disabled user is "invalid", with no difference', async () => {
      const expired = await newUser();
      const expiredToken = (await issueInvite(pool, expired.id))!;
      await pool.query("UPDATE users SET invite_expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
      const disabled = await newUser();
      const disabledToken = (await issueInvite(pool, disabled.id))!;
      await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabled.id]);
      for (const token of [generateInviteToken(), 'inv_short', '', expiredToken, disabledToken]) {
        assert.deepEqual(await acceptInvite(pool, token, GOOD), { ok: false, reason: 'invalid' });
      }
      assert.equal((await row(expired.id)).password_hash, null);
      assert.equal((await row(disabled.id)).password_hash, null);
    });

    test('a weak password is refused with a reason, does not use up the token, and does not repeat the password', async () => {
      const user = await newUser();
      const token = (await issueInvite(pool, user.id))!;
      for (const password of ['short', user.email, 'x'.repeat(129), 12345678901234]) {
        const result = await acceptInvite(pool, token, password);
        assert.equal(result.ok, false);
        assert.equal((result as { reason: string }).reason, 'weak');
        assert.equal(JSON.stringify(result).includes('short'), false);
      }
      assert.equal((await row(user.id)).password_hash, null);
      assert.equal((await acceptInvite(pool, token, GOOD)).ok, true);
    });

    test('a weak password is not revealed to someone without a valid token', async () => {
      assert.deepEqual(await acceptInvite(pool, generateInviteToken(), 'short'), { ok: false, reason: 'invalid' });
    });

    test('for a user who has a password it is a reset: the old password stops working and the sessions end', async () => {
      const user = await newUser();
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword('the old password 11')]);
      await createSession(pool, user.id);
      await createSession(pool, user.id);
      const other = await newUser();
      await createSession(pool, other.id);
      const token = (await issueInvite(pool, user.id))!;
      assert.equal((await acceptInvite(pool, token, GOOD)).ok, true);
      const stored = await row(user.id);
      assert.equal(await verifyPassword('the old password 11', stored.password_hash), false);
      assert.equal(await verifyPassword(GOOD, stored.password_hash), true);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM sessions WHERE user_id = $1', [user.id])).rows[0].c, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM sessions WHERE user_id = $1', [other.id])).rows[0].c, 1);
    });

    test('the role does not change, and an admin stays an admin', async () => {
      const admin = await newUser('admin', 'invited');
      const token = (await issueInvite(pool, admin.id))!;
      const result = await acceptInvite(pool, token, GOOD);
      assert.equal(result.ok && result.user.role, 'admin');
    });
  });
});
