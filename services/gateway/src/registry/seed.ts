import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Database, Queryable } from '../db/queryable.ts';
import { withTransaction } from '../db/queryable.ts';
import { encryptCredential } from '../crypto/credentials.ts';
import type { Keyring } from '../crypto/credentials.ts';
import type { Logger } from '../logger.ts';
import { insertServer, readCredential } from './repository.ts';
import { credentialInput, SLUG, isValidUpstreamUrl } from './validation.ts';
import type { CredentialInput } from './validation.ts';

// The install-time seed (docs/architecture.md, decision 31). The file is made by the chart from its values and holds no
// secret: a credential names a file (a mounted Secret) that holds the value.
const seedFileSchema = z.object({
  servers: z.array(
    z.strictObject({
      slug: z.string().regex(SLUG),
      name: z.string().trim().min(1).max(100),
      url: z.string().refine(isValidUpstreamUrl),
      callTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
      credential: z.strictObject({
        kind: z.enum(['bearer', 'header']),
        header: z.string().optional(),
        file: z.string().min(1),
      }).optional(),
    }),
  ),
});

export type SeedFile = z.infer<typeof seedFileSchema>;

export class SeedError extends Error {}

export type SeedAction = 'inserted' | 'synced' | 'unchanged' | 'skipped-removed' | 'skipped-not-managed';

// One number for the advisory lock, so that gateway pods that start together apply the seed one after another.
const SEED_LOCK_KEY = 7_242_002;

export function loadSeedFile(path: string): SeedFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new SeedError('SEED_FILE cannot be read');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SeedError('SEED_FILE is not valid JSON');
  }
  const parsed = seedFileSchema.safeParse(json);
  if (!parsed.success) throw new SeedError(`SEED_FILE is invalid: ${[...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.')))].join(', ')}`);
  return parsed.data;
}

function readSeedCredential(entry: SeedFile['servers'][number]): CredentialInput | undefined {
  if (!entry.credential) return undefined;
  let value: string;
  try {
    value = readFileSync(entry.credential.file, 'utf8').trim();
  } catch {
    throw new SeedError(`the credential file of seed "${entry.slug}" cannot be read`);
  }
  const candidate = entry.credential.kind === 'bearer'
    ? { kind: 'bearer', value }
    : { kind: 'header', header: entry.credential.header, value };
  const parsed = credentialInput.safeParse(candidate);
  if (!parsed.success) throw new SeedError(`the credential of seed "${entry.slug}" is invalid`);
  return parsed.data;
}

// Applies every entry once, in one transaction under a lock.
//  - A slug that was applied before and whose server was removed stays removed (the table applied_seeds remembers it).
//  - A server that is still seed managed follows the url and the credential of the seed.
//  - The seed never writes "enabled": a server that an admin disabled stays disabled.
export async function applySeed(db: Database, keyring: Keyring, seed: SeedFile, logger: Logger): Promise<Record<string, SeedAction>> {
  const actions: Record<string, SeedAction> = {};
  await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_KEY]);
    for (const entry of seed.servers) {
      const credential = readSeedCredential(entry);
      const applied = (await client.query('SELECT 1 FROM applied_seeds WHERE slug = $1', [entry.slug])).rowCount !== 0;
      const existing = (await client.query('SELECT id, url, seed_managed FROM upstream_servers WHERE slug = $1', [entry.slug])).rows[0];

      if (!existing) {
        if (applied) {
          actions[entry.slug] = 'skipped-removed';
        } else {
          await insertServer(client, keyring, { slug: entry.slug, name: entry.name, url: entry.url, enabled: true, callTimeoutMs: entry.callTimeoutMs, credential }, { createdBy: null, seedManaged: true });
          await client.query('INSERT INTO applied_seeds (slug) VALUES ($1)', [entry.slug]);
          actions[entry.slug] = 'inserted';
        }
        continue;
      }

      // A server with this slug that an admin made before the seed ran is not touched, and the seed counts as applied.
      if (!applied) await client.query('INSERT INTO applied_seeds (slug) VALUES ($1) ON CONFLICT DO NOTHING', [entry.slug]);
      if (!existing.seed_managed) {
        actions[entry.slug] = 'skipped-not-managed';
        continue;
      }

      // Re-encrypting would change the nonce and the row on every start, so the credential is written only when it
      // differs from what is stored.
      const stored = await readCredential(client, keyring, existing.id);
      const sameCredential = credential
        ? stored !== null && stored.kind === credential.kind && stored.value === credential.value && (stored.header ?? null) === (credential.kind === 'header' ? credential.header : null)
        : stored === null;
      if (existing.url === entry.url && sameCredential) {
        actions[entry.slug] = 'unchanged';
        continue;
      }
      await syncSeededRow(client, keyring, existing.id, entry.url, sameCredential ? undefined : (credential ?? null));
      actions[entry.slug] = 'synced';
    }
  });
  for (const [slug, action] of Object.entries(actions)) logger.info('seed', { slug, action });
  return actions;
}

// Writes the url and, when given, the credential (null removes it). It does not touch "enabled" or "seed_managed".
async function syncSeededRow(client: Queryable, keyring: Keyring, id: string, url: string, credential: CredentialInput | null | undefined): Promise<void> {
  if (credential === undefined) {
    await client.query('UPDATE upstream_servers SET url = $2, updated_at = now() WHERE id = $1', [id, url]);
    return;
  }
  if (credential === null) {
    await client.query(
      `UPDATE upstream_servers SET url = $2, credential_kind = NULL, credential_header = NULL, credential_ciphertext = NULL,
         credential_nonce = NULL, credential_key_id = NULL, credential_updated_at = NULL, updated_at = now() WHERE id = $1`,
      [id, url],
    );
    return;
  }
  const encrypted = encryptCredential(keyring, id, credential.value);
  await client.query(
    `UPDATE upstream_servers SET url = $2, credential_kind = $3, credential_header = $4, credential_ciphertext = $5,
       credential_nonce = $6, credential_key_id = $7, credential_updated_at = now(), updated_at = now() WHERE id = $1`,
    [id, url, credential.kind, credential.kind === 'header' ? credential.header : null, encrypted.ciphertext, encrypted.nonce, encrypted.keyId],
  );
}
