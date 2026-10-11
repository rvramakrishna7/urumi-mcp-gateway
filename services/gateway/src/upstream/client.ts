import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { PlainCredential } from '../registry/repository.ts';
import { VERSION } from '../version.ts';

// The only code in the gateway that talks to an upstream MCP server (docs/architecture.md, decision 28).
// One connection per call: connect, do the work, close. Upstreams are stateless, so nothing is held between calls.

export interface UpstreamLimits {
  connectTimeoutMs: number;
  listTimeoutMs: number;
  // All HTTP responses of one session together, not each one.
  maxResponseBytes: number;
}

export const DEFAULT_LIMITS: UpstreamLimits = { connectTimeoutMs: 3000, listTimeoutMs: 5000, maxResponseBytes: 2 * 1024 * 1024 };

export interface UpstreamTarget {
  url: string;
  credential: PlainCredential | null;
}

export type Stage = 'connect' | 'list' | 'call';
export type FailureKind = 'timeout' | 'refused' | 'unauthorized' | 'forbidden' | 'http_error' | 'unreachable' | 'protocol_error' | 'too_large';

// What went wrong, as two fixed words. It never carries a message, a URL, a header or a body of the upstream:
// SDK errors are mapped by class and status, because their messages can hold the upstream's text.
export class UpstreamError extends Error {
  readonly kind: FailureKind;
  readonly stage: Stage;
  constructor(kind: FailureKind, stage: Stage) {
    super(`upstream ${kind} during ${stage}`);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.stage = stage;
  }
}

export interface UpstreamCallResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Session {
  stage: Stage;
  timedOut: Stage | null;
  tooLarge: boolean;
  bytes: number;
}

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

function credentialHeaders(credential: PlainCredential | null): Record<string, string> {
  if (!credential) return {};
  return credential.kind === 'bearer' ? { Authorization: `Bearer ${credential.value}` } : { [credential.header ?? '']: credential.value };
}

// The fetch of every request of a session: no redirects (a redirect could send the credential to another host), the
// deadline of the session as an abort signal, and a cap on the bytes that an upstream can make the gateway read.
function guardedFetch(session: Session, controller: AbortController, maxBytes: number): FetchLike {
  return async (url, init) => {
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, { ...init, redirect: 'error', signal });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes - session.bytes) {
      session.tooLarge = true;
      controller.abort();
      throw new Error('response too large');
    }
    if (!response.body || NO_BODY_STATUS.has(response.status)) return response;

    const reader = response.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(stream) {
        const { done, value } = await reader.read();
        if (done) {
          stream.close();
          return;
        }
        session.bytes += value.byteLength;
        if (session.bytes > maxBytes) {
          session.tooLarge = true;
          controller.abort();
          stream.error(new Error('response too large'));
          await reader.cancel().catch(() => {});
          return;
        }
        stream.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function classify(error: unknown, session: Session): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (session.tooLarge) return new UpstreamError('too_large', session.stage);
  if (session.timedOut) return new UpstreamError('timeout', session.timedOut);
  if (error instanceof SdkHttpError) {
    const status = error.status;
    return new UpstreamError(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'http_error', session.stage);
  }
  if (error instanceof UnauthorizedError) return new UpstreamError('unauthorized', session.stage);
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return new UpstreamError('timeout', session.stage);
  if (error instanceof TypeError) {
    // A failed fetch: the cause carries the system error code (ECONNREFUSED, ENOTFOUND, ECONNRESET ...).
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return new UpstreamError(code === 'ECONNREFUSED' ? 'refused' : 'unreachable', session.stage);
  }
  return new UpstreamError('protocol_error', session.stage);
}

interface RequestOptions {
  timeout: number;
  signal: AbortSignal;
}

// Connects (limit: connectTimeoutMs), then runs "work" under its own deadline, then closes. Every failure leaves as
// an UpstreamError.
async function withSession<T>(
  target: UpstreamTarget,
  limits: UpstreamLimits,
  stage: Exclude<Stage, 'connect'>,
  workTimeoutMs: number,
  work: (client: Client, options: RequestOptions) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const session: Session = { stage: 'connect', timedOut: null, tooLarge: false, bytes: 0 };
  let timer: NodeJS.Timeout | undefined;
  const arm = (next: Stage, ms: number) => {
    clearTimeout(timer);
    session.stage = next;
    timer = setTimeout(() => {
      session.timedOut = next;
      controller.abort();
    }, ms);
  };

  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: credentialHeaders(target.credential), redirect: 'error' },
    fetch: guardedFetch(session, controller, limits.maxResponseBytes),
  });
  const client = new Client({ name: 'urumi-gateway', version: VERSION });

  try {
    arm('connect', limits.connectTimeoutMs);
    await client.connect(transport, { timeout: limits.connectTimeoutMs, signal: controller.signal });
    arm(stage, workTimeoutMs);
    return await work(client, { timeout: workTimeoutMs, signal: controller.signal });
  } catch (error) {
    throw classify(error, session);
  } finally {
    clearTimeout(timer);
    // A closing session must not hold the caller: give it one second, then cut every open request.
    let closeTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(closeTimer);
    controller.abort();
  }
}

// The tools that the upstream lists, as received (untrusted: see sanitize.ts).
export async function listUpstreamTools(target: UpstreamTarget, limits: UpstreamLimits = DEFAULT_LIMITS): Promise<unknown[]> {
  return withSession(target, limits, 'list', limits.listTimeoutMs, async (client, options) => (await client.listTools(undefined, options)).tools);
}

export async function callUpstreamTool(
  target: UpstreamTarget,
  tool: string,
  args: Record<string, unknown>,
  callTimeoutMs: number,
  limits: UpstreamLimits = DEFAULT_LIMITS,
): Promise<UpstreamCallResult> {
  return withSession(target, limits, 'call', callTimeoutMs, async (client, options) => {
    const result = await client.callTool({ name: tool, arguments: args }, options);
    const output: UpstreamCallResult = { content: Array.isArray(result.content) ? result.content : [] };
    if (result.structuredContent && typeof result.structuredContent === 'object') output.structuredContent = result.structuredContent as Record<string, unknown>;
    if (result.isError === true) output.isError = true;
    return output;
  });
}
