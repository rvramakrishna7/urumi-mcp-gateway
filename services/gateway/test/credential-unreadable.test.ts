import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createGateway } from '../src/core/gateway.ts';
import type { Caller, Gateway } from '../src/core/gateway.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { getServerBySlug, insertServer } from '../src/registry/repository.ts';
import type { UpstreamLimits } from '../src/upstream/client.ts';
import { createPoller } from '../src/upstream/poller.ts';
import type { Poller } from '../src/upstream/poller.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';
import { startFake } from './helpers/fake-upstream.ts';
import type { Fake } from './helpers/fake-upstream.ts';

const TOKEN = 'canary-unreadable-token-77aa41c9e0d25b13';
const schema = { type: 'object', properties: {} };
const limits: UpstreamLimits = { connectTimeoutMs: 400, listTimeoutMs: 400, maxResponseBytes: 64 * 1024 };

// A master key that was changed or lost: the rows of "locked" were encrypted with an older key, the gateway runs with a
// new one. Nothing may crash, the other server must keep working, and the log must not show any secret value.
describe('an upstream credential that cannot be decrypted (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keyDir: string;
  let currentKeyring: Keyring;
  let gateway: Gateway;
  let poller: Poller;
  let member: Caller;
  let locked: Fake;
  let fine: Fake;
  const logLines: string[] = [];

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-unreadable-'));
    writeFileSync(join(keyDir, 'old'), randomBytes(32).toString('base64'));
    writeFileSync(join(keyDir, 'new'), randomBytes(32).toString('base64'));
    const oldKeyring = loadKeyring(join(keyDir, 'old'), 'kold');
    currentKeyring = loadKeyring(join(keyDir, 'new'), 'knew');

    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    const user = await createUser(pool, 'member@example.com', 'member');
    await createApiKey(pool, 'member@example.com', 'member key');
    member = { userId: user.id, email: user.email, via: 'mcp' };

    locked = await startFake({ token: TOKEN, tools: [{ name: 'ping', description: 'ping', inputSchema: schema }] });
    fine = await startFake({ tools: [{ name: 'ping', description: 'ping', inputSchema: schema }] });
    await insertServer(pool, oldKeyring, { slug: 'locked', name: 'locked', url: locked.url, enabled: true, callTimeoutMs: 30_000, credential: { kind: 'bearer', value: TOKEN } }, { createdBy: null, seedManaged: false });
    await insertServer(pool, currentKeyring, { slug: 'fine', name: 'fine', url: fine.url, enabled: true, callTimeoutMs: 30_000 }, { createdBy: null, seedManaged: false });

    const logger = createLogger((line) => logLines.push(line));
    gateway = createGateway({ db: pool, keyring: currentKeyring, logger, limits });
    poller = createPoller({ db: pool, keyring: currentKeyring, logger, limits, intervalMs: 150, jitterMs: 0 });
  });

  after(async () => {
    await poller.stop();
    await Promise.all([locked.stop(), fine.stop()]);
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  const warnings = () => logLines.map((line) => JSON.parse(line)).filter((entry) => entry.message === 'stored credential is unreadable');

  test('the poller marks the server unreachable with credential_unreadable and the other server connects', async () => {
    const report = await poller.refreshNow();
    const by = Object.fromEntries(report.map((entry) => [entry.slug, entry]));
    assert.deepEqual([by.locked.status, by.locked.reason], ['unreachable', 'credential_unreadable']);
    assert.equal(by.fine.status, 'connected');
    const row = await getServerBySlug(pool, 'locked');
    assert.deepEqual([row?.status, row?.statusReason], ['unreachable', 'credential_unreadable']);
    assert.deepEqual((await gateway.listTools(member)).map((tool) => tool.name), ['fine__ping']);
    assert.equal(locked.requests.length, 0, 'the locked upstream received no request');
  });

  test('a call gets the normal unreachable result, its audit row is finished, and the other server still answers', async () => {
    // Put the status back, so that the call itself has to find out (a status may be old).
    await pool.query("UPDATE upstream_servers SET status = 'connected', status_reason = NULL WHERE slug = 'locked'");
    await pool.query("INSERT INTO upstream_tools (server_id, name, description, input_schema) SELECT id, 'ping', 'ping', '{}'::jsonb FROM upstream_servers WHERE slug = 'locked' ON CONFLICT DO NOTHING");
    const result = await gateway.callTool(member, 'locked__ping', {});
    assert.equal(result.isError, true);
    assert.equal((result.content[0] as { text: string }).text, 'Server "locked" is unreachable.');
    const row = (await pool.query("SELECT outcome, error_kind, duration_ms, user_email FROM audit_log WHERE requested_name = 'locked__ping'")).rows[0];
    assert.deepEqual([row.outcome, row.error_kind, row.user_email], ['unreachable', 'credential_unreadable', 'member@example.com']);
    assert.ok(row.duration_ms !== null, 'phase 2 finished the row');
    assert.equal((await getServerBySlug(pool, 'locked'))?.statusReason, 'credential_unreadable');
    assert.equal(locked.requests.length, 0, 'the locked upstream received no request');

    const other = await gateway.callTool(member, 'fine__ping', {});
    assert.notEqual(other.isError, true);
  });

  test('the warnings hold only the slug and the reason, and no secret value reaches the log, the status or the audit rows', async () => {
    const entries = warnings();
    assert.ok(entries.length >= 2, 'the poller and the call each warned');
    for (const entry of entries) {
      const { time: _time, level: _level, message: _message, ...fields } = entry;
      assert.deepEqual(fields, { server: 'locked', reason: 'credential_unreadable' });
    }
    const stored = (await pool.query("SELECT encode(credential_ciphertext, 'hex') AS c, encode(credential_ciphertext, 'base64') AS b, encode(credential_nonce, 'hex') AS n, encode(credential_nonce, 'base64') AS nb FROM upstream_servers WHERE slug = 'locked'")).rows[0];
    const database = JSON.stringify([
      (await pool.query('SELECT slug, status, status_reason FROM upstream_servers')).rows,
      (await pool.query('SELECT * FROM audit_log')).rows,
    ]);
    const needles = [TOKEN, 'canary', 'kold', 'knew', stored.c, stored.b, stored.n, stored.nb];
    for (const [where, text] of Object.entries({ logs: logLines.join('\n'), database })) {
      for (const needle of needles) assert.ok(!text.includes(needle), `${where} contains a secret value`);
    }
  });
});
