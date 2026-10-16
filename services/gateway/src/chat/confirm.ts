import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Keyring } from '../crypto/credentials.ts';

// The confirmation of a write tool in the chat agent (docs/architecture.md, decision 40). When the model asks for a tool
// on the confirm list, the server does not run it. It returns a token, the dashboard shows the call to the user, and the
// call runs only when the browser sends the token back with the same user, tool name and arguments. The check is on the
// server, so a request posted directly to the route cannot skip the confirmation.

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
const KEY_INFO = 'urumi-gateway chat confirmation v1';
const MAX_DEPTH = 20;
// "<expiry in ms, decimal>.<hex of the HMAC-SHA-256>"
const TOKEN_FORMAT = /^[0-9]{1,16}\.[0-9a-f]{64}$/;

export class ConfirmError extends Error {}

// The key is derived from the master key, so it is a different key from the one that encrypts the credentials, and it
// needs no new Secret. A different master key gives a different confirmation key, so old tokens stop working.
function confirmKey(keyring: Keyring): Buffer {
  const master = keyring.keys.get(keyring.currentId);
  if (!master) throw new ConfirmError('the current key is not in the keyring');
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), KEY_INFO, 32));
}

// The same arguments always give the same text, whatever the order of the keys, so the token binds the values.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new ConfirmError('arguments are nested too deeply');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfirmError('arguments hold a number that JSON cannot carry');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`);
    return `{${entries.join(',')}}`;
  }
  throw new ConfirmError('arguments hold a value that JSON cannot carry');
}

// Each part is length-prefixed, so ("ab", "c") and ("a", "bc") cannot give the same message.
function message(userId: string, name: string, args: unknown, expiresAtMs: number): string {
  const parts = [userId, name, canonicalJson(args), String(expiresAtMs)];
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function mac(keyring: Keyring, text: string): Buffer {
  return createHmac('sha256', confirmKey(keyring)).update(text, 'utf8').digest();
}

export interface ConfirmSubject {
  userId: string;
  name: string;
  args: unknown;
}

export function issueConfirmToken(keyring: Keyring, subject: ConfirmSubject, now: number = Date.now()): string {
  const expiresAtMs = now + CONFIRM_TTL_MS;
  return `${expiresAtMs}.${mac(keyring, message(subject.userId, subject.name, subject.args, expiresAtMs)).toString('hex')}`;
}

// False for anything that is not a valid token for exactly this user, tool and arguments, and for an expired one. It
// never throws on input from the browser.
export function verifyConfirmToken(keyring: Keyring, token: unknown, subject: ConfirmSubject, now: number = Date.now()): boolean {
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return false;
  const [expiry, given] = token.split('.') as [string, string];
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < now) return false;
  let expected: Buffer;
  try {
    expected = mac(keyring, message(subject.userId, subject.name, subject.args, expiresAtMs));
  } catch {
    return false;
  }
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

// Exact match on the exposed name: "woo__create_product" is on the list, "woo__create_product2" and a case change are not.
export function requiresConfirmation(exposedName: string, confirmTools: readonly string[]): boolean {
  return confirmTools.includes(exposedName);
}
