import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isValidTimeZone } from './timezone.ts';

export interface Config {
  port: number;
  allowedHosts: string[];
  mcpAuthToken: string;
  // The address that woo-mcp calls: the in-cluster WordPress Service.
  wooBaseUrl: string;
  // The public home URL of the store. OAuth signatures are computed for this address (decision 15).
  wooPublicUrl: string;
  wooConsumerKey: string;
  wooConsumerSecret: string;
  // IANA timezone of the store. It decides what "today" means.
  storeTimezone: string;
  wooRequestTimeoutMs: number;
}

// Raised for any invalid configuration. The message names the variable and never contains a value.
export class ConfigError extends Error {}

const MIN_TOKEN_LENGTH = 32;

// An http or https URL with no credentials, query string or fragment.
function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

// The URL without trailing slashes, so that a path can be appended to it.
function withoutTrailingSlash(value: string): string {
  return new URL(value).href.replace(/\/+$/, '');
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  MCP_AUTH_TOKEN_FILE: z.string().min(1),
  WOO_BASE_URL: z.string().refine(isPlainHttpUrl),
  WOO_PUBLIC_URL: z.string().refine(isPlainHttpUrl),
  WOO_CONSUMER_KEY_FILE: z.string().min(1),
  WOO_CONSUMER_SECRET_FILE: z.string().min(1),
  STORE_TIMEZONE: z.string().refine(isValidTimeZone),
  WOO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
});

// Credentials are read from files (mounted Kubernetes Secrets), not from environment variables.
function readSecretFile(variable: string, path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw new ConfigError(`${variable} cannot be read`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`invalid or missing configuration: ${names.join(', ')}`);
  }

  const allowedHosts = parsed.data.ALLOWED_HOSTS.split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (allowedHosts.length === 0) {
    throw new ConfigError('invalid or missing configuration: ALLOWED_HOSTS');
  }

  const mcpAuthToken = readSecretFile('MCP_AUTH_TOKEN_FILE', parsed.data.MCP_AUTH_TOKEN_FILE);
  if (mcpAuthToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`MCP_AUTH_TOKEN_FILE must contain at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const wooConsumerKey = readSecretFile('WOO_CONSUMER_KEY_FILE', parsed.data.WOO_CONSUMER_KEY_FILE);
  if (wooConsumerKey.length === 0) {
    throw new ConfigError('WOO_CONSUMER_KEY_FILE must not be empty');
  }
  const wooConsumerSecret = readSecretFile('WOO_CONSUMER_SECRET_FILE', parsed.data.WOO_CONSUMER_SECRET_FILE);
  if (wooConsumerSecret.length === 0) {
    throw new ConfigError('WOO_CONSUMER_SECRET_FILE must not be empty');
  }

  return {
    port: parsed.data.PORT,
    allowedHosts,
    mcpAuthToken,
    wooBaseUrl: withoutTrailingSlash(parsed.data.WOO_BASE_URL),
    wooPublicUrl: withoutTrailingSlash(parsed.data.WOO_PUBLIC_URL),
    wooConsumerKey,
    wooConsumerSecret,
    storeTimezone: parsed.data.STORE_TIMEZONE,
    wooRequestTimeoutMs: parsed.data.WOO_REQUEST_TIMEOUT_MS,
  };
}
