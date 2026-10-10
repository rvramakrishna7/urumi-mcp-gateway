import { createHmac, randomBytes } from 'node:crypto';

// Query parameters as ordered pairs, so that a repeated name (for example include[]) is kept.
export type QueryParams = ReadonlyArray<readonly [string, string]>;

export interface OAuthInput {
  method: string;
  // The URL that the signature is computed for: scheme, host and path, without a query string. For
  // WooCommerce this is the public home URL, not the address that is actually called (decision 15).
  url: string;
  query: QueryParams;
  consumerKey: string;
  consumerSecret: string;
  // Only tests set these two. In production a fresh random nonce and the current time are used.
  nonce?: string;
  timestamp?: number;
}

// RFC 3986 percent-encoding. encodeURIComponent leaves ! ' ( ) * unescaped, so those are encoded too.
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Builds the value of the Authorization header for OAuth 1.0a with HMAC-SHA256 and no token, which is
// the form WooCommerce accepts over plain HTTP. Every oauth_* parameter goes into this header and never
// into the URL, because the Apache access log records the request line (decision 15).
export function buildAuthorizationHeader(input: OAuthInput): string {
  const oauthParams: Array<[string, string]> = [
    ['oauth_consumer_key', input.consumerKey],
    ['oauth_nonce', input.nonce ?? randomBytes(16).toString('hex')],
    ['oauth_signature_method', 'HMAC-SHA256'],
    ['oauth_timestamp', String(input.timestamp ?? Math.floor(Date.now() / 1000))],
    ['oauth_version', '1.0'],
  ];

  // Sort by encoded name, then by encoded value. The encoded strings are ASCII, so the code unit order
  // used here is the same as the byte order that WooCommerce uses.
  const normalized = [...oauthParams, ...input.query]
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => (nameA === nameB ? compare(valueA, valueB) : compare(nameA, nameB)))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const baseString = [input.method.toUpperCase(), percentEncode(input.url), percentEncode(normalized)].join('&');
  // The signing key is "<consumer secret>&<token secret>". There is no token, so the second part is empty.
  const signature = createHmac('sha256', `${input.consumerSecret}&`).update(baseString).digest('base64');

  const header = [...oauthParams, ['oauth_signature', signature] as [string, string]]
    .map(([name, value]) => `${name}="${percentEncode(value)}"`)
    .join(',');
  return `OAuth ${header}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
