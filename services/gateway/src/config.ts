import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax: number;
}

export interface Config {
  port: number;
  db: DbConfig;
}

// Raised for any invalid configuration. The message names the variable and never contains a value.
export class ConfigError extends Error {}

const MIN_PASSWORD_LENGTH = 16;

const dbSchema = z.object({
  DB_HOST: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  DB_USER: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  DB_PASSWORD_FILE: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

const serverSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

function invalid(error: z.ZodError): ConfigError {
  const names = [...new Set(error.issues.map((issue) => String(issue.path[0])))];
  return new ConfigError(`invalid or missing configuration: ${names.join(', ')}`);
}

// The database settings are shared by the server and by the migration runner. The password is read from a file
// (a mounted Kubernetes Secret), never from an environment variable.
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const parsed = dbSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);

  let password: string;
  try {
    password = readFileSync(parsed.data.DB_PASSWORD_FILE, 'utf8').trim();
  } catch {
    throw new ConfigError('DB_PASSWORD_FILE cannot be read');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`DB_PASSWORD_FILE must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  return {
    host: parsed.data.DB_HOST,
    port: parsed.data.DB_PORT,
    database: parsed.data.DB_NAME,
    user: parsed.data.DB_USER,
    password,
    poolMax: parsed.data.DB_POOL_MAX,
  };
}

export interface SecurityConfig {
  masterKeyFile: string;
  masterKeyId: string;
  // Optional: without it nothing is seeded.
  seedFile: string | undefined;
  // Host names that /mcp answers to (without port). Required: an empty list would turn the Host check off.
  allowedHosts: string[];
  // The origin of the dashboard, for example https://gateway.example.com (scheme, host, optional port; no path). It is the
  // only Origin that the login and the session routes accept, and its scheme decides whether the cookie is Secure.
  publicOrigin: string;
  // The first admin (decision 36). Both values or neither: the e-mail, and the file that holds the invite token.
  bootstrap: { adminEmail: string; tokenFile: string } | undefined;
}

const securitySchema = z.object({
  MASTER_KEY_FILE: z.string().min(1),
  MASTER_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('k1'),
  SEED_FILE: z.string().min(1).optional(),
  ALLOWED_HOSTS: z.string().min(1),
  PUBLIC_ORIGIN: z.string().min(1),
  BOOTSTRAP_ADMIN_EMAIL: z.string().min(1).optional(),
  BOOTSTRAP_TOKEN_FILE: z.string().min(1).optional(),
});

// Returns the origin when the value is exactly an origin, and null otherwise.
function exactOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  // "https://host/" and "https://host" are the same origin; a trailing slash is not part of an Origin header.
  return value === url.origin || value === `${url.origin}/` ? url.origin : null;
}

// Paths and ids only. The key itself is read from the file by loadKeyring().
export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const parsed = securitySchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);
  const allowedHosts = parsed.data.ALLOWED_HOSTS.split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (allowedHosts.length === 0) throw new ConfigError('invalid or missing configuration: ALLOWED_HOSTS');
  const publicOrigin = exactOrigin(parsed.data.PUBLIC_ORIGIN.trim());
  if (!publicOrigin) throw new ConfigError('invalid or missing configuration: PUBLIC_ORIGIN');
  const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_TOKEN_FILE: tokenFile } = parsed.data;
  let bootstrap: SecurityConfig['bootstrap'];
  if (email !== undefined || tokenFile !== undefined) {
    const adminEmail = email?.trim().toLowerCase() ?? '';
    if (!tokenFile || !/^[^\s@]+@[^\s@]+$/.test(adminEmail) || adminEmail.length > 254) {
      throw new ConfigError('invalid or missing configuration: BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_TOKEN_FILE (set both or neither)');
    }
    bootstrap = { adminEmail, tokenFile };
  }
  return { masterKeyFile: parsed.data.MASTER_KEY_FILE, masterKeyId: parsed.data.MASTER_KEY_ID, seedFile: parsed.data.SEED_FILE, allowedHosts, publicOrigin, bootstrap };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = serverSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);
  return { port: parsed.data.PORT, db: loadDbConfig(env) };
}
