export interface FxClientOptions {
  // The rate service, for example https://api.frankfurter.dev. Configuration only: no tool argument ever reaches this value.
  baseUrl: string;
  timeoutMs: number;
  // Only tests replace this.
  fetch?: typeof fetch;
}

export type FxErrorKind = 'timeout' | 'network' | 'redirect' | 'rate-limited' | 'not-found' | 'http' | 'invalid-response';

// Every failure of a call to the rate service. The message is safe to show to a tool caller: it never contains a URL, a header or
// a body of the service.
export class FxApiError extends Error {
  readonly kind: FxErrorKind;
  readonly status: number | undefined;

  constructor(kind: FxErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface PairRate {
  date: string;
  base: string;
  quote: string;
  rate: number;
}

export interface CurrencyInfo {
  code: string;
  name: string;
}

// A larger answer is refused, so that one call cannot fill the memory of the server.
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 80;

const CODE = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class FxClient {
  private readonly options: FxClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FxClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  // The rate for one pair on one day (the latest published day when date is missing). The codes and the date are checked
  // here as well as by the tool schema, because they become part of the path.
  async getRate(base: string, quote: string, date?: string): Promise<PairRate> {
    if (!CODE.test(base) || !CODE.test(quote) || (date !== undefined && !DATE.test(date))) {
      throw new TypeError('invalid currency code or date');
    }
    const query = date === undefined ? '' : `?date=${date}`;
    const data = await this.get(`/v2/rate/${encodeURIComponent(base)}/${encodeURIComponent(quote)}${query}`);
    const answer = data as Record<string, unknown> | null;
    if (
      typeof answer !== 'object' ||
      answer === null ||
      answer.base !== base ||
      answer.quote !== quote ||
      typeof answer.date !== 'string' ||
      !DATE.test(answer.date) ||
      typeof answer.rate !== 'number' ||
      !Number.isFinite(answer.rate) ||
      answer.rate <= 0
    ) {
      throw new FxApiError('invalid-response', 'The rate service answered with a body of an unexpected shape');
    }
    return { date: answer.date, base, quote, rate: answer.rate };
  }

  async listCurrencies(): Promise<CurrencyInfo[]> {
    const data = await this.get('/v2/currencies');
    if (!Array.isArray(data)) throw new FxApiError('invalid-response', 'The rate service answered with a body of an unexpected shape');
    const currencies: CurrencyInfo[] = [];
    for (const item of data) {
      const entry = item as Record<string, unknown> | null;
      if (typeof entry !== 'object' || entry === null || typeof entry.iso_code !== 'string' || !CODE.test(entry.iso_code) || typeof entry.name !== 'string') {
        throw new FxApiError('invalid-response', 'The rate service answered with a body of an unexpected shape');
      }
      currencies.push({ code: entry.iso_code, name: cleanName(entry.name) });
    }
    return currencies;
  }

  private async get(path: string): Promise<unknown> {
    const { baseUrl, timeoutMs } = this.options;
    let status: number;
    let text: string | null;
    try {
      const response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        // A redirect would send the call to another address.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        throw new FxApiError('redirect', `The rate service answered with a redirect (status ${status}), which is not followed`, status);
      }
      text = await readLimited(response, MAX_BODY_BYTES);
    } catch (error) {
      throw this.toApiError(error);
    }
    if (status === 429) throw new FxApiError('rate-limited', 'The rate service is limiting requests right now', status);
    if (status === 404) throw new FxApiError('not-found', 'The rate service has no data for this request', status);
    if (status >= 400) throw new FxApiError('http', `The rate service answered with status ${status}`, status);
    if (text === null) throw new FxApiError('invalid-response', 'The rate service answered with a body larger than 1 MB', status);
    try {
      return JSON.parse(text);
    } catch {
      throw new FxApiError('invalid-response', 'The rate service answered with a body that is not JSON', status);
    }
  }

  private toApiError(error: unknown): FxApiError {
    if (error instanceof FxApiError) return error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new FxApiError('timeout', `The rate service did not answer within ${this.options.timeoutMs} ms`);
    }
    // Only the system error code is reported (for example ECONNREFUSED). The error text of fetch can contain the address.
    const cause = error instanceof Error ? (error as { cause?: { code?: unknown } }).cause : undefined;
    const code = typeof cause?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : 'unknown error';
    return new FxApiError('network', `could not reach the rate service (${code})`);
  }
}

// A currency name is shown to the model: control and invisible characters are dropped and the length is limited.
function cleanName(value: string): string {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/ {2,}/g, ' ').trim();
  const characters = [...cleaned];
  return characters.length > MAX_NAME_LENGTH ? `${characters.slice(0, MAX_NAME_LENGTH).join('')}...` : cleaned;
}

// Reads the body as text, or returns null when it is larger than maxBytes. It checks the declared length first, and counts
// the bytes while reading because the length can be missing or wrong.
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
