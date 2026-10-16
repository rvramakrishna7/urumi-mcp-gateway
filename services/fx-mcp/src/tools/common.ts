import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { FxApiError } from '../fxClient.ts';
import type { FxClient } from '../fxClient.ts';
import type { Logger } from '../logger.ts';

export interface ToolDeps {
  fx: Pick<FxClient, 'getRate' | 'listCurrencies'>;
  now: () => Date;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

// A tool is plain data plus one handler. The handler returns the data to show to the caller and throws ToolInputError or
// FxApiError for the failures that are expected.
export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
  // Method syntax, so that a tool with a specific schema fits in a list of ToolDefinition<z.ZodObject>.
  handler(args: z.output<Schema>, deps: ToolDeps): Promise<unknown>;
}

// The caller sent an argument that passed the schema but cannot be used, for example a date in the future. The message is
// written for the caller.
export class ToolInputError extends Error {}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

// Turns a failed call to the rate service into text for the model. FxApiError messages are already free of URLs and bodies.
export function describeFxError(error: FxApiError): string {
  switch (error.kind) {
    case 'timeout':
      return 'The rate service did not answer in time. It may be busy or down. Try again later.';
    case 'network':
      return 'The rate service cannot be reached right now. Try again later.';
    case 'redirect':
    case 'invalid-response':
      return 'The rate service gave an unexpected answer. Try again later.';
    case 'rate-limited':
      return 'The rate service is limiting requests right now. Try again in a minute.';
    case 'not-found':
      return 'The rate service has no rate for this request. Check the currency codes, or use another date (rates exist for past days only).';
    case 'http': {
      const status = error.status ?? 0;
      if (status === 422) return 'The rate service did not accept the currency code or the date. Use ISO codes such as EUR and INR, and a date as YYYY-MM-DD.';
      if (status >= 500) return `The rate service reported an internal error (status ${status}). Try again later.`;
      return `The rate service refused the request (status ${status}).`;
    }
  }
}

// The class name of an unexpected error, for the log: it says what kind of bug it was and carries no data. A name that does
// not look like a plain identifier is replaced, because the name can be set by the thrower.
function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'invalid';
}

// Runs one tool call. It logs only the tool name, the duration and the outcome, and turns expected failures into a tool result
// with isError true, so that the model can read the reason. Nothing from the arguments or from the rate service is logged.
export async function runTool<Schema extends z.ZodObject>(
  definition: ToolDefinition<Schema>,
  args: z.output<Schema>,
  deps: ToolDeps,
  logger: Logger,
): Promise<ToolResult> {
  const start = process.hrtime.bigint();
  const done = (outcome: 'ok' | 'error', errorKind?: string, errorName?: string) => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    logger.info('tool call', { tool: definition.name, durationMs, outcome, errorKind, errorName });
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
    if (error instanceof FxApiError) {
      done('error', error.kind);
      return textResult(describeFxError(error), true);
    }
    done('error', 'unexpected', safeErrorName(error));
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
