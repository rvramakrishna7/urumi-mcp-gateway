import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { argon2Sync, randomBytes } from 'node:crypto';
import { createLimiter, hashPassword, passwordProblem, verifyOrDummy, verifyPassword } from '../src/auth/password.ts';

const PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  test('the stored value is a PHC string with argon2id and the OWASP parameters', async () => {
    const stored = await hashPassword(PASSWORD);
    assert.match(stored, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    assert.equal(stored.includes(PASSWORD), false);
  });

  test('the same password gives a different hash each time (random salt), and both verify', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword(PASSWORD, a), true);
    assert.equal(await verifyPassword(PASSWORD, b), true);
  });

  test('a wrong password, a changed case and an extra character do not verify', async () => {
    const stored = await hashPassword(PASSWORD);
    assert.equal(await verifyPassword('wrong password here', stored), false);
    assert.equal(await verifyPassword(PASSWORD.toUpperCase(), stored), false);
    assert.equal(await verifyPassword(`${PASSWORD}!`, stored), false);
    assert.equal(await verifyPassword('', stored), false);
  });

  test('a hash made with other parameters still verifies with the parameters it carries', async () => {
    const salt = randomBytes(16);
    const tag = argon2Sync('argon2id', { message: Buffer.from(PASSWORD), nonce: salt, parallelism: 2, tagLength: 24, memory: 8192, passes: 1 });
    const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
    const stored = `$argon2id$v=19$m=8192,t=1,p=2$${b64(salt)}$${b64(tag)}`;
    assert.equal(await verifyPassword(PASSWORD, stored), true);
    assert.equal(await verifyPassword('another password', stored), false);
  });

  test('a stored value that is not a hash this code understands is false, never an exception', async () => {
    const good = await hashPassword(PASSWORD);
    const salt = good.split('$')[4]!;
    const tag = good.split('$')[5]!;
    const bad = [
      '',
      'plain text',
      '$argon2i$v=19$m=19456,t=2,p=1$' + salt + '$' + tag,
      '$argon2id$v=16$m=19456,t=2,p=1$' + salt + '$' + tag,
      // Parameters outside the limits: more memory, more passes or more lanes than the code accepts.
      '$argon2id$v=19$m=4000000,t=2,p=1$' + salt + '$' + tag,
      '$argon2id$v=19$m=19456,t=99,p=1$' + salt + '$' + tag,
      '$argon2id$v=19$m=19456,t=2,p=64$' + salt + '$' + tag,
      '$argon2id$v=19$m=4,t=2,p=1$' + salt + '$' + tag,
      '$argon2id$v=19$m=19456,t=0,p=1$' + salt + '$' + tag,
      // A salt or a tag that is too short.
      '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$' + tag,
      '$argon2id$v=19$m=19456,t=2,p=1$' + salt + '$AAAAAAAAAAAAAAAA',
      good + 'x$',
    ];
    for (const value of bad) assert.equal(await verifyPassword(PASSWORD, value), false, value.slice(0, 40));
  });

  test('an email that has no hash costs the same work and is always false', async () => {
    const started = Date.now();
    assert.equal(await verifyOrDummy(PASSWORD, null), false);
    assert.equal(await verifyOrDummy(PASSWORD, null), false);
    // Two real argon2 runs (and the first dummy hash): far above what a skipped check would take.
    assert.ok(Date.now() - started >= 40, 'the dummy path must do the hashing work');
    const stored = await hashPassword(PASSWORD);
    assert.equal(await verifyOrDummy(PASSWORD, stored), true);
    assert.equal(await verifyOrDummy('not the password!', stored), false);
  });

  test('unicode passwords work, and the stored value is still plain ASCII', async () => {
    const password = 'pässwörd-日本語-\u{1F512}';
    const stored = await hashPassword(password);
    assert.match(stored, /^[\x20-\x7e]+$/);
    assert.equal(await verifyPassword(password, stored), true);
    assert.equal(await verifyPassword('passw0rd-japanese-lock', stored), false);
  });
});

describe('createLimiter', () => {
  test('never runs more than the given number of jobs at once, and finishes all of them', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        limit(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running -= 1;
          return index;
        }),
      ),
    );
    assert.equal(peak, 2);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('a job that throws gives its place back', async () => {
    const limit = createLimiter(1);
    await assert.rejects(limit(async () => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(await limit(async () => 'next'), 'next');
  });
});

describe('passwordProblem', () => {
  test('accepts 12 to 128 characters and counts characters, not bytes', () => {
    assert.equal(passwordProblem('a'.repeat(12)), null);
    assert.equal(passwordProblem('a'.repeat(128)), null);
    assert.equal(passwordProblem('\u{1F512}'.repeat(12)), null);
  });

  test('rejects short, long, non-text and email-equal passwords, and never repeats the password', () => {
    assert.match(passwordProblem('a'.repeat(11))!, /at least 12/);
    assert.match(passwordProblem('a'.repeat(129))!, /at most 128/);
    assert.match(passwordProblem(undefined)!, /text/);
    assert.match(passwordProblem(123456789012)!, /text/);
    assert.match(passwordProblem('Admin@Urumi.test', ' admin@urumi.test ')!, /email/);
    for (const text of [passwordProblem('secret-short'), passwordProblem('Admin@Urumi.test', 'admin@urumi.test')]) {
      assert.equal(String(text).includes('secret-short'), false);
      assert.equal(String(text).includes('Urumi'), false);
    }
  });

  test('has no composition rules', () => {
    assert.equal(passwordProblem('aaaaaaaaaaaa'), null);
    assert.equal(passwordProblem('            '), null);
  });
});
