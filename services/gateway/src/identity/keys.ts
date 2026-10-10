import { createHash, randomBytes } from 'node:crypto';

// API keys of users (docs/architecture.md, decision 4): 32 random bytes with a fixed prefix. Only the SHA-256 hash is
// stored. A key has 256 bits of randomness, so a fast hash is enough (a slow hash is for passwords, which are guessable).
export const API_KEY_PREFIX = 'mcpgw_';
const API_KEY_FORMAT = /^mcpgw_[A-Za-z0-9_-]{43}$/;
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 4;

export interface NewApiKey {
  key: string;
  hash: Buffer;
  // The first characters, so that a person can tell their keys apart. Not enough to use the key.
  displayPrefix: string;
}

export function generateApiKey(): NewApiKey {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashApiKey(key), displayPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

// A cheap check before the database is asked.
export function looksLikeApiKey(value: string): boolean {
  return API_KEY_FORMAT.test(value);
}
