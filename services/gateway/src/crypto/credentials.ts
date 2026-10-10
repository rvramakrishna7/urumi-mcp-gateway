import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// AES-256-GCM for upstream credentials (docs/architecture.md, decision 30).
// Stored form: ciphertext (the encrypted bytes followed by the 16 byte authentication tag), a random 12 byte nonce
// and the id of the key that was used. The id of the upstream server is the additional authenticated data, so a
// ciphertext copied to another row does not decrypt.

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
// 32 bytes in standard base64 are exactly 43 characters and one "=".
const KEY_FILE_FORMAT = /^[A-Za-z0-9+/]{43}=$/;

// The messages never contain key material or the plaintext.
export class CryptoError extends Error {}

export interface Keyring {
  // The key that new ciphertexts are made with.
  currentId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  keyId: string;
}

// The master key file holds the base64 text of 32 random bytes (the chart generates them with randBytes). A key
// that is not exactly 32 bytes is refused at start, never padded or cut.
export function loadKeyring(file: string, keyId: string): Keyring {
  if (!KEY_ID.test(keyId)) throw new CryptoError('MASTER_KEY_ID is not a valid key id');
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    throw new CryptoError('MASTER_KEY_FILE cannot be read');
  }
  if (!KEY_FILE_FORMAT.test(text)) throw new CryptoError('MASTER_KEY_FILE must hold the base64 text of exactly 32 bytes');
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES) throw new CryptoError('MASTER_KEY_FILE must hold exactly 32 bytes');
  return { currentId: keyId, keys: new Map([[keyId, key]]) };
}

export function encryptCredential(keyring: Keyring, serverId: string, plaintext: string): EncryptedCredential {
  const key = keyring.keys.get(keyring.currentId);
  if (!key) throw new CryptoError('the current key is not in the keyring');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(serverId, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]), nonce, keyId: keyring.currentId };
}

export function decryptCredential(keyring: Keyring, serverId: string, stored: EncryptedCredential): string {
  const key = keyring.keys.get(stored.keyId);
  if (!key) throw new CryptoError('the key of this credential is not in the keyring');
  if (stored.nonce.length !== NONCE_BYTES || stored.ciphertext.length < TAG_BYTES) {
    throw new CryptoError('the stored credential is malformed');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, stored.nonce);
    decipher.setAAD(Buffer.from(serverId, 'utf8'));
    decipher.setAuthTag(stored.ciphertext.subarray(stored.ciphertext.length - TAG_BYTES));
    const body = stored.ciphertext.subarray(0, stored.ciphertext.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // A wrong key, a wrong server id or a changed ciphertext all end here, and say nothing more.
    throw new CryptoError('the credential cannot be decrypted');
  }
}
