import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface Config {
  port: number;
  allowedHosts: string[];
  mcpAuthToken: string;
}

// Raised for any invalid configuration. The message names the variable and never contains a value.
export class ConfigError extends Error {}

const MIN_TOKEN_LENGTH = 32;

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  MCP_AUTH_TOKEN_FILE: z.string().min(1),
});

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

  // The token is read from a file (a mounted Kubernetes Secret), not from an environment variable.
  let mcpAuthToken: string;
  try {
    mcpAuthToken = readFileSync(parsed.data.MCP_AUTH_TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new ConfigError('MCP_AUTH_TOKEN_FILE cannot be read');
  }
  if (mcpAuthToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`MCP_AUTH_TOKEN_FILE must contain at least ${MIN_TOKEN_LENGTH} characters`);
  }

  return { port: parsed.data.PORT, allowedHosts, mcpAuthToken };
}
