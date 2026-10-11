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
}

const securitySchema = z.object({
  MASTER_KEY_FILE: z.string().min(1),
  MASTER_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('k1'),
  SEED_FILE: z.string().min(1).optional(),
  ALLOWED_HOSTS: z.string().min(1),
});

// Paths and ids only. The key itself is read from the file by loadKeyring().
export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const parsed = securitySchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);
  const allowedHosts = parsed.data.ALLOWED_HOSTS.split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (allowedHosts.length === 0) throw new ConfigError('invalid or missing configuration: ALLOWED_HOSTS');
  return { masterKeyFile: parsed.data.MASTER_KEY_FILE, masterKeyId: parsed.data.MASTER_KEY_ID, seedFile: parsed.data.SEED_FILE, allowedHosts };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = serverSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);
  return { port: parsed.data.PORT, db: loadDbConfig(env) };
}
