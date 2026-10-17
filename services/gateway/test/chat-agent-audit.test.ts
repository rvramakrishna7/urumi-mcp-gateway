import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createAgent, InvalidConfirmationError } from '../src/chat/agent.ts';
import type { Agent } from '../src/chat/agent.ts';
import { issueConfirmToken } from '../src/chat/confirm.ts';
import type { GroqCompletion, GroqToolCall } from '../src/chat/groq.ts';
import { createGateway } from '../src/core/gateway.ts';
import type { Gateway } from '../src/core/gateway.ts';
import { loadKeyring } from '../src/crypto/credentials.ts';
import type { Keyring } from '../src/crypto/credentials.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { insertServer } from '../src/registry/repository.ts';
import type { UpstreamLimits } from '../src/upstream/client.ts';
import { createPoller } from '../src/upstream/poller.ts';
import type { Poller } from '../src/upstream/poller.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';
import { startFake } from './helpers/fake-upstream.ts';
import type { Fake } from './helpers/fake-upstream.ts';

const limits: UpstreamLimits = { connectTimeoutMs: 1000, listTimeoutMs: 1000, maxResponseBytes: 64 * 1024 };
const schema = { type: 'object', properties: { name: { type: 'string' } } };
const CONFIRM = ['shop__create_product'];

const call = (name: string, args: unknown, id: string): GroqToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const asks = (...calls: GroqToolCall[]): GroqCompletion => ({ message: { content: null, tool_calls: calls }, finishReason: 'tool_calls', totalTokens: 1 });
const answer = (content: string): GroqCompletion => ({ message: { content, tool_calls: [] }, finishReason: 'stop', totalTokens: 1 });

// The chat agent against the real gateway core and a real PostgreSQL: the audit row is the proof that the agent goes through
// callTool, as the logged-in user, with via = chat (docs/architecture.md, decisions 1b and 40).
describe('chat agent through the real gateway: audit rows (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keyring: Keyring;
  let keyDir: string;
  let gateway: Gateway;
  let poller: Poller;
  let fake: Fake;
  let member: { id: string; email: string };
  let admin: { id: string; email: string };

  const script = (steps: GroqCompletion[]) => {
    let index = 0;
    return async () => steps[Math.min(index++, steps.length - 1)]!;
  };
  const agentWith = (steps: GroqCompletion[]): Agent =>
    createAgent({ gateway, groq: { complete: script(steps) }, keyring, logger: createLogger(() => {}), confirmTools: CONFIRM });
  const rows = async () =>
    (await pool.query('SELECT user_id, user_email, server_slug, tool, requested_name, outcome, via FROM audit_log ORDER BY id')).rows as {
      user_id: string; user_email: string; server_slug: string | null; tool: string | null; requested_name: string; outcome: string; via: string;
    }[];
  const as = (u: { id: string; email: string }) => ({ userId: u.id, email: u.email, role: u === admin ? ('admin' as const) : ('member' as const) });

  before(async () => {
    keyDir = mkdtempSync(join(tmpdir(), 'chat-agent-audit-'));
    writeFileSync(join(keyDir, 'key'), randomBytes(32).toString('base64'));
    keyring = loadKeyring(join(keyDir, 'key'), 'k1');
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    member = await createUser(pool, 'member@example.test', 'member');
    admin = await createUser(pool, 'admin@example.test', 'admin');
    const logger = createLogger(() => {});
    gateway = createGateway({ db: pool, keyring, logger, limits });
    poller = createPoller({ db: pool, keyring, logger, limits, intervalMs: 60_000, jitterMs: 0 });
    fake = await startFake({ tools: [{ name: 'list_orders', description: 'd', inputSchema: schema }, { name: 'create_product', description: 'd', inputSchema: schema }] });
    await insertServer(pool, keyring, { slug: 'shop', name: 'shop', url: fake.url, enabled: true, callTimeoutMs: 5000 }, { createdBy: null, seedManaged: false });
    await poller.refreshNow();
  });
  after(async () => {
    await poller.stop();
    await fake.stop().catch(() => {});
    await db.drop();
    rmSync(keyDir, { recursive: true, force: true });
  });

  test('a read tool: one audit row, for the session user, via chat, outcome ok, with the server and the tool', async () => {
    const result = await agentWith([asks(call('shop__list_orders', {}, 'c1')), answer('Two orders.')]).runTurn(as(member), [{ role: 'user', content: 'orders?' }]);
    assert.equal(result.reply, 'Two orders.');
    assert.deepEqual(await rows(), [{ user_id: member.id, user_email: member.email, server_slug: 'shop', tool: 'list_orders', requested_name: 'shop__list_orders', outcome: 'ok', via: 'chat' }]);
    assert.equal(fake.toolCalls(), 1);
  });

  test('the same tool for the admin is a row for the admin, and a call with via mcp stays mcp', async () => {
    await agentWith([asks(call('shop__list_orders', {}, 'c1')), answer('ok')]).runTurn(as(admin), [{ role: 'user', content: 'orders?' }]);
    await gateway.callTool({ userId: member.id, email: member.email, role: 'member', via: 'mcp' }, 'shop__list_orders', {});
    const all = await rows();
    assert.deepEqual(all.slice(-2).map((r) => [r.user_email, r.via]), [[admin.email, 'chat'], [member.email, 'mcp']]);
  });

  test('a write tool waits: no audit row and no call upstream until the confirmation arrives', async () => {
    const before = [(await rows()).length, fake.toolCalls()];
    const args = { name: 'Chat Mug' };
    const first = await agentWith([asks(call('shop__create_product', args, 'w1'))]).runTurn(as(member), [{ role: 'user', content: 'create a mug' }]);
    assert.ok(first.pending);
    assert.deepEqual([(await rows()).length, fake.toolCalls()], before, 'nothing happened yet');

    const second = await agentWith([answer('Created.')]).runTurn(as(member), [{ role: 'user', content: 'create a mug' }], { token: first.pending.token, name: first.pending.name, args: first.pending.args });
    assert.equal(second.reply, 'Created.');
    const all = await rows();
    assert.equal(all.length, before[0]! + 1);
    assert.deepEqual([all.at(-1)!.user_id, all.at(-1)!.tool, all.at(-1)!.outcome, all.at(-1)!.via], [member.id, 'create_product', 'ok', 'chat']);
    assert.equal(fake.toolCalls(), before[1]! + 1);
  });

  test('a confirmation that is not valid leaves no audit row and no call upstream', async () => {
    const before = [(await rows()).length, fake.toolCalls()];
    const args = { name: 'Chat Mug' };
    const token = issueConfirmToken(keyring, { userId: member.id, name: 'shop__create_product', args });
    // The token of the member, sent by the admin, and the token of the member with other arguments.
    await assert.rejects(agentWith([answer('x')]).runTurn(as(admin), [{ role: 'user', content: 'x' }], { token, name: 'shop__create_product', args }), InvalidConfirmationError);
    await assert.rejects(agentWith([answer('x')]).runTurn(as(member), [{ role: 'user', content: 'x' }], { token, name: 'shop__create_product', args: { name: 'Other' } }), InvalidConfirmationError);
    assert.deepEqual([(await rows()).length, fake.toolCalls()], before);
  });

  test('a tool name that the model made up is an unknown_tool row via chat, and no call upstream', async () => {
    const before = fake.toolCalls();
    await agentWith([asks(call('shop__drop_everything', {}, 'c1')), answer('There is no such tool.')]).runTurn(as(member), [{ role: 'user', content: 'x' }]);
    const last = (await rows()).at(-1)!;
    assert.deepEqual([last.outcome, last.via, last.user_id, last.tool], ['unknown_tool', 'chat', member.id, null]);
    assert.equal(fake.toolCalls(), before);
  });

  // The agent runs only names that it offered in this turn. Anything else goes to rejectToolCall: no confirmation card, no
  // credential read, no upstream request, and one complete audit row.
  test('a member whose model invents a restricted tool: no confirmation card, no call upstream, a denied row via chat', async () => {
    const restricted = createGateway({ db: pool, keyring, logger: createLogger(() => {}), limits, memberRestrictedTools: ['shop__create_product'] });
    const offered: string[][] = [];
    const agent = createAgent({
      gateway: restricted,
      groq: {
        complete: async (_messages, tools) => {
          offered.push(tools.map((entry) => entry.function.name));
          return offered.length === 1 ? asks(call('shop__create_product', { name: 'Sneaky' }, 'c1')) : answer('That needs an admin.');
        },
      },
      keyring,
      logger: createLogger(() => {}),
      confirmTools: CONFIRM,
    });
    const before = [(await rows()).length, fake.toolCalls()];
    const result = await agent.runTurn(as(member), [{ role: 'user', content: 'create a mug' }]);
    assert.equal(result.pending, undefined, 'no confirmation card');
    assert.equal(result.reply, 'That needs an admin.');
    assert.deepEqual(offered[0], ['shop__list_orders'], 'the model was never offered the restricted tool');
    assert.equal(fake.toolCalls(), before[1], 'nothing reached the upstream');
    const all = await rows();
    assert.equal(all.length, before[0]! + 1);
    assert.deepEqual([all.at(-1)!.user_id, all.at(-1)!.server_slug, all.at(-1)!.tool, all.at(-1)!.outcome, all.at(-1)!.via], [member.id, 'shop', 'create_product', 'denied', 'chat']);
    const kind = await pool.query('SELECT error_kind FROM audit_log ORDER BY id DESC LIMIT 1');
    assert.equal(kind.rows[0].error_kind, 'member_restricted');
  });

  test('a member with a valid confirmation token for a restricted tool is still refused, and nothing reaches the upstream', async () => {
    const restricted = createGateway({ db: pool, keyring, logger: createLogger(() => {}), limits, memberRestrictedTools: ['shop__create_product'] });
    const agent = createAgent({ gateway: restricted, groq: { complete: script([answer('Not allowed.')]) }, keyring, logger: createLogger(() => {}), confirmTools: CONFIRM });
    const args = { name: 'Chat Mug' };
    const token = issueConfirmToken(keyring, { userId: member.id, name: 'shop__create_product', args });
    const before = [(await rows()).length, fake.toolCalls()];
    await agent.runTurn(as(member), [{ role: 'user', content: 'x' }], { token, name: 'shop__create_product', args });
    assert.equal(fake.toolCalls(), before[1]);
    const all = await rows();
    assert.equal(all.length, before[0]! + 1);
    assert.deepEqual([all.at(-1)!.outcome, all.at(-1)!.via], ['denied', 'chat']);
  });

  test('an admin whose model asks for a real tool that was not offered this turn: no card, no call upstream, denied / not_offered', async () => {
    // The tool exists and the admin may use it, but this turn did not offer it (here the list hides it).
    const hiding: Pick<Gateway, 'listTools' | 'callTool' | 'rejectToolCall'> = {
      listTools: async (caller) => (await gateway.listTools(caller)).filter((entry) => entry.name !== 'shop__create_product'),
      callTool: (caller, name, args) => gateway.callTool(caller, name, args),
      rejectToolCall: (caller, name, reason) => gateway.rejectToolCall(caller, name, reason),
    };
    const agent = createAgent({
      gateway: hiding,
      groq: { complete: script([asks(call('shop__create_product', { name: 'Sneaky' }, 'c1')), answer('Done.')]) },
      keyring,
      logger: createLogger(() => {}),
      confirmTools: CONFIRM,
    });
    const before = [(await rows()).length, fake.toolCalls()];
    const result = await agent.runTurn(as(admin), [{ role: 'user', content: 'create a mug' }]);
    assert.equal(result.pending, undefined, 'a confirmation tool that was not offered gets no card');
    assert.equal(fake.toolCalls(), before[1]);
    const all = await rows();
    assert.equal(all.length, before[0]! + 1);
    assert.deepEqual([all.at(-1)!.user_id, all.at(-1)!.tool, all.at(-1)!.outcome, all.at(-1)!.via], [admin.id, 'create_product', 'denied', 'chat']);
    const kind = await pool.query('SELECT error_kind FROM audit_log ORDER BY id DESC LIMIT 1');
    assert.equal(kind.rows[0].error_kind, 'not_offered');
  });

  test('a disabled server is not offered to the model, and a call that asks for it anyway is unknown_tool', async () => {
    await pool.query("UPDATE upstream_servers SET enabled = false WHERE slug = 'shop'");
    try {
      const offered: string[][] = [];
      const agent = createAgent({
        gateway,
        groq: {
          complete: async (_messages, tools) => {
            offered.push(tools.map((tool) => tool.function.name));
            return offered.length === 1 ? asks(call('shop__list_orders', {}, 'c1')) : answer('The store is off.');
          },
        },
        keyring,
        logger: createLogger(() => {}),
        confirmTools: CONFIRM,
      });
      const before = fake.toolCalls();
      await agent.runTurn(as(member), [{ role: 'user', content: 'orders?' }]);
      assert.deepEqual(offered[0], []);
      assert.equal((await rows()).at(-1)!.outcome, 'unknown_tool');
      assert.equal(fake.toolCalls(), before);
    } finally {
      await pool.query("UPDATE upstream_servers SET enabled = true WHERE slug = 'shop'");
    }
  });

  test('the audit rows hold no arguments and no results of the chat calls', async () => {
    const marker = `ARG-MARKER-${randomBytes(4).toString('hex')}`;
    await agentWith([asks(call('shop__list_orders', { name: marker }, 'c1')), answer('ok')]).runTurn(as(member), [{ role: 'user', content: marker }]);
    const text = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    assert.equal(text.includes(marker), false);
    assert.equal(`${text}${marker}`.includes(marker), true, 'planted control');
  });
});
