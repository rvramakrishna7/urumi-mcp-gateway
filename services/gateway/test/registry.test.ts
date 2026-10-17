import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_UPSTREAM } from './helpers/upstream-policy.ts';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { decryptCredential, loadKeyring } from '../src/crypto/credentials.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser, revokeApiKey } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { readCredential } from '../src/registry/repository.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANARY = 'canary-upstream-credential-9f3a1c7e5b2d4f68';
const CANARY_TWO = 'canary-replacement-credential-0d4e6a8c1b3f5e79';

describe('registry admin API, authentication and the leak scan (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let keyring: Keyring;
  let keyDir: string;
  let masterKeyText: string;
  let clock = Date.now();
  const logLines: string[] = [];
  // Every response body and every header value that the tests receive, for the leak scan.
  const seen: string[] = [];
  let adminKey: string;
  let memberKey: string;

  async function call(method: string, path: string, key: string | null, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    seen.push(text, JSON.stringify([...response.headers.entries()]));
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-registry-'));
    masterKeyText = randomBytes(32).toString('base64');
    writeFileSync(join(keyDir, 'key'), masterKeyText);
    keyring = loadKeyring(join(keyDir, 'key'), 'k1');

    db = await createTestDatabase();
    const client = await db.connect();
    await runMigrations(client, await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();

    await createUser(pool, 'admin@example.com', 'admin');
    await createUser(pool, 'member@example.com', 'member');
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;
    memberKey = (await createApiKey(pool, 'member@example.com', 'member key')).key;

    const logger = createLogger((line) => logLines.push(line));
    const { app } = createApp({
      logger,
      checkDatabase: async () => {},
      admin: { db: pool, keyring, logger, upstream: TEST_UPSTREAM, now: () => clock },
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  test('no key, a malformed key, an unknown key and a revoked key all get 401', async () => {
    assert.equal((await call('GET', '/api/admin/servers', null)).status, 401);
    assert.equal((await call('GET', '/api/admin/servers', 'not-a-key')).status, 401);
    assert.equal((await call('GET', '/api/admin/servers', `mcpgw_${randomBytes(32).toString('base64url')}`)).status, 401);
    const temporary = (await createApiKey(pool, 'admin@example.com', 'temporary')).key;
    assert.equal((await call('GET', '/api/admin/servers', temporary)).status, 200);
    const row = await pool.query("SELECT id FROM api_keys WHERE name = 'temporary'");
    await revokeApiKey(pool, row.rows[0].id);
    const revoked = await call('GET', '/api/admin/servers', temporary);
    assert.equal(revoked.status, 401, 'a revoked key is rejected on its next request');
    assert.deepEqual(revoked.json, { error: 'unauthorized' });
  });

  test('a member key gets 403 on every admin route; an admin key gets through', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, body] of [
      ['GET', '/api/admin/servers', undefined],
      ['GET', `/api/admin/servers/${id}`, undefined],
      ['POST', '/api/admin/servers', { slug: 'x', name: 'x', url: 'http://x.test/mcp' }],
      ['PATCH', `/api/admin/servers/${id}`, { enabled: false }],
      ['DELETE', `/api/admin/servers/${id}`, undefined],
    ] as const) {
      assert.equal((await call(method, path, memberKey, body)).status, 403, `${method} ${path}`);
    }
    assert.equal((await call('GET', '/api/admin/servers', adminKey)).status, 200);
  });

  test('a member whose key is revoked gets 401, not 403', async () => {
    const extra = await createApiKey(pool, 'member@example.com', 'extra');
    assert.equal((await call('GET', '/api/admin/servers', extra.key)).status, 403);
    await revokeApiKey(pool, extra.view.id);
    assert.equal((await call('GET', '/api/admin/servers', extra.key)).status, 401);
  });

  test('add, list, get: the credential is encrypted and never returned', async () => {
    const created = await call('POST', '/api/admin/servers', adminKey, {
      slug: 'alpha', name: 'Alpha', url: 'http://alpha.test:8080/mcp', credential: { kind: 'bearer', value: CANARY },
    });
    assert.equal(created.status, 201);
    const server = created.json.server;
    assert.equal(server.slug, 'alpha');
    assert.equal(server.enabled, true);
    assert.equal(server.seedManaged, false);
    assert.deepEqual(Object.keys(server.credential).sort(), ['header', 'kind', 'set', 'updatedAt']);
    assert.equal(server.credential.set, true);
    assert.equal(server.credential.kind, 'bearer');

    const list = await call('GET', '/api/admin/servers', adminKey);
    assert.equal(list.json.servers.length, 1);
    assert.deepEqual(list.json.servers[0].credential, server.credential);
    assert.equal((await call('GET', `/api/admin/servers/${server.id}`, adminKey)).json.server.credential.set, true);

    // In the database the value is ciphertext, and it decrypts only with the right key and the right row id.
    const row = (await pool.query('SELECT * FROM upstream_servers WHERE id = $1', [server.id])).rows[0];
    assert.ok(!row.credential_ciphertext.includes(CANARY));
    assert.equal(row.credential_nonce.length, 12);
    assert.equal(row.credential_key_id, 'k1');
    assert.equal(decryptCredential(keyring, server.id, { ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, keyId: 'k1' }), CANARY);
    assert.deepEqual(await readCredential(pool, keyring, server.id), { kind: 'bearer', header: null, value: CANARY });
    assert.throws(() => decryptCredential(keyring, '00000000-0000-4000-8000-000000000000', { ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, keyId: 'k1' }));
  });

  test('two servers with the same credential value have different nonces and ciphertexts', async () => {
    const two = await call('POST', '/api/admin/servers', adminKey, {
      slug: 'beta', name: 'Beta', url: 'http://beta.test/mcp', credential: { kind: 'header', header: 'X-Api-Key', value: CANARY },
    });
    assert.equal(two.status, 201);
    assert.equal(two.json.server.credential.header, 'X-Api-Key');
    const rows = (await pool.query("SELECT slug, credential_ciphertext, credential_nonce FROM upstream_servers WHERE slug IN ('alpha', 'beta') ORDER BY slug")).rows;
    assert.notDeepEqual(rows[0].credential_ciphertext, rows[1].credential_ciphertext);
    assert.notDeepEqual(rows[0].credential_nonce, rows[1].credential_nonce);
    // A ciphertext moved to the other row does not decrypt there (the row id is the additional data).
    const alpha = (await pool.query("SELECT id FROM upstream_servers WHERE slug = 'alpha'")).rows[0].id;
    assert.throws(() => decryptCredential(keyring, alpha, { ciphertext: rows[1].credential_ciphertext, nonce: rows[1].credential_nonce, keyId: 'k1' }));
  });

  test('PATCH: omitted keeps the credential, an object replaces it, null removes it', async () => {
    const id = (await pool.query("SELECT id FROM upstream_servers WHERE slug = 'alpha'")).rows[0].id;
    const before = (await pool.query('SELECT credential_ciphertext FROM upstream_servers WHERE id = $1', [id])).rows[0].credential_ciphertext;

    const kept = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { name: 'Alpha renamed' });
    assert.equal(kept.json.server.name, 'Alpha renamed');
    assert.equal(kept.json.server.credential.set, true);
    assert.deepEqual((await pool.query('SELECT credential_ciphertext FROM upstream_servers WHERE id = $1', [id])).rows[0].credential_ciphertext, before);

    const replaced = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { credential: { kind: 'bearer', value: CANARY_TWO } });
    assert.equal(replaced.json.server.credential.set, true);
    assert.equal((await readCredential(pool, keyring, id))?.value, CANARY_TWO);

    const removed = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { credential: null });
    assert.deepEqual(removed.json.server.credential, { set: false, kind: null, header: null, updatedAt: null });
    assert.equal(await readCredential(pool, keyring, id), null);
    const row = (await pool.query('SELECT credential_ciphertext, credential_nonce, credential_key_id FROM upstream_servers WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { credential_ciphertext: null, credential_nonce: null, credential_key_id: null });
  });

  test('disable and enable, edit of timeout, and the seed_managed rule', async () => {
    const created = await call('POST', '/api/admin/servers', adminKey, { slug: 'gamma', name: 'Gamma', url: 'http://gamma.test/mcp' });
    const id = created.json.server.id;
    await pool.query('UPDATE upstream_servers SET seed_managed = true WHERE id = $1', [id]);
    assert.equal((await call('PATCH', `/api/admin/servers/${id}`, adminKey, { enabled: false })).json.server.enabled, false);
    assert.equal((await call('GET', `/api/admin/servers/${id}`, adminKey)).json.server.seedManaged, true, 'toggling enabled keeps seed_managed');
    assert.equal((await call('PATCH', `/api/admin/servers/${id}`, adminKey, { enabled: true })).json.server.enabled, true);
    const edited = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { callTimeoutMs: 5000 });
    assert.equal(edited.json.server.callTimeoutMs, 5000);
    assert.equal(edited.json.server.seedManaged, false, 'an edit of the timeout sets seed_managed to false');
  });

  test('validation: bad input is 400 and the error never echoes a value', async () => {
    const secretInWrongPlace = 'canary-typed-into-the-wrong-field-77aa';
    const cases: unknown[] = [
      { slug: 'Bad_Slug', name: 'x', url: 'http://x.test/mcp' },
      { slug: 'ok', name: 'x', url: 'ftp://x.test/mcp' },
      { slug: 'ok', name: 'x', url: 'http://user:pass@x.test/mcp' },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp?token=abc' },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp#frag' },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp', callTimeoutMs: 10 },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp', extra: secretInWrongPlace },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp', credential: { kind: 'bearer', value: `${secretInWrongPlace}\r\nX-Evil: 1` } },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp', credential: { kind: 'header', header: 'Host', value: secretInWrongPlace } },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp', credential: { kind: 'header', value: secretInWrongPlace } },
      { slug: 'ok', name: 'x', url: 'http://x.test/mcp', credential: { kind: 'bearer', value: secretInWrongPlace, extra: 1 } },
    ];
    for (const body of cases) {
      const response = await call('POST', '/api/admin/servers', adminKey, body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
      assert.ok(!JSON.stringify(response.json).includes(secretInWrongPlace), 'the error must not echo the value');
    }
    // A slug cannot be changed.
    const id = (await pool.query("SELECT id FROM upstream_servers WHERE slug = 'gamma'")).rows[0].id;
    assert.equal((await call('PATCH', `/api/admin/servers/${id}`, adminKey, { slug: 'other' })).status, 400);
    // Malformed JSON, a duplicate slug, a bad id and an unknown id.
    const malformed = await fetch(`${base}/api/admin/servers`, { method: 'POST', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: '{"slug": ' });
    assert.equal(malformed.status, 400);
    assert.equal((await call('POST', '/api/admin/servers', adminKey, { slug: 'gamma', name: 'x', url: 'http://x.test/mcp' })).status, 409);
    assert.equal((await call('GET', '/api/admin/servers/not-a-uuid', adminKey)).status, 404);
    assert.equal((await call('DELETE', '/api/admin/servers/00000000-0000-4000-8000-000000000000', adminKey)).status, 404);
  });

  test('SSRF guard: a blocked address is 400 url_blocked with a reason code, on create and on edit, and nothing changes', async () => {
    const BLOCKED: Array<[string, string]> = [
      ['http://169.254.169.254/', 'ip_literal'],
      ['http://kubernetes.default.svc:443/', 'blocked_host'],
      ['http://evil.example.com:8080/mcp', 'host_not_allowed'],
    ];
    const logStart = logLines.length;
    const bodies: string[] = [];

    for (const [url, reason] of BLOCKED) {
      const response = await call('POST', '/api/admin/servers', adminKey, { slug: 'ssrfpost', name: 'x', url });
      bodies.push(JSON.stringify(response.json));
      assert.equal(response.status, 400, url);
      assert.deepEqual(response.json, { error: 'invalid request', issues: [{ field: 'url', problem: 'url_blocked', reason }] }, url);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM upstream_servers WHERE slug = 'ssrfpost'")).rows[0].c, 0, 'a refused POST creates no row');

    // An allowed address is created.
    const created = await call('POST', '/api/admin/servers', adminKey, { slug: 'ssrfok', name: 'x', url: 'http://x.test/mcp' });
    assert.equal(created.status, 201);
    const id = created.json.server.id as string;
    const rowBefore = (await pool.query('SELECT url, updated_at, seed_managed FROM upstream_servers WHERE id = $1', [id])).rows[0];

    for (const [url, reason] of BLOCKED) {
      const response = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { name: 'changed', url });
      bodies.push(JSON.stringify(response.json));
      assert.equal(response.status, 400, url);
      assert.deepEqual(response.json, { error: 'invalid request', issues: [{ field: 'url', problem: 'url_blocked', reason }] }, url);
    }
    const rowAfter = (await pool.query('SELECT url, name, updated_at, seed_managed FROM upstream_servers WHERE id = $1', [id])).rows[0];
    assert.equal(rowAfter.url, 'http://x.test/mcp', 'a refused PATCH leaves the url unchanged');
    assert.equal(rowAfter.name, 'x', 'a refused PATCH changes no other field either');
    assert.deepEqual([rowAfter.updated_at, rowAfter.seed_managed], [rowBefore.updated_at, rowBefore.seed_managed]);

    // A PATCH without a url is not checked, and a PATCH with an allowed url works.
    const disabled = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.server.enabled, false);
    const moved = await call('PATCH', `/api/admin/servers/${id}`, adminKey, { url: 'http://gamma.test/mcp' });
    assert.equal(moved.status, 200);

    // Leak scan with a control: the refused hosts are in no response body and no log line made by these requests.
    const CONTROL = 'leak-control-7d1e.example.com';
    const needles = ['169.254.169.254', 'kubernetes.default.svc', 'evil.example.com', ':8080/mcp', CONTROL];
    assert.ok(needles.length >= 5, `only ${needles.length} needles were loaded`);
    const found = (text: string) => needles.filter((needle) => text.includes(needle));
    const scanned = [...bodies, ...logLines.slice(logStart)].join('\n');
    assert.deepEqual(found(scanned), [], 'a refused host reached a response or a log line');
    assert.ok(logLines.slice(logStart).some((line) => line.includes('server url refused') && line.includes('"reason":"ip_literal"')), 'the refusal is logged with its reason');
    assert.deepEqual(found(`${scanned}\nplanted ${CONTROL}`), [CONTROL], 'the control must be found, or the scan proves nothing');

    assert.equal((await call('DELETE', `/api/admin/servers/${id}`, adminKey)).status, 204);
  });

  test('remove deletes the server and its credential', async () => {
    const id = (await pool.query("SELECT id FROM upstream_servers WHERE slug = 'beta'")).rows[0].id;
    assert.equal((await call('DELETE', `/api/admin/servers/${id}`, adminKey)).status, 204);
    assert.equal((await call('GET', `/api/admin/servers/${id}`, adminKey)).status, 404);
  });

  test('last_used_at is written at most once per minute per key', async () => {
    const fresh = await createApiKey(pool, 'member@example.com', 'throttle');
    const lastUsed = async () => (await pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [fresh.view.id])).rows[0].last_used_at as Date | null;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await lastUsed(), null);

    clock += 10 * 60_000;
    await call('GET', '/api/admin/servers', fresh.key);
    await settle();
    const first = await lastUsed();
    assert.ok(first, 'the first request writes last_used_at');

    // A second PostgreSQL write guard: even a process that forgot its own timer would not write again within a minute.
    await pool.query("UPDATE api_keys SET last_used_at = now() - interval '5 seconds' WHERE id = $1", [fresh.view.id]);
    const stamped = await lastUsed();
    clock += 30_000;
    await call('GET', '/api/admin/servers', fresh.key);
    await settle();
    assert.deepEqual(await lastUsed(), stamped, 'no write 30 seconds later');

    clock += 40_000;
    await pool.query("UPDATE api_keys SET last_used_at = now() - interval '5 minutes' WHERE id = $1", [fresh.view.id]);
    const old = await lastUsed();
    await call('GET', '/api/admin/servers', fresh.key);
    await settle();
    assert.ok((await lastUsed())!.getTime() > old!.getTime(), 'a write after more than a minute');
  });

  test('leak scan: no credential, master key or API key in any response, header or log (with a control)', async () => {
    const needles: Record<string, string[]> = {
      'upstream credential': [CANARY, CANARY_TWO, Buffer.from(CANARY).toString('base64'), Buffer.from(CANARY).toString('hex')],
      'master key': [masterKeyText, Buffer.from(masterKeyText, 'base64').toString('hex'), Buffer.from(masterKeyText, 'base64').toString('base64url')],
      'admin api key': [adminKey, Buffer.from(adminKey).toString('base64')],
      'member api key': [memberKey, Buffer.from(memberKey).toString('base64')],
    };
    const haystacks = { responses: seen.join('\n'), logs: logLines.join('\n') };
    assert.ok(haystacks.responses.length > 1000 && haystacks.logs.length > 100, 'the scan has something to scan');

    // The control: the scanner must find each needle in a text that holds it, in every encoding it looks for.
    const contains = (text: string, needleList: string[]) => needleList.some((needle) => text.includes(needle));
    for (const [label, list] of Object.entries(needles)) {
      for (const needle of list) assert.ok(contains(`before ${needle} after`, list), `control: the scanner finds ${label}`);
    }
    for (const [label, list] of Object.entries(needles)) {
      assert.ok(!contains(haystacks.responses, list), `${label} found in a response`);
      assert.ok(!contains(haystacks.logs, list), `${label} found in a log`);
    }
    assert.ok(logLines.some((line) => line.includes('server registered')), 'the log recorded the registration (names only)');
  });
});
