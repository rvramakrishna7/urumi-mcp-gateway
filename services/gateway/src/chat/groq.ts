// The client of the Groq chat completions API (docs/architecture.md, decision 40). Built on the fetch of Node: no SDK.
// The key goes in the Authorization header and nowhere else. An error carries a kind and nothing from the answer of Groq:
// no body, no header and no key reach a log, a caller or the browser.

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export interface GroqToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: GroqToolCall[] }
  // No "name" field: the OpenAI-compatibility page of Groq lists messages[].name as unsupported.
  | { role: 'tool'; tool_call_id: string; content: string };

export interface GroqTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GroqCompletion {
  // Only the content and the tool calls: the reasoning of the model is not kept.
  message: { content: string | null; tool_calls: GroqToolCall[] };
  finishReason: string | null;
  totalTokens: number | null;
}

export type GroqErrorKind = 'auth' | 'bad_request' | 'rate_limited' | 'timeout' | 'unavailable' | 'too_large' | 'invalid_response';

export class GroqError extends Error {
  readonly kind: GroqErrorKind;
  // Only for rate_limited, and only when Groq sent a usable retry-after.
  readonly retryAfterSeconds: number | null;
  constructor(kind: GroqErrorKind, retryAfterSeconds: number | null = null) {
    super(kind);
    this.name = 'GroqError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GroqClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxCompletionTokens?: number;
}

export interface GroqClient {
  complete(messages: ChatMessage[], tools: GroqTool[], timeoutMs?: number): Promise<GroqCompletion>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;
const MAX_ID = 200;
const MAX_NAME = 200;
const MAX_ARGUMENTS = 20_000;

// A read of the body that stops at the cap. A server that sends more is cut off, not buffered.
async function readCapped(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw new GroqError('too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new GroqError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfterOf(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  const seconds = Number(value);
  return seconds > 0 ? seconds : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Checks the shape that the loop relies on. Anything else is "invalid_response", never passed on.
function parseCompletion(text: string): GroqCompletion {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GroqError('invalid_response');
  }
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  if (!isRecord(message)) throw new GroqError('invalid_response');
  const content = message.content;
  if (content !== null && content !== undefined && typeof content !== 'string') throw new GroqError('invalid_response');

  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw new GroqError('invalid_response');
  const toolCalls: GroqToolCall[] = rawCalls.map((raw) => {
    const fn = isRecord(raw) ? raw.function : undefined;
    if (!isRecord(raw) || !isRecord(fn)) throw new GroqError('invalid_response');
    const { id, type } = raw;
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID || (type !== undefined && type !== 'function')) throw new GroqError('invalid_response');
    if (typeof fn.name !== 'string' || fn.name.length < 1 || fn.name.length > MAX_NAME) throw new GroqError('invalid_response');
    if (typeof fn.arguments !== 'string' || fn.arguments.length > MAX_ARGUMENTS) throw new GroqError('invalid_response');
    return { id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
  });

  const usage = isRecord(body) ? body.usage : undefined;
  const total = isRecord(usage) && typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens) ? usage.total_tokens : null;
  return {
    message: { content: typeof content === 'string' ? content : null, tool_calls: toolCalls },
    finishReason: typeof (choice as Record<string, unknown>).finish_reason === 'string' ? ((choice as Record<string, unknown>).finish_reason as string) : null,
    totalTokens: total,
  };
}

export function createGroqClient({
  apiKey,
  model,
  baseUrl = GROQ_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
}: GroqClientOptions): GroqClient {
  // The models that reason (gpt-oss) take reasoning_effort and include_reasoning. A low effort keeps the output tokens, and so the
  // 8000 tokens per minute of the free tier, small. They are sent for these models only: another model may answer 400.
  const reasons = model.startsWith('openai/gpt-oss');

  async function complete(messages: ChatMessage[], tools: GroqTool[], callTimeoutMs: number = timeoutMs): Promise<GroqCompletion> {
    // parallel_tool_calls is not sent: gpt-oss does not support parallel calls and the loop uses the first call only.
    const body = {
      model,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      max_completion_tokens: maxCompletionTokens,
      ...(reasons ? { reasoning_effort: 'low', include_reasoning: false } : {}),
    };
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, callTimeoutMs)),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw new GroqError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable');
    }

    try {
      if (response.status === 401 || response.status === 403) throw new GroqError('auth');
      if (response.status === 429) throw new GroqError('rate_limited', retryAfterOf(response));
      if (response.status >= 500) throw new GroqError('unavailable');
      if (response.status !== 200) throw new GroqError('bad_request');
      return parseCompletion(await readCapped(response, maxResponseBytes));
    } catch (error) {
      if (error instanceof GroqError) throw error;
      const name = (error as { name?: string } | null)?.name;
      throw new GroqError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable');
    } finally {
      // An answer that was refused before it was read must not keep the connection busy.
      await response.body?.cancel().catch(() => {});
    }
  }

  return { complete };
}
