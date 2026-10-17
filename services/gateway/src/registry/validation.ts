import { z } from 'zod';

// Input rules of the registry (docs/architecture.md, decisions 30 and 31). The schemas are strict: an unknown field,
// such as a slug in an update, is an error and not silently ignored.

export const SLUG = /^[a-z][a-z0-9-]{0,19}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Headers that the gateway or the transport sets itself. A credential must not replace them.
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'te', 'accept',
  'mcp-session-id', 'mcp-protocol-version',
]);
const MAX_URL_LENGTH = 2048;
const MAX_CREDENTIAL_LENGTH = 4096;

// http and https only, no credentials, query string or fragment in the address. This is the syntax check only. Which
// hosts and ports an admin may register is decided by the SSRF guard in src/upstream/ssrf.ts (decision 44).
export function isValidUpstreamUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || /\s/.test(value) || value.includes('?') || value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
}

// A header value must be one line of printable text: no control characters (header injection).
function isPlainValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length >= 1 && value.length <= MAX_CREDENTIAL_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

const urlField = z.string().refine(isValidUpstreamUrl, { message: 'invalid upstream url' });
const nameField = z.string().trim().min(1).max(100);
const timeoutField = z.number().int().min(1000).max(120_000);
const valueField = z.string().refine(isPlainValue, { message: 'invalid credential value' });

const bearerCredential = z.strictObject({ kind: z.literal('bearer'), value: valueField });
const headerCredential = z.strictObject({
  kind: z.literal('header'),
  header: z.string().regex(HEADER_NAME).refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), { message: 'reserved header' }),
  value: valueField,
});
export const credentialInput = z.discriminatedUnion('kind', [bearerCredential, headerCredential]);
export type CredentialInput = z.infer<typeof credentialInput>;

export const createServerSchema = z.strictObject({
  slug: z.string().regex(SLUG),
  name: nameField,
  url: urlField,
  enabled: z.boolean().default(true),
  callTimeoutMs: timeoutField.default(30_000),
  credential: credentialInput.optional(),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

// PATCH semantics for credential: omitted keeps it, null removes it, an object replaces it.
export const patchServerSchema = z.strictObject({
  name: nameField.optional(),
  url: urlField.optional(),
  enabled: z.boolean().optional(),
  callTimeoutMs: timeoutField.optional(),
  credential: credentialInput.nullable().optional(),
});
export type PatchServerInput = z.infer<typeof patchServerSchema>;

// The reason for a rejected request names the fields and the kind of problem, never the value: a credential that was
// typed into the wrong field must not come back in an error.
export function describeIssues(error: z.ZodError): Array<{ field: string; problem: string }> {
  return error.issues.map((issue) => ({ field: issue.path.map(String).join('.') || '(body)', problem: issue.code }));
}
