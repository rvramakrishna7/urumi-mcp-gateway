import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SLUG } from './registry/validation.ts';
import { parseUpstreamPolicy, UpstreamPolicyError } from './upstream/ssrf.ts';
import type { UpstreamPolicy } from './upstream/ssrf.ts';

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

export interface ChatConfig {
  // Undefined when the Secret is not there: the chat endpoint then answers 503 and the rest of the gateway is unchanged.
  groqApiKey: string | undefined;
  model: string;
  // Exposed tool names that need a confirmation before they run (docs/architecture.md, decision 40).
  confirmTools: string[];
  ratePerMinute: number;
}

export const DEFAULT_CHAT_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_CONFIRM_TOOLS = ['woo__create_product', 'woo__update_order_status', 'fetch__fetch'];
const DEFAULT_CHAT_RATE_PER_MINUTE = 10;
const GROQ_KEY_FORMAT = /^[\x21-\x7e]{8,200}$/;
const CONFIRM_TOOL_NAME = /^[A-Za-z0-9_-]{1,100}$/;

const chatSchema = z.object({
  GROQ_API_KEY_FILE: z.string().min(1).optional(),
  CHAT_MODEL: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).default(DEFAULT_CHAT_MODEL),
  // A list that is set must not be empty: an empty value would switch the confirmation off without anybody deciding it.
  CHAT_CONFIRM_TOOLS: z.string().min(1).optional(),
  CHAT_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(DEFAULT_CHAT_RATE_PER_MINUTE),
});

// The Groq key is read from a file (a mounted Kubernetes Secret), never from an environment variable. A file that does not
// exist means "chat is not configured". A file that exists and is empty or malformed is a mistake and stops the start.
export function loadChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  const parsed = chatSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);

  let groqApiKey: string | undefined;
  const file = parsed.data.GROQ_API_KEY_FILE;
  if (file !== undefined) {
    let text: string | undefined;
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError('GROQ_API_KEY_FILE cannot be read');
    }
    if (text !== undefined) {
      if (!GROQ_KEY_FORMAT.test(text)) throw new ConfigError('GROQ_API_KEY_FILE must hold one key of 8 to 200 printable characters');
      groqApiKey = text;
    }
  }

  let confirmTools = DEFAULT_CONFIRM_TOOLS;
  if (parsed.data.CHAT_CONFIRM_TOOLS !== undefined) {
    confirmTools = parsed.data.CHAT_CONFIRM_TOOLS.split(',').map((name) => name.trim());
    if (confirmTools.length === 0 || !confirmTools.every((name) => CONFIRM_TOOL_NAME.test(name))) {
      throw new ConfigError('invalid or missing configuration: CHAT_CONFIRM_TOOLS');
    }
  }

  return { groqApiKey, model: parsed.data.CHAT_MODEL, confirmTools, ratePerMinute: parsed.data.CHAT_RATE_PER_MINUTE };
}

export const DEFAULT_MEMBER_RESTRICTED_TOOLS = ['woo__create_product', 'woo__update_order_status', 'fetch__fetch'];
// <slug>__<tool>. The slug part is the registry's SLUG without its anchors, so the two rules cannot drift apart.
const RESTRICTED_TOOL_NAME = new RegExp(`^${SLUG.source.slice(1, -1)}__[A-Za-z0-9_-]{1,100}$`);

export interface AccessConfig {
  // Exposed tool names (<slug>__<tool>) that only an admin may list or call.
  memberRestrictedTools: string[];
}

const accessSchema = z.object({
  // A list that is set must not be empty: an empty value would lift the restriction without anybody deciding it.
  MEMBER_RESTRICTED_TOOLS: z.string().min(1).optional(),
});

export function loadAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const parsed = accessSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);
  let memberRestrictedTools = DEFAULT_MEMBER_RESTRICTED_TOOLS;
  if (parsed.data.MEMBER_RESTRICTED_TOOLS !== undefined) {
    memberRestrictedTools = parsed.data.MEMBER_RESTRICTED_TOOLS.split(',').map((name) => name.trim());
    if (!memberRestrictedTools.every((name) => RESTRICTED_TOOL_NAME.test(name))) {
      throw new ConfigError('invalid or missing configuration: MEMBER_RESTRICTED_TOOLS');
    }
  }
  return { memberRestrictedTools };
}

export interface UpstreamPolicyConfig {
  policy: UpstreamPolicy;
  // The namespace of this pod. Names inside it (PostgreSQL) can never be an upstream.
  ownNamespace: string;
}

const upstreamPolicySchema = z.object({
  UPSTREAM_ALLOWED_HOSTS: z.string().min(1),
  POD_NAMESPACE: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
});

export function loadUpstreamPolicyConfig(env: NodeJS.ProcessEnv = process.env): UpstreamPolicyConfig {
  const parsed = upstreamPolicySchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error);
  try {
    return { policy: parseUpstreamPolicy(parsed.data.UPSTREAM_ALLOWED_HOSTS, parsed.data.POD_NAMESPACE), ownNamespace: parsed.data.POD_NAMESPACE };
  } catch (error) {
    // The message of an UpstreamPolicyError names the position of the entry and the problem, never a value.
    if (error instanceof UpstreamPolicyError) throw new ConfigError(`invalid or missing configuration: UPSTREAM_ALLOWED_HOSTS (${error.message})`);
    throw error;
  }
}
