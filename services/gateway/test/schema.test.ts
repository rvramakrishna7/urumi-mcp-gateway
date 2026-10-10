import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createLogger } from '../src/logger.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

// PostgreSQL error codes: 23514 check violation, 23505 unique violation, 23502 not null violation.
const CHECK = '23514';
const UNIQUE = '23505';
const NOT_NULL = '23502';

describe('schema of migration 0001 (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let client: pg.Client;

  before(async () => {
    db = await createTestDatabase();
    client = await db.connect();
    await runMigrations(client, await loadMigrationFiles(), createLogger(() => {}));
  });
  after(async () => {
    await db.drop();
  });

  const hash = () => randomBytes(32);
  const rejects = (text: string, values: unknown[], code: string) =>
    assert.rejects(client.query(text, values), (error: unknown) => (error as { code?: string }).code === code, `${text.slice(0, 60)} should fail with ${code}`);
  const newUser = async (email: string, role = 'member') =>
    (await client.query<{ id: string }>('INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id', [email, role])).rows[0]!.id;
  const newServer = async (slug: string) =>
    (await client.query<{ id: string }>('INSERT INTO upstream_servers (slug, name, url) VALUES ($1, $1, $2) RETURNING id', [slug, `http://${slug}.example.test/mcp`])).rows[0]!.id;

  describe('users', () => {
    test('a valid user gets an id, the status invited and a creation time', async () => {
      const { rows } = await client.query('INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id, status, created_at', ['first@example.test', 'admin']);
      assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
      assert.equal(rows[0].status, 'invited');
      assert.ok(rows[0].created_at instanceof Date);
    });

    test('the email must be lower case, have a shape, and be unique', async () => {
      await rejects('INSERT INTO users (email, role) VALUES ($1, $2)', ['Upper@Example.test', 'member'], CHECK);
      await rejects('INSERT INTO users (email, role) VALUES ($1, $2)', ['no-at-sign', 'member'], CHECK);
      await rejects('INSERT INTO users (email, role) VALUES ($1, $2)', ['@starts.test', 'member'], CHECK);
      await newUser('dup@example.test');
      await rejects('INSERT INTO users (email, role) VALUES ($1, $2)', ['dup@example.test', 'member'], UNIQUE);
    });

    test('the role and the status are limited to the known values', async () => {
      await rejects('INSERT INTO users (email, role) VALUES ($1, $2)', ['r1@example.test', 'owner'], CHECK);
      await rejects('INSERT INTO users (email, role, status) VALUES ($1, $2, $3)', ['r2@example.test', 'member', 'deleted'], CHECK);
      await rejects('INSERT INTO users (email) VALUES ($1)', ['r3@example.test'], NOT_NULL);
    });

    test('an invite token hash and its expiry go together, are 32 bytes, and are unique', async () => {
      await rejects('INSERT INTO users (email, role, invite_token_hash) VALUES ($1, $2, $3)', ['i1@example.test', 'member', hash()], CHECK);
      await rejects('INSERT INTO users (email, role, invite_expires_at) VALUES ($1, $2, now())', ['i2@example.test', 'member'], CHECK);
      await rejects('INSERT INTO users (email, role, invite_token_hash, invite_expires_at) VALUES ($1, $2, $3, now())', ['i3@example.test', 'member', randomBytes(16)], CHECK);
      const same = hash();
      await client.query('INSERT INTO users (email, role, invite_token_hash, invite_expires_at) VALUES ($1, $2, $3, now())', ['i4@example.test', 'member', same]);
      await rejects('INSERT INTO users (email, role, invite_token_hash, invite_expires_at) VALUES ($1, $2, $3, now())', ['i5@example.test', 'member', same], UNIQUE);
    });
  });

  describe('api_keys', () => {
    test('stores a 32 byte hash, and the same hash cannot be stored twice', async () => {
      const userId = await newUser('keys1@example.test');
      const keyHash = hash();
      await client.query('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [userId, 'laptop', 'mcpgw_ab', keyHash]);
      await rejects('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [userId, 'other', 'mcpgw_cd', keyHash], UNIQUE);
      await rejects('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [userId, 'short', 'mcpgw_ef', randomBytes(31)], CHECK);
      await rejects('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [userId, '', 'mcpgw_gh', hash()], CHECK);
    });

    test('a key cannot exist without a user, and goes when its user goes', async () => {
      await assert.rejects(client.query('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (gen_random_uuid(), $1, $2, $3)', ['x', 'mcpgw_ij', hash()]), (e: unknown) => (e as { code?: string }).code === '23503');
      const userId = await newUser('keys2@example.test');
      await client.query('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [userId, 'k', 'mcpgw_kl', hash()]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      assert.equal((await client.query('SELECT count(*)::int AS c FROM api_keys WHERE user_id = $1', [userId])).rows[0].c, 0);
    });

    test('revoking is a timestamp, and the row stays', async () => {
      const userId = await newUser('keys3@example.test');
      const { rows } = await client.query('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id', [userId, 'k', 'mcpgw_mn', hash()]);
      await client.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [rows[0].id]);
      const row = (await client.query('SELECT revoked_at FROM api_keys WHERE id = $1', [rows[0].id])).rows[0];
      assert.ok(row.revoked_at instanceof Date);
    });
  });

  describe('upstream_servers', () => {
    test('accepts slugs that cannot be confused with the separator', async () => {
      for (const slug of ['woo', 'my-server', 'a1', 'a'.repeat(20)]) await newServer(slug);
    });

    test('rejects slugs with an underscore, capitals, a leading digit or dash, or more than 20 characters', async () => {
      for (const slug of ['my_server', 'a__b', 'Woo', '1abc', '-abc', '', 'a'.repeat(21), 'a b', 'a.b']) {
        await rejects('INSERT INTO upstream_servers (slug, name, url) VALUES ($1, $1, $2)', [slug, 'http://x.test/mcp'], CHECK);
      }
    });

    test('the slug is unique', async () => {
      await newServer('unique-one');
      await rejects('INSERT INTO upstream_servers (slug, name, url) VALUES ($1, $1, $2)', ['unique-one', 'http://y.test/mcp'], UNIQUE);
    });

    test('the url must be http or https without spaces, and the timeout must be in range', async () => {
      for (const url of ['ftp://x.test/mcp', 'x.test/mcp', 'http://x.test/a b', 'javascript:alert(1)']) {
        await rejects('INSERT INTO upstream_servers (slug, name, url) VALUES ($1, $1, $2)', ['badurl', url], CHECK);
      }
      for (const timeout of [999, 120001, 0, -1]) {
        await rejects('INSERT INTO upstream_servers (slug, name, url, call_timeout_ms) VALUES ($1, $1, $2, $3)', ['badtime', 'http://x.test/mcp', timeout], CHECK);
      }
    });

    test('the defaults are enabled, status unknown, a 30 s timeout, no credential and not seed managed', async () => {
      const id = await newServer('defaults');
      const row = (await client.query('SELECT enabled, status, call_timeout_ms, credential_kind, credential_ciphertext, seed_managed FROM upstream_servers WHERE id = $1', [id])).rows[0];
      assert.deepEqual(row, { enabled: true, status: 'unknown', call_timeout_ms: 30000, credential_kind: null, credential_ciphertext: null, seed_managed: false });
    });

    test('a credential is all or nothing, and a header credential names its header', async () => {
      const base = ['http://c.test/mcp'];
      const insert = (columns: string, values: unknown[], slug: string) =>
        client.query(`INSERT INTO upstream_servers (slug, name, url, ${columns}) VALUES ($1, $1, $2, ${values.map((_v, i) => `$${i + 3}`).join(', ')})`, [slug, ...base, ...values]);
      const nonce = randomBytes(12);
      const ciphertext = randomBytes(40);

      // complete bearer credential
      await insert('credential_kind, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at', ['bearer', ciphertext, nonce, 'k1', new Date()], 'cred-ok-1');
      // complete header credential
      await insert('credential_kind, credential_header, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at', ['header', 'X-Api-Key', ciphertext, nonce, 'k1', new Date()], 'cred-ok-2');

      const failing: Array<[string, unknown[]]> = [
        ['credential_ciphertext', [ciphertext]], // ciphertext without a kind
        ['credential_kind', ['bearer']], // kind without the rest
        ['credential_kind, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at', ['header', ciphertext, nonce, 'k1', new Date()]], // header kind without a header name
        ['credential_kind, credential_header, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at', ['bearer', 'X-Api-Key', ciphertext, nonce, 'k1', new Date()]], // bearer with a header name
        ['credential_kind, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at', ['bearer', ciphertext, randomBytes(8), 'k1', new Date()]], // nonce is not 12 bytes
        ['credential_kind, credential_header, credential_ciphertext, credential_nonce, credential_key_id, credential_updated_at', ['header', 'bad header!', ciphertext, nonce, 'k1', new Date()]], // header name is not a token
      ];
      let n = 0;
      for (const [columns, values] of failing) {
        await assert.rejects(insert(columns, values, `cred-bad-${n++}`), (e: unknown) => (e as { code?: string }).code === CHECK);
      }
    });

    test('the status is limited to unknown, connected and unreachable', async () => {
      await rejects('INSERT INTO upstream_servers (slug, name, url, status) VALUES ($1, $1, $2, $3)', ['badstatus', 'http://x.test/mcp', 'disabled'], CHECK);
    });
  });

  describe('upstream_tools', () => {
    test('are removed with their server, and a tool name is unique per server', async () => {
      const serverId = await newServer('tools-a');
      await client.query('INSERT INTO upstream_tools (server_id, name, description) VALUES ($1, $2, $3)', [serverId, 'list_orders', 'Lists orders']);
      await rejects('INSERT INTO upstream_tools (server_id, name) VALUES ($1, $2)', [serverId, 'list_orders'], UNIQUE);
      const other = await newServer('tools-b');
      await client.query('INSERT INTO upstream_tools (server_id, name) VALUES ($1, $2)', [other, 'list_orders']);
      await client.query('DELETE FROM upstream_servers WHERE id = $1', [serverId]);
      assert.equal((await client.query('SELECT count(*)::int AS c FROM upstream_tools WHERE server_id = $1', [serverId])).rows[0].c, 0);
      assert.equal((await client.query('SELECT count(*)::int AS c FROM upstream_tools WHERE server_id = $1', [other])).rows[0].c, 1);
    });

    test('limits the length of a name, a description and a hash', async () => {
      const serverId = await newServer('tools-c');
      await rejects('INSERT INTO upstream_tools (server_id, name) VALUES ($1, $2)', [serverId, ''], CHECK);
      await rejects('INSERT INTO upstream_tools (server_id, name) VALUES ($1, $2)', [serverId, 'n'.repeat(201)], CHECK);
      await rejects('INSERT INTO upstream_tools (server_id, name, description) VALUES ($1, $2, $3)', [serverId, 'long', 'd'.repeat(4001)], CHECK);
      await rejects('INSERT INTO upstream_tools (server_id, name, description_hash) VALUES ($1, $2, $3)', [serverId, 'hash', randomBytes(5)], CHECK);
      await client.query('INSERT INTO upstream_tools (server_id, name, description, description_hash, skipped_reason) VALUES ($1, $2, $3, $4, $5)', [serverId, 'fine', 'd'.repeat(4000), hash(), 'name too long']);
    });
  });

  describe('audit_log (two phases)', () => {
    const start = async (userId: string | null, email: string, extra: { via?: string; slug?: string | null; serverId?: string | null } = {}) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO audit_log (user_id, user_email, server_id, server_slug, requested_name, tool, via, request_id)
           VALUES ($1, $2, $3, $4, 'woo__list_orders', 'list_orders', $5, gen_random_uuid()) RETURNING id`,
          [userId, email, extra.serverId ?? null, extra.slug ?? 'woo', extra.via ?? 'mcp'],
        )
      ).rows[0]!.id;

    test('phase 1 inserts a row with the outcome started and no end', async () => {
      const userId = await newUser('audit1@example.test');
      const id = await start(userId, 'audit1@example.test');
      const row = (await client.query('SELECT outcome, finished_at, duration_ms, ts FROM audit_log WHERE id = $1', [id])).rows[0];
      assert.equal(row.outcome, 'started');
      assert.equal(row.finished_at, null);
      assert.equal(row.duration_ms, null);
      assert.ok(row.ts instanceof Date);
    });

    test('phase 2 updates the same row with the outcome, the end and the duration', async () => {
      const id = await start(null, 'audit2@example.test');
      await client.query("UPDATE audit_log SET outcome = 'ok', finished_at = now(), duration_ms = 42 WHERE id = $1", [id]);
      const row = (await client.query('SELECT outcome, duration_ms FROM audit_log WHERE id = $1', [id])).rows[0];
      assert.deepEqual(row, { outcome: 'ok', duration_ms: 42 });
      assert.equal((await client.query('SELECT count(*)::int AS c FROM audit_log WHERE request_id = (SELECT request_id FROM audit_log WHERE id = $1)', [id])).rows[0].c, 1);
    });

    test('a started row cannot have an end, and a finished row must have an end and a duration', async () => {
      const id = await start(null, 'audit3@example.test');
      await rejects("UPDATE audit_log SET finished_at = now(), duration_ms = 1 WHERE id = $1", [id], CHECK); // still started
      await rejects("UPDATE audit_log SET outcome = 'ok' WHERE id = $1", [id], CHECK); // no end, no duration
      await rejects("UPDATE audit_log SET outcome = 'ok', finished_at = now() WHERE id = $1", [id], CHECK); // no duration
      await rejects("UPDATE audit_log SET outcome = 'ok', finished_at = now(), duration_ms = -5 WHERE id = $1", [id], CHECK);
      await rejects("INSERT INTO audit_log (user_email, requested_name, via, request_id, outcome) VALUES ('x@example.test', 'a__b', 'mcp', gen_random_uuid(), 'ok')", [], CHECK);
    });

    test('accepts every documented outcome and refuses others', async () => {
      for (const outcome of ['ok', 'error', 'timeout', 'unreachable', 'unknown_tool', 'denied', 'interrupted']) {
        const id = await start(null, 'audit4@example.test');
        await client.query('UPDATE audit_log SET outcome = $2, finished_at = now(), duration_ms = 1 WHERE id = $1', [id, outcome]);
      }
      const id = await start(null, 'audit5@example.test');
      await rejects("UPDATE audit_log SET outcome = 'success', finished_at = now(), duration_ms = 1 WHERE id = $1", [id], CHECK);
    });

    test('the origin must be mcp or chat, and the lengths are limited', async () => {
      await rejects("INSERT INTO audit_log (user_email, requested_name, via, request_id) VALUES ('x@example.test', 'a', 'cli', gen_random_uuid())", [], CHECK);
      await rejects("INSERT INTO audit_log (user_email, requested_name, via, request_id) VALUES ('x@example.test', $1, 'chat', gen_random_uuid())", ['n'.repeat(201)], CHECK);
      await rejects("INSERT INTO audit_log (requested_name, via, request_id) VALUES ('a', 'chat', gen_random_uuid())", [], NOT_NULL);
    });

    test('the row still names the user and the server after both are deleted', async () => {
      const userId = await newUser('audit6@example.test');
      const serverId = await newServer('audit-srv');
      const id = await start(userId, 'audit6@example.test', { serverId, slug: 'audit-srv', via: 'chat' });
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('DELETE FROM upstream_servers WHERE id = $1', [serverId]);
      const row = (await client.query('SELECT user_id, user_email, server_id, server_slug, via FROM audit_log WHERE id = $1', [id])).rows[0];
      assert.deepEqual(row, { user_id: null, user_email: 'audit6@example.test', server_id: null, server_slug: 'audit-srv', via: 'chat' });
    });

    test('calls that never ended can be found through the partial index', async () => {
      await start(null, 'audit7@example.test');
      const { rows } = await client.query("SELECT count(*)::int AS c FROM audit_log WHERE outcome = 'started'");
      assert.ok(rows[0].c >= 1);
      const index = await client.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_log' AND indexname = 'audit_log_started_idx'");
      assert.match(index.rows[0].indexdef, /WHERE \(outcome = 'started'/);
    });
  });
});
