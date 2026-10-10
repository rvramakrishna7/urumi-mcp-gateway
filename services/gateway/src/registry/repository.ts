import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/queryable.ts';
import { withTransaction } from '../db/queryable.ts';
import { decryptCredential, encryptCredential } from '../crypto/credentials.ts';
import type { Keyring } from '../crypto/credentials.ts';
import type { CreateServerInput, CredentialInput, PatchServerInput } from './validation.ts';

// The only columns that the registry ever selects for the API. The ciphertext, the nonce and the key id are not in
// this list: no query that serves a response can return them (docs/architecture.md, decision 30).
const VIEW_COLUMNS = `id, slug, name, url, enabled, call_timeout_ms, credential_kind, credential_header, credential_updated_at,
  status, status_reason, status_checked_at, last_success_at, seed_managed, created_at, updated_at`;

export interface ServerView {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  callTimeoutMs: number;
  // Never the value. "set" is the only thing that says whether there is one.
  credential: { set: boolean; kind: 'bearer' | 'header' | null; header: string | null; updatedAt: Date | null };
  status: string;
  statusReason: string | null;
  statusCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  seedManaged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// The plain credential, for building an upstream call (Step 8d). It must never be put into a response or a log.
export interface PlainCredential {
  kind: 'bearer' | 'header';
  header: string | null;
  value: string;
}

export class RegistryError extends Error {
  readonly code: 'conflict' | 'not_found';
  constructor(code: 'conflict' | 'not_found', message: string) {
    super(message);
    this.code = code;
  }
}

function toView(row: Record<string, unknown>): ServerView {
  const kind = (row.credential_kind as 'bearer' | 'header' | null) ?? null;
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    url: row.url as string,
    enabled: row.enabled as boolean,
    callTimeoutMs: row.call_timeout_ms as number,
    credential: {
      set: kind !== null,
      kind,
      header: (row.credential_header as string | null) ?? null,
      updatedAt: (row.credential_updated_at as Date | null) ?? null,
    },
    status: row.status as string,
    statusReason: (row.status_reason as string | null) ?? null,
    statusCheckedAt: (row.status_checked_at as Date | null) ?? null,
    lastSuccessAt: (row.last_success_at as Date | null) ?? null,
    seedManaged: row.seed_managed as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

// The columns of one credential, ready for an INSERT or an UPDATE. Encrypted with the id of the row as additional data.
function credentialColumns(keyring: Keyring, serverId: string, credential: CredentialInput) {
  const encrypted = encryptCredential(keyring, serverId, credential.value);
  return {
    kind: credential.kind,
    header: credential.kind === 'header' ? credential.header : null,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    keyId: encrypted.keyId,
  };
}

export async function listServers(db: Queryable): Promise<ServerView[]> {
  const result = await db.query(`SELECT ${VIEW_COLUMNS} FROM upstream_servers ORDER BY slug`);
  return result.rows.map(toView);
}

export async function getServer(db: Queryable, id: string): Promise<ServerView | null> {
  const result = await db.query(`SELECT ${VIEW_COLUMNS} FROM upstream_servers WHERE id = $1`, [id]);
  return result.rows[0] ? toView(result.rows[0]) : null;
}

export async function getServerBySlug(db: Queryable, slug: string): Promise<ServerView | null> {
  const result = await db.query(`SELECT ${VIEW_COLUMNS} FROM upstream_servers WHERE slug = $1`, [slug]);
  return result.rows[0] ? toView(result.rows[0]) : null;
}

// seedManaged is true only for a row that the install seed created.
export async function insertServer(
  db: Queryable,
  keyring: Keyring,
  input: CreateServerInput,
  options: { createdBy: string | null; seedManaged: boolean },
): Promise<ServerView> {
  const id = randomUUID();
  const credential = input.credential ? credentialColumns(keyring, id, input.credential) : null;
  try {
    const result = await db.query(
      `INSERT INTO upstream_servers (id, slug, name, url, enabled, call_timeout_ms, seed_managed, created_by,
         credential_kind, credential_header, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)
       RETURNING ${VIEW_COLUMNS}`,
      [
        id, input.slug, input.name, input.url, input.enabled, input.callTimeoutMs, options.seedManaged, options.createdBy,
        credential?.kind ?? null, credential?.header ?? null, credential?.ciphertext ?? null, credential?.nonce ?? null, credential?.keyId ?? null,
      ],
    );
    return toView(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new RegistryError('conflict', 'a server with this slug already exists');
    throw error;
  }
}

// Changes only the fields that are present. An edit of the url, the credential, the name or the timeout sets
// seed_managed to false, so the install seed stops following the values for this row. Toggling "enabled" does not.
export async function patchServer(db: Database, keyring: Keyring, id: string, patch: PatchServerInput): Promise<ServerView> {
  return withTransaction(db, async (client) => {
    const existing = await client.query('SELECT id FROM upstream_servers WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rowCount === 0) throw new RegistryError('not_found', 'server not found');

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.name !== undefined) set('name', patch.name);
    if (patch.url !== undefined) set('url', patch.url);
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.callTimeoutMs !== undefined) set('call_timeout_ms', patch.callTimeoutMs);
    if (patch.credential === null) {
      for (const column of ['credential_kind', 'credential_header', 'credential_ciphertext', 'credential_nonce', 'credential_key_id', 'credential_updated_at']) {
        sets.push(`${column} = NULL`);
      }
    } else if (patch.credential !== undefined) {
      const columns = credentialColumns(keyring, id, patch.credential);
      set('credential_kind', columns.kind);
      set('credential_header', columns.header);
      set('credential_ciphertext', columns.ciphertext);
      set('credential_nonce', columns.nonce);
      set('credential_key_id', columns.keyId);
      sets.push('credential_updated_at = now()');
    }

    const editsSeededFields = patch.name !== undefined || patch.url !== undefined || patch.callTimeoutMs !== undefined || patch.credential !== undefined;
    if (editsSeededFields) sets.push('seed_managed = false');

    if (sets.length > 0) {
      sets.push('updated_at = now()');
      values.push(id);
      await client.query(`UPDATE upstream_servers SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    }
    const result = await client.query(`SELECT ${VIEW_COLUMNS} FROM upstream_servers WHERE id = $1`, [id]);
    return toView(result.rows[0]);
  });
}

// The tools of the server go with it (ON DELETE CASCADE). Audit rows stay and keep the slug as text.
export async function deleteServer(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM upstream_servers WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

// Decrypts the credential of one server, in memory, for an upstream call or for the seed to compare. Returns null when
// the server has no credential. Throws CryptoError when the key or the row id does not match.
export async function readCredential(db: Queryable, keyring: Keyring, serverId: string): Promise<PlainCredential | null> {
  const result = await db.query(
    `SELECT credential_kind, credential_header, credential_ciphertext, credential_nonce, credential_key_id
     FROM upstream_servers WHERE id = $1`,
    [serverId],
  );
  const row = result.rows[0];
  if (!row || row.credential_kind === null) return null;
  const value = decryptCredential(keyring, serverId, { ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, keyId: row.credential_key_id });
  return { kind: row.credential_kind, header: row.credential_header, value };
}
