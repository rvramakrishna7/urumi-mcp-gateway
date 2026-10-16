import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface Config {
  port: number;
  allowedHosts: string[];
  mcpAuthToken: string;
  // The rate service that fx-mcp calls. It is configuration only: no tool takes an address (decision 41).
  fxBaseUrl: string;
  fxRequestTimeoutMs: number;
}

// Raised for any invalid configuration. The message names the variable and never contains a value.
export class ConfigError extends Error {}

const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_FX_BASE_URL = 'https://api.frankfurter.dev';

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

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  MCP_AUTH_TOKEN_FILE: z.string().min(1),
  FX_BASE_URL: z.string().refine(isPlainHttpUrl).default(DEFAULT_FX_BASE_URL),
  FX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8000),
});

// The token is read from a file (a mounted Kubernetes Secret), not from an environment variable.
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

  return {
    port: parsed.data.PORT,
    allowedHosts,
    mcpAuthToken,
    fxBaseUrl: new URL(parsed.data.FX_BASE_URL).href.replace(/\/+$/, ''),
    fxRequestTimeoutMs: parsed.data.FX_REQUEST_TIMEOUT_MS,
  };
}
