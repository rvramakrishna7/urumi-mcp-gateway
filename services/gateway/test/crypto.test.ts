import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoError, decryptCredential, encryptCredential, loadKeyring } from '../src/crypto/credentials.ts';
import type { Keyring } from '../src/crypto/credentials.ts';

const ID_A = 'a6d8e2b6-0000-4000-8000-000000000001';
const ID_B = 'a6d8e2b6-0000-4000-8000-000000000002';

describe('AES-256-GCM credentials', () => {
  let dir: string;
  let keyring: Keyring;

  const keyFile = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-crypto-'));
    keyring = loadKeyring(keyFile('good', `${randomBytes(32).toString('base64')}\n`), 'k1');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('loadKeyring accepts the base64 text of exactly 32 bytes', () => {
    assert.equal(keyring.currentId, 'k1');
    assert.equal(keyring.keys.get('k1')?.length, 32);
  });

  test('loadKeyring refuses a key that is not exactly 32 bytes, without printing it', () => {
    const cases: Record<string, string> = {
      'one byte short': randomBytes(31).toString('base64'),
      'one byte long': randomBytes(33).toString('base64'),
      'empty file': '',
      'not base64': 'this is not a key, it is a sentence that is long enough ok',
      // 44 characters, but the URL-safe alphabet is not the one that the chart writes.
      'url safe alphabet': 'A'.repeat(42) + '-=',
    };
    for (const [label, content] of Object.entries(cases)) {
      assert.throws(() => loadKeyring(keyFile(`bad-${label.replace(/ /g, '-')}`, content), 'k1'), (error: unknown) => {
        assert.ok(error instanceof CryptoError, label);
        assert.ok(content === '' || !error.message.includes(content), `${label}: the message must not hold the content`);
        return true;
      });
    }
  });

  test('loadKeyring refuses a missing file and a bad key id', () => {
    assert.throws(() => loadKeyring(join(dir, 'missing'), 'k1'), CryptoError);
    assert.throws(() => loadKeyring(keyFile('ok2', randomBytes(32).toString('base64')), 'bad id!'), CryptoError);
  });

  test('a credential decrypts to the value that was encrypted', () => {
    const stored = encryptCredential(keyring, ID_A, 'sécret-token-✓');
    assert.equal(decryptCredential(keyring, ID_A, stored), 'sécret-token-✓');
    assert.equal(stored.nonce.length, 12);
    assert.equal(stored.keyId, 'k1');
  });

  test('the same value encrypted for two rows gives different nonces and different ciphertexts', () => {
    const one = encryptCredential(keyring, ID_A, 'same-value');
    const two = encryptCredential(keyring, ID_B, 'same-value');
    assert.notDeepEqual(one.nonce, two.nonce);
    assert.notDeepEqual(one.ciphertext, two.ciphertext);
    // Even for the same row, a second encryption differs.
    assert.notDeepEqual(one.ciphertext, encryptCredential(keyring, ID_A, 'same-value').ciphertext);
  });

  test('the ciphertext does not contain the plaintext', () => {
    const stored = encryptCredential(keyring, ID_A, 'canary-plaintext-value');
    assert.ok(!stored.ciphertext.includes('canary-plaintext-value'));
  });

  test('decryption fails for another row id', () => {
    const stored = encryptCredential(keyring, ID_A, 'value');
    assert.throws(() => decryptCredential(keyring, ID_B, stored), CryptoError);
  });

  test('decryption fails with another key and for an unknown key id', () => {
    const stored = encryptCredential(keyring, ID_A, 'value');
    const other = loadKeyring(keyFile('other', randomBytes(32).toString('base64')), 'k1');
    assert.throws(() => decryptCredential(other, ID_A, stored), CryptoError);
    assert.throws(() => decryptCredential(keyring, ID_A, { ...stored, keyId: 'k9' }), CryptoError);
  });

  test('decryption fails when the ciphertext or the nonce was changed', () => {
    const stored = encryptCredential(keyring, ID_A, 'value');
    const flipped = Buffer.from(stored.ciphertext);
    flipped[0] ^= 1;
    assert.throws(() => decryptCredential(keyring, ID_A, { ...stored, ciphertext: flipped }), CryptoError);
    assert.throws(() => decryptCredential(keyring, ID_A, { ...stored, nonce: randomBytes(12) }), CryptoError);
    assert.throws(() => decryptCredential(keyring, ID_A, { ...stored, nonce: randomBytes(8) }), CryptoError);
    assert.throws(() => decryptCredential(keyring, ID_A, { ...stored, ciphertext: Buffer.alloc(3) }), CryptoError);
  });

  test('a key from the old id still decrypts after the current id moves (rotation)', () => {
    const old = encryptCredential(keyring, ID_A, 'value');
    const rotated: Keyring = { currentId: 'k2', keys: new Map([...keyring.keys, ['k2', randomBytes(32)]]) };
    assert.equal(decryptCredential(rotated, ID_A, old), 'value');
    assert.equal(encryptCredential(rotated, ID_A, 'value').keyId, 'k2');
  });
});
