import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Logger } from '../logger.ts';
import { WooApiError } from '../wooClient.ts';
import type { WooClient } from '../wooClient.ts';

export interface ToolDeps {
  woo: Pick<WooClient, 'request'>;
  storeTimezone: string;
  now: () => Date;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

// A tool is plain data plus one handler. The handler returns the data to show to the caller and throws
// ToolInputError or WooApiError for the failures that are expected.
export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
  // Method syntax, so that a tool with a specific schema fits in a list of ToolDefinition<z.ZodObject>.
  handler(args: z.output<Schema>, deps: ToolDeps): Promise<unknown>;
}

// The caller sent an argument that passed the schema but cannot be used, for example a date range that
// ends before it starts. The message is written for the caller.
export class ToolInputError extends Error {}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

// Turns a failed WooCommerce call into text for the model. WooApiError messages are already free of the key,
// the secret, URLs and raw bodies, so they may be shown.
export function describeWooError(error: WooApiError): string {
  switch (error.kind) {
    case 'timeout':
      return 'The WooCommerce store did not answer in time. It may be busy or down. Try again later.';
    case 'network':
      return 'The WooCommerce store cannot be reached right now. Try again later.';
    case 'redirect':
    case 'invalid-response':
      return 'The WooCommerce store gave an unexpected answer. Try again later.';
    case 'http': {
      const status = error.status ?? 0;
      if (status === 401 || status === 403) {
        return `WooCommerce refused the request (status ${status}). The account used by this server may lack permission.`;
      }
      if (status >= 500) return `WooCommerce reported an internal error (status ${status}). Try again later.`;
      return error.message;
    }
  }
}

// Runs one tool call. It measures the duration, logs only the tool name, the duration and the outcome, and
// turns expected failures into a tool result with isError true, so that the model can read the reason.
// Nothing from the arguments or from WooCommerce is logged.
export async function runTool<Schema extends z.ZodObject>(
  definition: ToolDefinition<Schema>,
  args: z.output<Schema>,
  deps: ToolDeps,
  logger: Logger,
): Promise<ToolResult> {
  const start = process.hrtime.bigint();
  const done = (outcome: 'ok' | 'error', errorKind?: string) => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    logger.info('tool call', { tool: definition.name, durationMs, outcome, errorKind });
  };
  try {
    const data = await definition.handler(args, deps);
    done('ok');
    return textResult(JSON.stringify(data));
  } catch (error) {
    if (error instanceof ToolInputError) {
      done('error', 'input');
      return textResult(error.message, true);
    }
    if (error instanceof WooApiError) {
      done('error', error.kind);
      return textResult(describeWooError(error), true);
    }
    done('error', 'unexpected');
    return textResult('The tool failed because of an unexpected error in this server.', true);
  }
}

// The SDK validates the arguments with the schema before the callback runs. A strict schema rejects unknown keys.
export function registerTool(server: McpServer, definition: ToolDefinition<z.ZodObject>, deps: ToolDeps, logger: Logger): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
    },
    async (args) => runTool(definition, args, deps, logger),
  );
}
