import { buildAuthorizationHeader, percentEncode } from './oauth.ts';
import type { QueryParams } from './oauth.ts';

export interface WooClientOptions {
  // The address that is called: the in-cluster WordPress Service.
  baseUrl: string;
  // The public home URL of the store. The signature is computed for it (decision 15).
  publicUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
  // Only tests replace this.
  fetch?: typeof fetch;
}

export interface WooRequest {
  // Starts with a slash and carries no query string, for example /wp-json/wc/v3/orders.
  path: string;
  query?: QueryParams;
  // Sent as JSON. OAuth 1.0a does not sign a JSON body (decision 15), so only the method, the URL and the
  // query are covered by the signature.
  body?: unknown;
}

export interface WooResponse<T = unknown> {
  status: number;
  data: T;
}

export type WooErrorKind = 'timeout' | 'network' | 'redirect' | 'http' | 'invalid-response';

// Every failure of a WooCommerce call. The message is safe to show to a tool caller: it never contains the
// consumer key, the consumer secret, a URL or an Authorization header.
export class WooApiError extends Error {
  readonly kind: WooErrorKind;
  readonly status: number | undefined;
  // The WooCommerce error code, for example woocommerce_rest_cannot_view.
  readonly code: string | undefined;

  constructor(kind: WooErrorKind, message: string, details: { status?: number; code?: string } = {}) {
    super(message);
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
  }
}

const MAX_WOO_MESSAGE_LENGTH = 200;
// A larger answer is refused, so that one call cannot fill the memory of the server.
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class WooClient {
  private readonly options: WooClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WooClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T = unknown>(method: string, request: WooRequest): Promise<WooResponse<T>> {
    const { baseUrl, publicUrl, consumerKey, consumerSecret, timeoutMs } = this.options;
    const { path, query = [], body } = request;
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
      throw new TypeError('path must start with a slash and must not contain a query string');
    }

    // The signature is computed for the public URL. The request goes to the in-cluster URL.
    const authorization = buildAuthorizationHeader({ method, url: `${publicUrl}${path}`, query, consumerKey, consumerSecret });
    const queryString = query.map(([name, value]) => `${percentEncode(name)}=${percentEncode(value)}`).join('&');
    const url = `${baseUrl}${path}${queryString === '' ? '' : `?${queryString}`}`;

    const headers: Record<string, string> = { Accept: 'application/json', Authorization: authorization };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let status: number;
    let text: string | null;
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would send the request, with its Authorization header, to another address.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        throw new WooApiError('redirect', `WooCommerce answered with a redirect (status ${status}), which is not followed`, { status });
      }
      text = await readLimited(response, MAX_BODY_BYTES);
    } catch (error) {
      throw this.toApiError(error);
    }

    if (status >= 400) {
      // An error body that is too large is dropped. The status is still reported.
      throw this.httpError(status, text ?? '');
    }
    if (text === null) {
      throw new WooApiError('invalid-response', `WooCommerce answered with status ${status} and a body larger than 2 MB`, { status });
    }

    if (text.trim() === '') {
      return { status, data: null as T };
    }
    try {
      return { status, data: JSON.parse(text) as T };
    } catch {
      throw new WooApiError('invalid-response', `WooCommerce answered with status ${status} and a body that is not JSON`, { status });
    }
  }

  private toApiError(error: unknown): WooApiError {
    if (error instanceof WooApiError) return error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new WooApiError('timeout', `WooCommerce did not answer within ${this.options.timeoutMs} ms`);
    }
    // Only the system error code is reported (for example ECONNREFUSED). The error text of fetch can
    // contain the address that was called.
    const cause = error instanceof Error ? (error as { cause?: { code?: unknown } }).cause : undefined;
    const code = typeof cause?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : 'unknown error';
    return new WooApiError('network', `could not reach WooCommerce (${code})`);
  }

  private httpError(status: number, text: string): WooApiError {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        const fields = parsed as { code?: unknown; message?: unknown };
        if (typeof fields.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(fields.code)) code = fields.code;
        if (typeof fields.message === 'string') message = this.safeText(fields.message);
      }
    } catch {
      // The body is not JSON, for example an HTML error page. Only the status is reported.
    }
    const detail = [code, message].filter((part) => part !== undefined && part !== '').join(': ');
    return new WooApiError('http', `WooCommerce answered with status ${status}${detail === '' ? '' : ` (${detail})`}`, { status, code });
  }

  // Text from WooCommerce is shown to a caller, so the key and the secret are removed if it echoes them,
  // control characters are dropped and the length is limited.
  private safeText(value: string): string {
    const { consumerKey, consumerSecret } = this.options;
    let text = value;
    for (const secret of [consumerSecret, consumerKey]) {
      if (secret !== '') text = text.split(secret).join('[redacted]');
    }
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text.length > MAX_WOO_MESSAGE_LENGTH ? `${text.slice(0, MAX_WOO_MESSAGE_LENGTH)}...` : text;
  }
}

// Reads the body as text, or returns null when it is larger than maxBytes. It checks the declared length
// first, and counts the bytes while reading because the length can be missing or wrong.
async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
