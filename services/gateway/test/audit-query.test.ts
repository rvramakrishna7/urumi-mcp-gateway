import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { finishAudit, startAudit } from '../src/audit/repository.ts';
import { AUDIT_OUTCOMES, MAX_LIMIT, queryAudit } from '../src/audit/query.ts';
import type { AuditOutcomeValue, AuditPage } from '../src/audit/query.ts';
import { createLogger } from '../src/logger.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createUser } from '../src/identity/repository.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const ITEM_KEYS = ['durationMs', 'errorKind', 'finishedAt', 'id', 'outcome', 'requestId', 'requestedName', 'serverSlug', 'tool', 'ts', 'userEmail', 'userId', 'via'];

describe('audit_log reading, migration 0004 and the scope in SQL (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let adminId: string;
  let aliceId: string;
  let bobId: string;
  let seq = 0;

  const addRow = async (
    userId: string,
    email: string,
    options: { slug?: string | null; tool?: string; outcome?: AuditOutcomeValue; via?: 'mcp' | 'chat' } = {},
  ): Promise<number> => {
    const slug = options.slug === undefined ? 'woo' : options.slug;
    const tool = options.tool ?? 'list_orders';
    const id = await startAudit(pool, {
      userId,
      userEmail: email,
      serverId: null,
      serverSlug: slug,
      requestedName: slug ? `${slug}__${tool}` : tool,
      tool,
      via: options.via ?? 'mcp',
      requestId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    });
    const outcome = options.outcome ?? 'ok';
    if (outcome !== 'started') await finishAudit(pool, id, outcome as 'ok', null, 12);
    return id;
  };
  const ids = (page: AuditPage) => page.items.map((item) => item.id);

  before(async () => {
    db = await createTestDatabase();
    const client = await db.connect();
    // The audit rows of the cluster exist before this migration: make them first, then apply everything.
    const files = await loadMigrationFiles();
    await runMigrations(client, files.filter((file) => file.version < '0004'), createLogger(() => {}));
    pool = db.pool();
    adminId = (await createUser(pool, 'admin@example.test', 'admin')).id;
    aliceId = (await createUser(pool, 'alice@example.test', 'member')).id;
    bobId = (await createUser(pool, 'bob@example.test', 'member')).id;
    await addRow(aliceId, 'alice@example.test');
    await addRow(bobId, 'bob@example.test');
    await runMigrations(client, files, createLogger(() => {}));
  });
  after(async () => {
    await db.drop();
  });

  test('migration 0004 adds the one index, and the rows that existed before are unchanged', async () => {
    const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_log' AND indexname = 'audit_log_user_id_idx'");
    assert.equal(index.rowCount, 1);
    assert.match(index.rows[0].indexdef, /\(user_id, id DESC\)/);
    const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'audit_log' ORDER BY indexname")).rows.map((row) => row.indexname);
    assert.deepEqual(indexes, ['audit_log_pkey', 'audit_log_started_idx', 'audit_log_ts_idx', 'audit_log_user_id_idx', 'audit_log_user_ts_idx']);
    const rows = (await pool.query('SELECT user_email, outcome FROM audit_log ORDER BY id')).rows;
    assert.deepEqual(rows, [
      { user_email: 'alice@example.test', outcome: 'ok' },
      { user_email: 'bob@example.test', outcome: 'ok' },
    ]);
  });

  describe('who sees what', () => {
    before(async () => {
      await addRow(aliceId, 'alice@example.test', { tool: 'create_product' });
      await addRow(bobId, 'bob@example.test', { tool: 'get_order', via: 'chat' });
      await addRow(adminId, 'admin@example.test', { tool: 'list_products' });
      // A user who was deleted: the row stays and names the user by the copied email, but has no user id.
      const gone = (await createUser(pool, 'gone@example.test', 'member')).id;
      await addRow(gone, 'gone@example.test', { tool: 'list_products' });
      await pool.query('DELETE FROM users WHERE id = $1', [gone]);
    });

    test('a member sees only their own rows, and the rows of others and of a deleted user are absent', async () => {
      const page = await queryAudit(pool, { role: 'member', userId: aliceId });
      assert.deepEqual(page.items.map((item) => item.userEmail), ['alice@example.test', 'alice@example.test']);
      assert.ok(page.items.every((item) => item.userId === aliceId));
      // The planted control: the data that must not be there exists in the table.
      const total = (await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
      assert.equal(total, 6);
      assert.ok(!page.items.some((item) => item.userEmail === 'bob@example.test' || item.userEmail === 'gone@example.test' || item.userId === null));
    });

    test('a member cannot widen the scope with a filter, with outcomes, with a cursor or with a huge limit', async () => {
      await assert.rejects(queryAudit(pool, { role: 'member', userId: aliceId }, { userId: bobId }), /a member cannot filter by user/);
      const wide = await queryAudit(pool, { role: 'member', userId: aliceId }, { outcomes: [...AUDIT_OUTCOMES], limit: 1_000_000, server: 'woo', via: 'mcp', cursor: '999999999' });
      assert.ok(wide.items.length > 0);
      assert.ok(wide.items.every((item) => item.userId === aliceId));
      // A value that tries to leave the condition is only a value.
      const evil = await queryAudit(pool, { role: 'member', userId: aliceId }, { tool: "x' OR '1'='1", server: "woo' OR user_id IS NOT NULL --" });
      assert.deepEqual(evil.items, []);
    });

    test('an admin sees every row, including the row of a deleted user, and can filter by user', async () => {
      const all = await queryAudit(pool, { role: 'admin' });
      assert.equal(all.items.length, 6);
      assert.ok(all.items.some((item) => item.userId === null && item.userEmail === 'gone@example.test'));
      const bob = await queryAudit(pool, { role: 'admin' }, { userId: bobId });
      assert.deepEqual(bob.items.map((item) => item.userEmail), ['bob@example.test', 'bob@example.test']);
    });

    test('rows from an external client and from the chat both show, with their via', async () => {
      const all = await queryAudit(pool, { role: 'admin' });
      assert.deepEqual([...new Set(all.items.map((item) => item.via))].sort(), ['chat', 'mcp']);
    });

    test('an item has exactly the documented fields and nothing else', async () => {
      const page = await queryAudit(pool, { role: 'admin' }, { limit: 1 });
      assert.deepEqual(Object.keys(page.items[0]!).sort(), ITEM_KEYS);
    });
  });

  describe('filters', () => {
    before(async () => {
      await addRow(aliceId, 'alice@example.test', { slug: 'other', tool: 'ping', outcome: 'timeout' });
      await addRow(aliceId, 'alice@example.test', { slug: null, tool: 'nothing', outcome: 'unknown_tool' });
      await addRow(aliceId, 'alice@example.test', { slug: 'woo', tool: 'list_orders', outcome: 'started' });
    });
    const admin = { role: 'admin' } as const;

    test('server, tool, outcome, via', async () => {
      assert.ok((await queryAudit(pool, admin, { server: 'other' })).items.every((item) => item.serverSlug === 'other'));
      assert.equal((await queryAudit(pool, admin, { server: 'other' })).items.length, 1);
      assert.ok((await queryAudit(pool, admin, { tool: 'list_orders' })).items.every((item) => item.tool === 'list_orders'));
      const outcomes = await queryAudit(pool, admin, { outcomes: ['timeout', 'unknown_tool'] });
      assert.deepEqual(outcomes.items.map((item) => item.outcome).sort(), ['timeout', 'unknown_tool']);
      assert.ok((await queryAudit(pool, admin, { via: 'chat' })).items.every((item) => item.via === 'chat'));
    });

    test('a started row has no end and no duration', async () => {
      const started = await queryAudit(pool, admin, { outcomes: ['started'] });
      assert.equal(started.items.length, 1);
      assert.equal(started.items[0]!.finishedAt, null);
      assert.equal(started.items[0]!.durationMs, null);
    });

    test('time range: from is included and to is excluded', async () => {
      const t = new Date('2030-01-01T10:00:00.000Z');
      const early = await addRow(adminId, 'admin@example.test', { tool: 'range_a' });
      const middle = await addRow(adminId, 'admin@example.test', { tool: 'range_b' });
      const late = await addRow(adminId, 'admin@example.test', { tool: 'range_c' });
      await pool.query('UPDATE audit_log SET ts = $2 WHERE id = $1', [early, new Date(t.getTime() - 1000)]);
      await pool.query('UPDATE audit_log SET ts = $2 WHERE id = $1', [middle, t]);
      await pool.query('UPDATE audit_log SET ts = $2 WHERE id = $1', [late, new Date(t.getTime() + 1000)]);
      const window = await queryAudit(pool, admin, { from: t, to: new Date(t.getTime() + 1000) });
      assert.deepEqual(ids(window), [middle]);
      assert.deepEqual(ids(await queryAudit(pool, admin, { from: t })).sort(), [late, middle].sort());
      assert.ok(ids(await queryAudit(pool, admin, { to: t })).includes(early));
    });

    test('filters work together with the member scope', async () => {
      const page = await queryAudit(pool, { role: 'member', userId: aliceId }, { outcomes: ['timeout'], server: 'other' });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]!.userId, aliceId);
      assert.deepEqual((await queryAudit(pool, { role: 'member', userId: bobId }, { server: 'other' })).items, []);
    });
  });

  describe('keyset pagination on id', () => {
    let freshUser: string;
    before(async () => {
      freshUser = (await createUser(pool, 'pager@example.test', 'member')).id;
      for (let i = 0; i < 25; i++) await addRow(freshUser, 'pager@example.test', { tool: `t${i}` });
    });

    test('pages of 10 give 10, 10 and 5 rows, newest first, with no duplicate and no gap', async () => {
      const scope = { role: 'member', userId: freshUser } as const;
      const first = await queryAudit(pool, scope, { limit: 10 });
      const second = await queryAudit(pool, scope, { limit: 10, cursor: first.nextCursor! });
      const third = await queryAudit(pool, scope, { limit: 10, cursor: second.nextCursor! });
      assert.deepEqual([first.items.length, second.items.length, third.items.length], [10, 10, 5]);
      assert.notEqual(first.nextCursor, null);
      assert.notEqual(second.nextCursor, null);
      assert.equal(third.nextCursor, null);
      const seen = [...ids(first), ...ids(second), ...ids(third)];
      assert.equal(new Set(seen).size, 25);
      assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
      const everything = (await pool.query('SELECT id FROM audit_log WHERE user_id = $1 ORDER BY id DESC', [freshUser])).rows.map((row) => Number(row.id));
      assert.deepEqual(seen, everything);
    });

    test('rows that arrive between two pages do not shift the next page (an offset would)', async () => {
      const scope = { role: 'member', userId: freshUser } as const;
      const first = await queryAudit(pool, scope, { limit: 10 });
      for (let i = 0; i < 4; i++) await addRow(freshUser, 'pager@example.test', { tool: `late${i}` });
      const second = await queryAudit(pool, scope, { limit: 10, cursor: first.nextCursor! });
      assert.equal(second.items.filter((item) => ids(first).includes(item.id)).length, 0, 'no row of page 1 repeats');
      assert.equal(second.items.length, 10);
      // Page 1 is the newest ten of before; the four new rows are above it and are the next first page, not a gap.
      const fresh = await queryAudit(pool, scope, { limit: 4 });
      assert.deepEqual(fresh.items.map((item) => item.tool), ['late3', 'late2', 'late1', 'late0']);
    });

    test('limit is clamped, and an invalid cursor is refused', async () => {
      assert.equal((await queryAudit(pool, { role: 'admin' }, { limit: 0 })).items.length, 1);
      assert.ok((await queryAudit(pool, { role: 'admin' }, { limit: 10_000 })).items.length <= MAX_LIMIT);
      for (const cursor of ['abc', '0', '-1', '1; DROP TABLE audit_log', '1e3', '99999999999999999999']) {
        await assert.rejects(queryAudit(pool, { role: 'admin' }, { cursor }), /invalid cursor/, cursor);
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n > 0, true);
    });
  });

  // The evidence for migration 0004 (decision 38), with the planner left alone. The case that the index is for: a member who has
  // few rows in a large table. Without it the planner either walks the primary key and filters (reads most of the table to find
  // 51 rows) or reads the older index (user_id, ts) and sorts by id.
  test('a member with few rows in a table of 100000 reads audit_log_user_id_idx, in order, without a sort (planner not restricted)', async () => {
    for (let i = 0; i < 40; i++) await createUser(pool, `bulk${i}@example.test`, 'member');
    const rare = (await createUser(pool, 'rare@example.test', 'member')).id;
    await pool.query(
      `INSERT INTO audit_log (user_id, user_email, requested_name, tool, outcome, finished_at, duration_ms, via, request_id)
       SELECT u.id, u.email, 'woo__bulk', 'bulk', 'ok', now(), 1, 'mcp', gen_random_uuid()
       FROM users u, generate_series(1, 2500) WHERE u.email LIKE 'bulk%'`,
    );
    for (let i = 0; i < 300; i++) await addRow(rare, 'rare@example.test', { tool: `rare${i}` });
    // The newest rows belong to the others, so a walk over the primary key has to pass all of them.
    await pool.query(
      `INSERT INTO audit_log (user_id, user_email, requested_name, tool, outcome, finished_at, duration_ms, via, request_id)
       SELECT u.id, u.email, 'woo__bulk', 'bulk', 'ok', now(), 1, 'mcp', gen_random_uuid()
       FROM users u, generate_series(1, 100) WHERE u.email LIKE 'bulk%'`,
    );
    await pool.query('ANALYZE audit_log');
    const rows = (await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    assert.ok(rows >= 100000, `only ${rows} rows`);
    const explain = async (text: string, values: unknown[]) => (await pool.query(`EXPLAIN ${text}`, values)).rows.map((row) => row['QUERY PLAN']).join(' | ');
    const member = await explain('SELECT id FROM audit_log WHERE user_id = $1 AND id < 100000000 ORDER BY id DESC LIMIT 51', [rare]);
    assert.match(member, /audit_log_user_id_idx/, member);
    assert.doesNotMatch(member, /Sort/, member);
    // The admin query without a filter needs no new index: the primary key serves it.
    const admin = await explain('SELECT id FROM audit_log WHERE id < 100000000 ORDER BY id DESC LIMIT 51', []);
    assert.match(admin, /audit_log_pkey/, admin);
  });
});
