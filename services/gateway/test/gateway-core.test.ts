import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { createGateway } from '../src/core/gateway.ts';
import type { Caller, Gateway } from '../src/core/gateway.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createApiKey, createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { getServerBySlug, insertServer, patchServer } from '../src/registry/repository.ts';
import type { UpstreamLimits } from '../src/upstream/client.ts';
import { createPoller } from '../src/upstream/poller.ts';
import type { Poller } from '../src/upstream/poller.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';
import { startFake } from './helpers/fake-upstream.ts';
import type { Fake, FakeOptions, FakeTool } from './helpers/fake-upstream.ts';

const TOKEN = 'canary-gateway-upstream-token-5d1f8a3c7b9e2046';
const schema = { type: 'object', properties: { text: { type: 'string' } } };
const tool = (name: string, extra: Partial<FakeTool> = {}): FakeTool => ({ name, description: `The ${name} tool`, inputSchema: schema, ...extra });

// Short limits keep the failure cases quick. The production values (3 s, 5 s, 2 MB) are in DEFAULT_LIMITS.
const limits: UpstreamLimits = { connectTimeoutMs: 400, listTimeoutMs: 400, maxResponseBytes: 64 * 1024 };

describe('gateway core: aggregation, routing, isolation and audit, against fake upstreams (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keyring: Keyring;
  let keyDir: string;
  let gateway: Gateway;
  let poller: Poller;
  let admin: Caller;
  let member: Caller;
  let adminKey: string;
  let memberKey: string;
  const logLines: string[] = [];
  const fakes: Record<string, Fake> = {};
  // Every result and every error text that the tests received, for the leak scan.
  const seen: string[] = [];
  const made: string[] = [];

  async function register(slug: string, options: FakeOptions, extra: { callTimeoutMs?: number; bearer?: string; dead?: boolean } = {}): Promise<Fake> {
    const fake = await startFake(options);
    fakes[slug] = fake;
    await insertServer(
      pool,
      keyring,
      {
        slug,
        name: slug,
        url: fake.url,
        enabled: true,
        callTimeoutMs: extra.callTimeoutMs ?? 30_000,
        ...(extra.bearer ? { credential: { kind: 'bearer' as const, value: extra.bearer } } : {}),
      },
      { createdBy: null, seedManaged: false },
    );
    if (extra.dead) await fake.stop();
    return fake;
  }

  async function call(caller: Caller, name: string, args: Record<string, unknown> = {}) {
    made.push(name);
    const result = await gateway.callTool(caller, name, args);
    seen.push(JSON.stringify(result));
    return result;
  }

  const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
  const statusOf = async (slug: string) => (await getServerBySlug(pool, slug))!;
  const names = async () => (await gateway.listTools(admin)).map((entry) => entry.name);

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'gateway-core-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    keyring = loadKeyring(join(keyDir, 'key'), 'k1');

    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    const adminUser = await createUser(pool, 'admin@example.com', 'admin');
    const memberUser = await createUser(pool, 'member@example.com', 'member');
    adminKey = (await createApiKey(pool, 'admin@example.com', 'admin key')).key;
    memberKey = (await createApiKey(pool, 'member@example.com', 'member key')).key;
    admin = { userId: adminUser.id, email: adminUser.email, via: 'mcp' };
    member = { userId: memberUser.id, email: memberUser.email, via: 'chat' };

    const logger = createLogger((line) => logLines.push(line));
    gateway = createGateway({ db: pool, keyring, logger, limits });
    poller = createPoller({ db: pool, keyring, logger, limits, intervalMs: 150, jitterMs: 0 });

    await register('fast', { token: TOKEN, tools: [tool('echo'), tool('ping')] }, { bearer: TOKEN });
    await register('mixed', { tools: [tool('quick'), tool('sluggish')], callDelayMs: { sluggish: 2500 } }, { callTimeoutMs: 1000 });
    await register('slow', { tools: [tool('never_listed')], listDelayMs: 3000 });
    await register('dead', { tools: [tool('never_listed')] }, { dead: true });
    await register('dying', { tools: [tool('ping')] });
    await register('huge', { tools: [tool('big')], hugeTools: { big: 200 * 1024 } });
    await register('dup1', { tools: [tool('list_items')], resultText: () => 'answer of dup1' });
    await register('dup2', { tools: [tool('list_items')], resultText: () => 'answer of dup2' });
    await register('inv', { tools: [tool('bad name'), tool('good_tool'), tool('semi;colon')] });
    await register('many', { tools: Array.from({ length: 250 }, (_, index) => tool(`tool_${index}`)) });
    await register('bigschema', { tools: [tool('huge_schema', { inputSchema: { type: 'object', properties: { x: { type: 'string', description: 'y'.repeat(40_000) } } } }), tool('fine')] });
  });

  after(async () => {
    await poller.stop();
    await Promise.all(Object.values(fakes).map((fake) => fake.stop().catch(() => {})));
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  test('before any poll nothing is listed, and a poll connects every healthy upstream', async (t) => {
    assert.deepEqual(await names(), [], 'servers that were never probed are "unknown" and contribute no tools');
    const started = Date.now();
    const report = await poller.refreshNow();
    t.diagnostic(`first poll of ${report.length} upstreams took ${Date.now() - started} ms`);
    const by = Object.fromEntries(report.map((entry) => [entry.slug, entry]));
    for (const slug of ['fast', 'mixed', 'dying', 'huge', 'dup1', 'dup2', 'inv', 'many', 'bigschema']) assert.equal(by[slug].status, 'connected', slug);
    assert.deepEqual([by.slow.status, by.slow.reason], ['unreachable', 'timeout']);
    assert.deepEqual([by.dead.status, by.dead.reason], ['unreachable', 'refused']);
  });

  test('the aggregated list has the prefixed name of every tool of every healthy upstream and none of the others', async () => {
    const listed = await names();
    for (const expected of ['fast__echo', 'fast__ping', 'mixed__quick', 'mixed__sluggish', 'dying__ping', 'huge__big', 'dup1__list_items', 'dup2__list_items', 'inv__good_tool']) {
      assert.ok(listed.includes(expected), `${expected} is listed`);
    }
    assert.ok(!listed.some((name) => name.startsWith('slow__') || name.startsWith('dead__')), 'no tool of an unreachable upstream');
    assert.equal(new Set(listed).size, listed.length, 'every exposed name is unique');
  });

  test('two upstreams with the same tool name stay apart, and each call reaches the right one', async () => {
    assert.equal(textOf(await call(admin, 'dup1__list_items')), 'answer of dup1');
    assert.equal(textOf(await call(admin, 'dup2__list_items')), 'answer of dup2');
    assert.equal(fakes.dup1.toolCalls(), 1);
    assert.equal(fakes.dup2.toolCalls(), 1);
  });

  test('a tool with an invalid name is skipped with a reason, and its valid sibling stays', async () => {
    const listed = await names();
    assert.ok(listed.includes('inv__good_tool'));
    assert.ok(!listed.some((name) => name.includes('bad') || name.includes('semi')));
    const rows = await pool.query(`SELECT t.name, t.skipped_reason FROM upstream_tools t JOIN upstream_servers s ON s.id = t.server_id WHERE s.slug = 'inv' ORDER BY t.name`);
    assert.deepEqual(
      rows.rows.map((row) => [row.name, row.skipped_reason]),
      [['bad?name', 'invalid name'], ['good_tool', null], ['semi?colon', 'invalid name']],
    );
    assert.equal((await call(admin, 'inv__bad name')).isError, true, 'a skipped tool cannot be called');
  });

  test('limit: at most 200 tools are accepted from one upstream and the reason is recorded on the server', async () => {
    const count = await pool.query(`SELECT count(*)::int AS n FROM upstream_tools t JOIN upstream_servers s ON s.id = t.server_id WHERE s.slug = 'many'`);
    assert.equal(count.rows[0].n, 200);
    const many = await statusOf('many');
    assert.equal(many.status, 'connected');
    assert.equal(many.statusReason, 'tool limit: 250 offered, first 200 reviewed');
    assert.ok((await names()).includes('many__tool_199'));
    assert.ok(!(await names()).includes('many__tool_200'));
  });

  test('limit: a tool with an oversized input schema is skipped with a reason; the other tool of the server stays', async () => {
    const rows = await pool.query(`SELECT t.name, t.skipped_reason FROM upstream_tools t JOIN upstream_servers s ON s.id = t.server_id WHERE s.slug = 'bigschema' ORDER BY t.name`);
    assert.deepEqual(rows.rows.map((row) => [row.name, row.skipped_reason !== null]), [['fine', false], ['huge_schema', true]]);
    assert.match(rows.rows[1].skipped_reason, /larger than 32768 bytes/);
    assert.ok((await names()).includes('bigschema__fine'));
    assert.ok(!(await names()).includes('bigschema__huge_schema'));
  });

  test('descriptions are stored cleaned, with the hash of the description as received', async () => {
    fakes.fast.options.tools = [tool('echo', { description: 'Echo\u0000 text\u202E' }), tool('ping')];
    await poller.refreshNow();
    const row = await pool.query(`SELECT t.description, encode(t.description_hash, 'hex') AS hash FROM upstream_tools t JOIN upstream_servers s ON s.id = t.server_id WHERE s.slug = 'fast' AND t.name = 'echo'`);
    assert.equal(row.rows[0].description, 'Echo text');
    const { createHash } = await import('node:crypto');
    assert.equal(row.rows[0].hash, createHash('sha256').update('Echo\u0000 text\u202E').digest('hex'));
  });

  test('a tool that the upstream stops offering leaves the list after the next poll', async () => {
    fakes.fast.options.tools = [tool('echo')];
    await poller.refreshNow();
    assert.ok(!(await names()).includes('fast__ping'));
    fakes.fast.options.tools = [tool('echo'), tool('ping')];
    await poller.refreshNow();
    assert.ok((await names()).includes('fast__ping'));
  });

  test('a real call: the arguments reach the upstream, the credential is sent, the result comes back, one audit row exists', async () => {
    const before = fakes.fast.requests.length;
    const result = await call(admin, 'fast__echo', { text: 'hello' });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), 'echo done {"text":"hello"}');
    const sent = fakes.fast.requests.slice(before).filter((entry) => entry.method === 'POST');
    assert.ok(sent.every((entry) => entry.authorization === `Bearer ${TOKEN}`), 'the stored credential was decrypted and sent');
    const row = (await pool.query(`SELECT * FROM audit_log WHERE requested_name = 'fast__echo' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(row.user_email, 'admin@example.com');
    assert.equal(row.server_slug, 'fast');
    assert.equal(row.tool, 'echo');
    assert.equal(row.outcome, 'ok');
    assert.equal(row.via, 'mcp');
    assert.ok(row.duration_ms >= 0 && row.finished_at !== null);
    assert.ok(!JSON.stringify(row).includes('hello'), 'the arguments are not stored');
  });

  test('a slow upstream does not delay the list or a call to another upstream (measured)', async (t) => {
    const cycle = poller.refreshNow();
    const started = Date.now();
    const listStart = Date.now();
    const listed = await gateway.listTools(admin);
    const listMs = Date.now() - listStart;
    const callStart = Date.now();
    const answer = await call(admin, 'dup1__list_items');
    const callMs = Date.now() - callStart;
    await cycle;
    const cycleMs = Date.now() - started;
    t.diagnostic(`while the poll waited for the slow upstream: listTools ${listMs} ms (${listed.length} tools), a call to another upstream ${callMs} ms, whole poll ${cycleMs} ms`);
    assert.ok(listMs < 150, `the list took ${listMs} ms`);
    assert.ok(callMs < 400, `the call took ${callMs} ms`);
    assert.equal(textOf(answer), 'answer of dup1');
    // The slow upstream costs one list timeout (400 ms) and the dead one costs nothing: the poll takes about the
    // longest of them, not the sum.
    assert.ok(cycleMs < 1200, `the poll took ${cycleMs} ms`);
  });

  test('A: a tool call that times out is recorded on the audit row only; the server stays connected and its other tools work', async (t) => {
    const before = await statusOf('mixed');
    const started = Date.now();
    const slow = await call(admin, 'mixed__sluggish');
    const elapsed = Date.now() - started;
    t.diagnostic(`mixed__sluggish was cut after ${elapsed} ms (the server's call timeout is 1000 ms; the tool wanted 2500 ms)`);
    assert.equal(slow.isError, true);
    assert.equal(textOf(slow), 'Server "mixed" did not answer within 1 s.');
    assert.ok(elapsed >= 900 && elapsed < 1800);

    const after = await statusOf('mixed');
    assert.equal(after.status, 'connected', 'a timeout of tools/call does not change the status');
    assert.equal(after.statusReason, before.statusReason);
    assert.equal(after.statusCheckedAt?.getTime(), before.statusCheckedAt?.getTime(), 'the status row was not touched');
    assert.ok((await names()).includes('mixed__quick') && (await names()).includes('mixed__sluggish'), 'its tools stay listed');
    assert.equal(textOf(await call(admin, 'mixed__quick', { a: 1 })), 'quick done {"a":1}', 'its other tool is still callable');

    const row = (await pool.query(`SELECT outcome, error_kind, duration_ms FROM audit_log WHERE requested_name = 'mixed__sluggish'`)).rows[0];
    assert.equal(row.outcome, 'timeout');
    assert.equal(row.error_kind, 'call_timeout');
    assert.ok(row.duration_ms >= 900);
  });

  test('a response over the size cap is an error for that call; the server stays connected', async () => {
    const result = await call(admin, 'huge__big');
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Server "huge" returned a response that is too large.');
    assert.equal((await statusOf('huge')).status, 'connected');
    const row = (await pool.query(`SELECT outcome, error_kind FROM audit_log WHERE requested_name = 'huge__big'`)).rows[0];
    assert.deepEqual([row.outcome, row.error_kind], ['error', 'call_too_large']);
  });

  test('a tool error of the upstream passes through and is audited as "error"', async () => {
    fakes.fast.options.failingTools = ['echo'];
    fakes.fast.options.resultText = () => 'the tool failed on purpose';
    const result = await call(admin, 'fast__echo');
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'the tool failed on purpose');
    fakes.fast.options.failingTools = [];
    fakes.fast.options.resultText = undefined;
    const row = (await pool.query(`SELECT outcome, error_kind FROM audit_log WHERE requested_name = 'fast__echo' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.deepEqual([row.outcome, row.error_kind], ['error', 'tool_error']);
    assert.equal((await statusOf('fast')).status, 'connected');
  });

  test('a call to an upstream that died: a clear error, the server becomes unreachable, the others are not affected', async () => {
    await fakes.dying.stop();
    const result = await call(member, 'dying__ping');
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Server "dying" is unreachable.');
    const dying = await statusOf('dying');
    assert.deepEqual([dying.status, dying.statusReason], ['unreachable', 'refused'], 'refused is a failure to reach the server, so the status changes');
    assert.ok(!(await names()).some((name) => name.startsWith('dying__')), 'its tools leave the list');
    assert.equal(textOf(await call(member, 'dup2__list_items')), 'answer of dup2');
    const row = (await pool.query(`SELECT outcome, error_kind, user_email, via FROM audit_log WHERE requested_name = 'dying__ping'`)).rows[0];
    assert.deepEqual([row.outcome, row.error_kind, row.user_email, row.via], ['unreachable', 'connect_refused', 'member@example.com', 'chat']);
  });

  test('status becomes unreachable within one poll and recovers when the upstream returns (the timer runs)', async (t) => {
    poller.start();
    try {
      const waitFor = async (wanted: string, limitMs: number) => {
        const started = Date.now();
        while (Date.now() - started < limitMs) {
          if ((await statusOf('dying')).status === wanted) return Date.now() - started;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`dying did not become ${wanted} in ${limitMs} ms`);
      };
      // It is unreachable already (the call above). It must stay so, and become connected after the restart.
      await fakes.dying.start();
      const recovered = await waitFor('connected', 2500);
      t.diagnostic(`recovered ${recovered} ms after the upstream came back (poll interval 150 ms in this test, 15 s in production)`);
      assert.ok((await names()).includes('dying__ping'), 'its tools are listed again');
      await fakes.dying.stop();
      const lost = await waitFor('unreachable', 2500);
      t.diagnostic(`marked unreachable ${lost} ms after it went away`);
      assert.ok(!(await names()).some((name) => name.startsWith('dying__')));
      await fakes.dying.start();
      await waitFor('connected', 2500);
    } finally {
      await poller.stop();
    }
  });

  test('a disabled server answers "Unknown tool", loses its tools from the list, and its upstream receives no request', async () => {
    const target = await statusOf('dup2');
    await patchServer(pool, keyring, target.id, { enabled: false });
    assert.ok(!(await names()).some((name) => name.startsWith('dup2__')));
    const before = fakes.dup2.requests.length;
    const result = await call(admin, 'dup2__list_items');
    assert.deepEqual([result.isError, textOf(result)], [true, 'Unknown tool']);
    assert.equal(fakes.dup2.requests.length, before, 'nothing reached the disabled upstream');
    // A server that does not exist gets the same answer, so a caller cannot tell the two apart.
    for (const name of ['nope__x', 'nope', 'fast__missing', '__echo', 'fast__', 'q'.repeat(500) + '\u0000\u0007']) {
      const unknown = await call(member, name);
      assert.deepEqual([unknown.isError, textOf(unknown)], [true, 'Unknown tool'], name.slice(0, 20));
    }
    await patchServer(pool, keyring, target.id, { enabled: true });
    await poller.refreshNow();
    assert.ok((await names()).includes('dup2__list_items'), 'enabled again, the tool returns');
  });

  test('every call has exactly one audit row, with user, server, tool, duration and outcome', async () => {
    const rows = (await pool.query('SELECT requested_name, outcome, user_email, duration_ms, finished_at FROM audit_log ORDER BY id')).rows;
    assert.equal(rows.length, made.length, 'one row per call, no more and no less');
    assert.deepEqual(rows.map((row) => row.requested_name.replace(/\?/g, '\u0000')).slice(0, 5), made.slice(0, 5));
    assert.ok(rows.every((row) => row.outcome !== 'started' && row.finished_at !== null && row.duration_ms >= 0), 'every row is finished');
    const outcomes: Record<string, number> = {};
    for (const row of rows) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    assert.ok(outcomes.ok >= 5 && outcomes.timeout === 1 && outcomes.unreachable === 1 && outcomes.unknown_tool >= 7, JSON.stringify(outcomes));
    assert.ok(rows.some((row) => row.user_email === 'member@example.com'));
  });

  test('the debug routes need an admin key; a call through them is audited under that admin', async () => {
    const logger = createLogger((line) => logLines.push(line));
    const { app } = createApp({ logger, checkDatabase: async () => {}, debug: { db: pool, gateway, poller, logger } });
    const server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/debug`;
    try {
      const send = async (method: string, path: string, key: string | null, body?: unknown) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (key) headers.authorization = `Bearer ${key}`;
        const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, json: (await response.json().catch(() => null)) as any };
      };
      assert.equal((await send('GET', '/tools', null)).status, 401);
      assert.equal((await send('GET', '/tools', memberKey)).status, 403);
      assert.equal((await send('POST', '/call', memberKey, { name: 'fast__echo' })).status, 403);
      assert.equal((await send('POST', '/refresh', memberKey)).status, 403);
      const listed = await send('GET', '/tools', adminKey);
      assert.equal(listed.status, 200);
      assert.ok(listed.json.tools.some((entry: { name: string }) => entry.name === 'fast__echo'));
      assert.equal((await send('POST', '/call', adminKey, { name: 5 })).status, 400);
      made.push('fast__ping');
      const called = await send('POST', '/call', adminKey, { name: 'fast__ping', arguments: { text: 'x' } });
      assert.equal(called.status, 200);
      assert.equal(called.json.content[0].text, 'ping done {"text":"x"}');
      const row = (await pool.query(`SELECT user_email FROM audit_log WHERE requested_name = 'fast__ping' ORDER BY id DESC LIMIT 1`)).rows[0];
      assert.equal(row.user_email, 'admin@example.com');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  test('when the phase 1 audit insert fails the upstream receives no request and the caller gets a clear error', async () => {
    await pool.query(`CREATE FUNCTION audit_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit is down'; END $$`);
    await pool.query('CREATE TRIGGER audit_down BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_down()');
    try {
      const before = Object.fromEntries(Object.entries(fakes).map(([slug, fake]) => [slug, fake.requests.length]));
      const result = await gateway.callTool(admin, 'fast__echo', { text: 'must not be sent' });
      seen.push(JSON.stringify(result));
      assert.deepEqual([result.isError, textOf(result)], [true, 'The call was not made because it could not be recorded.']);
      const after = Object.fromEntries(Object.entries(fakes).map(([slug, fake]) => [slug, fake.requests.length]));
      assert.deepEqual(after, before, 'no upstream received any request');
      assert.ok(!JSON.stringify(fakes.fast.requests).includes('must not be sent'));
      assert.ok(logLines.some((line) => line.includes('audit phase 1 failed')));
    } finally {
      await pool.query('DROP TRIGGER audit_down ON audit_log');
      await pool.query('DROP FUNCTION audit_down()');
    }
    const count = await pool.query('SELECT count(*)::int AS n FROM audit_log');
    assert.equal(count.rows[0].n, made.length, 'the refused call left no row');
  });

  test('when the phase 2 update fails the result is still returned and the failure is logged', async () => {
    await pool.query(`CREATE FUNCTION audit_end_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit update is down'; END $$`);
    await pool.query('CREATE TRIGGER audit_end_down BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_end_down()');
    try {
      const result = await call(admin, 'fast__ping');
      assert.equal(result.isError, undefined);
      assert.ok(logLines.some((line) => line.includes('audit phase 2 failed')));
      const row = (await pool.query(`SELECT outcome FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
      assert.equal(row.outcome, 'started', 'the row stays "started" for a later sweep');
    } finally {
      await pool.query('DROP TRIGGER audit_end_down ON audit_log');
      await pool.query('DROP FUNCTION audit_end_down()');
    }
  });

  test('leak scan: no URL, port, credential or upstream body in a result, a log line, a status or an audit row', async () => {
    const database = JSON.stringify([
      (await pool.query('SELECT slug, status, status_reason FROM upstream_servers')).rows,
      (await pool.query('SELECT * FROM audit_log')).rows,
      (await gateway.listTools(admin)),
    ]);
    const haystacks = { results: seen.join('\n'), logs: logLines.join('\n'), database };
    const needles = ['canary', TOKEN, '127.0.0.1', ...Object.values(fakes).map((fake) => String(fake.port)), 'xxxxxxxxxxxxxxxx'];
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of needles) {
        // The status of a server may hold the word "canary"? No: only codes. The list holds descriptions of the fakes.
        assert.ok(!text.includes(needle), `${where} contains "${needle}"`);
      }
    }
    assert.ok(seen.length > 15 && logLines.length > 3, 'the scan looked at something');
  });
});
