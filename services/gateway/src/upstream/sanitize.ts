import { createHash } from 'node:crypto';

// Everything an upstream sends about its tools is untrusted (docs/architecture.md, decision 29). An upstream, or an
// admin who registers a bad one, controls every name, description and schema that the gateway later shows to a model.
// These limits decide what is stored and exposed. A tool that breaks a rule is skipped, never repaired or cut.
export const MAX_TOOLS_PER_SERVER = 200;
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_SCHEMA_BYTES = 32_768;
export const MAX_ANNOTATIONS_BYTES = 4096;
// The limit of model APIs for the whole exposed name, "<slug>__<tool>".
export const MAX_EXPOSED_NAME = 64;

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface AcceptedTool {
  name: string;
  description: string;
  descriptionHash: Buffer;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
}

export interface SkippedTool {
  // Safe to store and to show: only letters, digits and a few symbols, at most 200 characters.
  name: string;
  reason: string;
  descriptionHash: Buffer | null;
}

export interface ToolReview {
  accepted: AcceptedTool[];
  skipped: SkippedTool[];
  // Set when something about the list as a whole was cut, for the server's status_reason. Null when nothing was.
  note: string | null;
}

// The same rules as safeText of woo-mcp: control characters, zero-width and direction-changing characters are
// removed. One difference: line breaks are kept (at most two in a row), because a description is written text and
// not a one-line field. The result is cut to the limit, with "..." counted inside it.
export function cleanDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\p{Zl}\p{Zp}]+/gu, ' ')
    // Control characters except the line break (Cc), and format characters (Cf): the soft hyphen, zero-width
    // characters, direction marks, overrides and isolates, the word joiner and the byte order mark.
    .replace(/[^\P{Cc}\n]|\p{Cf}/gu, '')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const characters = [...cleaned];
  return characters.length > MAX_DESCRIPTION_CHARS ? `${characters.slice(0, MAX_DESCRIPTION_CHARS - 3).join('')}...` : cleaned;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

// A name that failed validation still gets a row (with the reason), so it is stored in a safe form: no control
// characters, no NUL (PostgreSQL rejects it in text) and no more than 200 characters.
function storageName(name: unknown): string {
  const text = typeof name === 'string' ? name : '(not a string)';
  const safe = text.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 200);
  return safe.length > 0 ? safe : '?';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// PostgreSQL jsonb cannot hold a NUL escape inside a string, and the insert would fail for the whole list.
function jsonOf(value: unknown, maxBytes: number): string | null {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > maxBytes || text.includes('\\u0000')) return null;
  return text;
}

// Reviews the tools that one upstream offered. The first MAX_TOOLS_PER_SERVER are looked at, the rest are only
// counted. The rules, in order: the name pattern, the length of the exposed name, the size and the content of the
// input schema. A repeated name is ignored (the first one wins).
export function reviewTools(slug: string, offered: readonly unknown[]): ToolReview {
  const accepted: AcceptedTool[] = [];
  const skipped: SkippedTool[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const raw of offered.slice(0, MAX_TOOLS_PER_SERVER)) {
    const tool = isPlainObject(raw) ? raw : {};
    const name = tool.name;
    const hash = typeof tool.description === 'string' ? sha256(tool.description) : null;
    const stored = storageName(name);
    if (typeof name === 'string' && seen.has(name)) {
      duplicates += 1;
      continue;
    }
    if (typeof name === 'string') seen.add(name);

    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      skipped.push({ name: stored, reason: 'invalid name', descriptionHash: hash });
      continue;
    }
    if (slug.length + 2 + name.length > MAX_EXPOSED_NAME) {
      skipped.push({ name: stored, reason: `exposed name longer than ${MAX_EXPOSED_NAME} characters`, descriptionHash: hash });
      continue;
    }
    if (!isPlainObject(tool.inputSchema)) {
      skipped.push({ name: stored, reason: 'invalid input schema', descriptionHash: hash });
      continue;
    }
    const schemaText = jsonOf(tool.inputSchema, MAX_SCHEMA_BYTES);
    if (schemaText === null) {
      skipped.push({ name: stored, reason: `input schema invalid or larger than ${MAX_SCHEMA_BYTES} bytes`, descriptionHash: hash });
      continue;
    }
    // Annotations are hints only. A bad or large value is dropped, and the tool stays.
    const annotationsText = isPlainObject(tool.annotations) ? jsonOf(tool.annotations, MAX_ANNOTATIONS_BYTES) : null;
    accepted.push({
      name,
      description: cleanDescription(tool.description),
      descriptionHash: hash ?? sha256(''),
      inputSchema: JSON.parse(schemaText),
      annotations: annotationsText === null ? null : JSON.parse(annotationsText),
    });
  }

  const notes: string[] = [];
  if (offered.length > MAX_TOOLS_PER_SERVER) notes.push(`tool limit: ${offered.length} offered, first ${MAX_TOOLS_PER_SERVER} reviewed`);
  if (duplicates > 0) notes.push(`${duplicates} repeated tool name(s) ignored`);
  return { accepted, skipped, note: notes.length > 0 ? notes.join('; ') : null };
}
