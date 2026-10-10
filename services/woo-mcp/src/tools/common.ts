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

// Text that is stored in the store must be plain text. Input with < or > is rejected, not stripped, so the
// caller sees what was wrong and nothing is changed silently. WordPress also filters HTML when the service
// account saves it (the account has no unfiltered_html capability, which the store test asserts), but this check
// does not depend on that. It runs before any request is sent to WooCommerce.
export function assertPlainText(field: string, value: string): void {
  if (/[<>]/.test(value)) {
    throw new ToolInputError(`${field} must be plain text and must not contain < or >. Remove those characters and try again.`);
  }
}

const MAX_TEXT_LENGTH = 200;

// Text that a customer controls (a name, a coupon code, a product name in an order) reaches the model through
// the tool output. It is data, never an instruction, and this helper limits what it can carry: it replaces line
// breaks and tabs with a space, removes the other control characters and the invisible and direction-changing
// characters that can hide or reorder text, and caps the length. It cannot make the text trustworthy: that
// control is on the gateway and agent side (docs/architecture.md, decision 19).
export function safeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    // Line breaks and tabs become a space, so that words do not run together.
    .replace(/[\t\n\r\u2028\u2029]+/g, ' ')
    // Other control characters (C0, DEL, C1), the soft hyphen, zero-width characters, direction marks and
    // overrides, word joiners and the byte order mark.
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const characters = [...cleaned];
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join('')}...` : cleaned;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

// Turns a failed WooCommerce call into text for the model. WooApiError messages are already free of the key,
// the secret, URLs and raw bodies, so they may be shown. For a tool that changes data, a timeout or an answer
// that cannot be read does not tell whether the change was applied, so the text says so: a retry could
// otherwise create a second product.
export function describeWooError(error: WooApiError, readOnly = true): string {
  const maybeApplied = ' The change may have been applied. Check the current state before trying again.';
  switch (error.kind) {
    case 'timeout':
      return readOnly
        ? 'The WooCommerce store did not answer in time. It may be busy or down. Try again later.'
        : `The WooCommerce store did not answer in time. It may be busy or down.${maybeApplied}`;
    case 'network':
      return 'The WooCommerce store cannot be reached right now. Try again later.';
    case 'redirect':
      return 'The WooCommerce store gave an unexpected answer. Try again later.';
    case 'invalid-response':
      return readOnly
        ? 'The WooCommerce store gave an unexpected answer. Try again later.'
        : `The WooCommerce store gave an unexpected answer.${maybeApplied}`;
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

function hasNumericId(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'number';
}

// WooCommerce answered with a status that says success, but the body is not what the tool needs. This is
// reported as an invalid-response error and not left to fail later inside the mapping.
function unexpectedShape(what: string): WooApiError {
  return new WooApiError('invalid-response', `WooCommerce answered with a body of an unexpected shape (${what})`);
}

// A list answer: an array in which every element is an object with a numeric id.
export function expectArray<T>(data: unknown): T[] {
  if (!Array.isArray(data) || !data.every(hasNumericId)) throw unexpectedShape('a list of items with ids was expected');
  return data as T[];
}

// A single item: an object with a numeric id and, where the tool needs them, string fields.
export function expectItem<T>(data: unknown, stringFields: string[] = []): T {
  if (!hasNumericId(data)) throw unexpectedShape('an item with an id was expected');
  for (const field of stringFields) {
    if (typeof (data as Record<string, unknown>)[field] !== 'string') throw unexpectedShape(`the field ${field} is missing`);
  }
  return data as T;
}

// The class name of an unexpected error, for the log: it says what kind of bug it was and carries no data. A
// name that does not look like a plain identifier is replaced, because the name can be set by the thrower.
// The message and the stack are never logged.
function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'invalid';
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
    if (error instanceof WooApiError) {
      done('error', error.kind);
      return textResult(describeWooError(error, definition.annotations.readOnlyHint), true);
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
