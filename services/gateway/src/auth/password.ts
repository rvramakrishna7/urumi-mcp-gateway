import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// Password hashing (docs/architecture.md, decision 35): argon2id from node:crypto, no package. The stored form is the
// PHC string, which carries the algorithm and its parameters, so the parameters can change later and old hashes still
// verify with the parameters they were made with.
//   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>      (salt and hash are base64 without padding)

// The OWASP minimum for argon2id: 19 MiB of memory, 2 passes, 1 lane.
const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;

// A stored hash is read back with its own parameters. These limits stop a damaged or planted value from making one
// login use gigabytes of memory or minutes of CPU.
const MAX_MEMORY_KIB = 65_536;
const MAX_PASSES = 6;
const MAX_PARALLELISM = 4;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

// At most this many hashes run at the same time: each uses about 19 MiB, and the pod limit is 256 MiB.
const MAX_CONCURRENT_HASHES = 2;

export type Limiter = <T>(work: () => Promise<T>) => Promise<T>;

// Runs at most `max` jobs at once and queues the rest in order.
export function createLimiter(max: number): Limiter {
  let running = 0;
  const waiting: Array<() => void> = [];
  // A finished job hands its place straight to the next waiting job, so a new caller cannot slip in between.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

const limit = createLimiter(MAX_CONCURRENT_HASHES);

interface Params {
  memory: number;
  passes: number;
  parallelism: number;
}

function derive(password: string, salt: Buffer, params: Params, tagLength: number): Promise<Buffer> {
  return limit(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        argon2(
          'argon2id',
          { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: params.parallelism, tagLength, memory: params.memory, passes: params.passes },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      }),
  );
}

const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const params = { memory: MEMORY_KIB, passes: PASSES, parallelism: PARALLELISM };
  const tag = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=${VERSION}$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,6}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,86})\$([A-Za-z0-9+/]{16,86})$/;

interface Parsed extends Params {
  salt: Buffer;
  tag: Buffer;
}

function parse(stored: string): Parsed | null {
  const match = PHC.exec(stored);
  if (!match) return null;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  // Argon2 needs at least 8 KiB of memory per lane.
  if (memory < 8 * parallelism || memory > MAX_MEMORY_KIB) return null;
  if (passes < 1 || passes > MAX_PASSES) return null;
  if (parallelism < 1 || parallelism > MAX_PARALLELISM) return null;
  const salt = Buffer.from(match[4]!, 'base64');
  const tag = Buffer.from(match[5]!, 'base64');
  if (salt.length < 8 || tag.length < 16) return null;
  return { memory, passes, parallelism, salt, tag };
}

// False for a wrong password and for a stored value that is not a hash this code understands. It never throws for a bad
// stored value, so one damaged row cannot become a 500 on the login route.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const tag = await derive(password, parsed.salt, parsed, parsed.tag.length);
    return timingSafeEqual(tag, parsed.tag);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

// For an email that does not exist, or a user who has no password yet: do the same work as for a real user and say no,
// so that the time of the answer does not tell whether the email exists. A null stored hash is treated like that.
export async function verifyOrDummy(password: string, stored: string | null): Promise<boolean> {
  if (stored !== null) return verifyPassword(password, stored);
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}

// Returns the reason a password is not allowed, or null when it is. The reason never repeats the password.
// Only length and "not the email" are checked: composition rules make people choose worse passwords (NIST 800-63B).
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string') return 'the password must be text';
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return `the password must have at least ${MIN_PASSWORD_LENGTH} characters`;
  if (length > MAX_PASSWORD_LENGTH) return `the password must have at most ${MAX_PASSWORD_LENGTH} characters`;
  if (email && password.toLowerCase() === email.trim().toLowerCase()) return 'the password must not be the email';
  return null;
}
