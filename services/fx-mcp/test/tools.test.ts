import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FxApiError } from '../src/fxClient.ts';
import type { CurrencyInfo, PairRate } from '../src/fxClient.ts';
import { createLogger } from '../src/logger.ts';
import { runTool, ToolInputError } from '../src/tools/common.ts';
import type { ToolDeps } from '../src/tools/common.ts';
import { convertAmounts, getRate, listCurrencies, resolveRate } from '../src/tools/fx.ts';
import { tools } from '../src/tools/index.ts';

const NOW = new Date('2026-10-16T10:00:00Z');

interface Call {
  base: string;
  quote: string;
  date: string | undefined;
}

// A fake rate service. A pair that is not in the table is "not found". `overrides` can change one answer.
function fakeFx(table: Record<string, number>, options: { inverseFails?: boolean; inverseDate?: string; currencies?: CurrencyInfo[] } = {}) {
  const calls: Call[] = [];
  const fx: ToolDeps['fx'] = {
    getRate: async (base, quote, date): Promise<PairRate> => {
      calls.push({ base, quote, date });
      const rate = table[`${base}/${quote}`];
      if (rate === undefined) throw new FxApiError('not-found', 'The rate service has no data for this request', 404);
      const isInverse = calls.length > 1;
      if (isInverse && options.inverseFails) throw new FxApiError('timeout', 'The rate service did not answer within 8000 ms');
      return { date: isInverse && options.inverseDate ? options.inverseDate : (date ?? '2026-10-16'), base, quote, rate };
    },
    listCurrencies: async () => options.currencies ?? [],
  };
  return { fx, calls };
}

const INR_EUR = { 'INR/EUR': 0.00939, 'EUR/INR': 106.45 };
const deps = (fx: ToolDeps['fx']): ToolDeps => ({ fx, now: () => NOW });

describe('resolveRate', () => {
  test('a rate of 1 or more is taken as it is, with one call', async () => {
    const { fx, calls } = fakeFx(INR_EUR);
    const resolved = await resolveRate(fx, 'EUR', 'INR', undefined);
    assert.deepEqual(resolved, { date: '2026-10-16', rate: { num: 10645n, den: 100n }, basis: 'direct pair' });
    assert.equal(calls.length, 1);
  });

  test('a rate below 1 asks the inverse pair for the same day and uses 1 divided by it', async () => {
    const { fx, calls } = fakeFx(INR_EUR);
    const resolved = await resolveRate(fx, 'INR', 'EUR', undefined);
    assert.equal(resolved.basis, 'inverse pair');
    assert.deepEqual(resolved.rate, { num: 100n, den: 10645n });
    assert.deepEqual(calls, [
      { base: 'INR', quote: 'EUR', date: undefined },
      { base: 'EUR', quote: 'INR', date: '2026-10-16' },
    ]);
  });

  test('the date of the direct answer is pinned on the inverse call', async () => {
    const { fx, calls } = fakeFx(INR_EUR);
    await resolveRate(fx, 'INR', 'EUR', '2026-10-01');
    assert.equal(calls[1]?.date, '2026-10-01');
  });

  test('if the inverse call fails, the direct rate is used and the basis says so', async () => {
    const { fx } = fakeFx(INR_EUR, { inverseFails: true });
    const resolved = await resolveRate(fx, 'INR', 'EUR', undefined);
    assert.deepEqual(resolved, { date: '2026-10-16', rate: { num: 939n, den: 100_000n }, basis: 'direct pair' });
  });

  test('if the inverse answers for another day, the direct rate is used', async () => {
    const { fx } = fakeFx(INR_EUR, { inverseDate: '2026-10-15' });
    assert.equal((await resolveRate(fx, 'INR', 'EUR', undefined)).basis, 'direct pair');
  });

  test('the same currency on both sides is rate 1 with one call', async () => {
    const { fx, calls } = fakeFx({ 'EUR/EUR': 1 });
    const resolved = await resolveRate(fx, 'EUR', 'EUR', undefined);
    assert.deepEqual(resolved.rate, { num: 1n, den: 1n });
    assert.equal(calls.length, 1);
  });

  test('a rate outside the accepted range is an invalid-response error', async () => {
    for (const rate of [1e-12, 5e9]) {
      const { fx } = fakeFx({ 'AAA/BBB': rate });
      await assert.rejects(resolveRate(fx, 'AAA', 'BBB', undefined), (error: unknown) => error instanceof FxApiError && error.kind === 'invalid-response');
    }
  });

  test('a failed direct call is passed on', async () => {
    const { fx } = fakeFx({});
    await assert.rejects(resolveRate(fx, 'INR', 'EUR', undefined), (error: unknown) => error instanceof FxApiError && error.kind === 'not-found');
  });
});

describe('convert_amounts', () => {
  const run = (args: unknown, fx: ToolDeps['fx']) => convertAmounts.handler(convertAmounts.inputSchema.parse(args), deps(fx)) as Promise<any>;

  test('converts every amount and the exact sum with the inverse-pair rate', async () => {
    const { fx } = fakeFx(INR_EUR);
    const answer = await run({ from: 'INR', to: 'EUR', amounts: ['150000.00', 100000] }, fx);
    assert.equal(answer.basis, 'inverse pair');
    assert.equal(answer.date, '2026-10-16');
    assert.equal(answer.rate, '0.0093940817');
    assert.deepEqual(answer.results, [
      { amount: '150000.00', converted: '1409.11' },
      { amount: '100000.00', converted: '939.41' },
    ]);
    assert.deepEqual(answer.total, { amount: '250000.00', converted: '2348.52' });
  });

  test('the total is converted from the exact sum, so it can differ by a cent from the sum of the converted amounts', async () => {
    const { fx } = fakeFx({ 'AAA/BBB': 1.5 });
    const answer = await run({ from: 'AAA', to: 'BBB', amounts: ['0.01', '0.01', '0.01'] }, fx);
    // each 0.01 * 1.5 = 0.015 rounds up to 0.02 (sum 0.06); the exact sum 0.03 * 1.5 = 0.045 rounds up to 0.05
    assert.deepEqual(answer.results.map((r: { converted: string }) => r.converted), ['0.02', '0.02', '0.02']);
    assert.equal(answer.total.converted, '0.05');
  });

  test('the direct rate would have given a different, less exact total (the inverse pair matters)', async () => {
    const { fx } = fakeFx(INR_EUR, { inverseFails: true });
    const answer = await run({ from: 'INR', to: 'EUR', amounts: ['250000.00'] }, fx);
    assert.equal(answer.basis, 'direct pair');
    assert.equal(answer.total.converted, '2347.50');
  });

  test('accepts lower case codes and sends upper case codes', async () => {
    const { fx, calls } = fakeFx(INR_EUR);
    await run({ from: ' inr ', to: 'eur', amounts: [10] }, fx);
    assert.equal(calls[0]?.base, 'INR');
    assert.equal(calls[0]?.quote, 'EUR');
  });

  test('a zero amount and a tiny amount are valid', async () => {
    const { fx } = fakeFx(INR_EUR);
    const answer = await run({ from: 'INR', to: 'EUR', amounts: ['0', '0.01'] }, fx);
    assert.deepEqual(answer.results, [
      { amount: '0.00', converted: '0.00' },
      { amount: '0.01', converted: '0.00' },
    ]);
  });

  test('a bad amount is an input error that names its position, and no call is made', async () => {
    for (const bad of ['-5', '1.234', '1e3', 'abc', '', '1,000', 0.1 + 0.2]) {
      const { fx, calls } = fakeFx(INR_EUR);
      await assert.rejects(
        run({ from: 'INR', to: 'EUR', amounts: ['10', bad] }, fx),
        (error: unknown) => error instanceof ToolInputError && /amounts\[1\]/.test(error.message),
        String(bad),
      );
      assert.equal(calls.length, 0);
    }
  });

  test('the schema refuses an empty list, more than 100 amounts, unknown keys and bad codes', () => {
    const parse = (args: unknown) => convertAmounts.inputSchema.safeParse(args).success;
    const ok = { from: 'INR', to: 'EUR', amounts: ['1'] };
    assert.equal(parse(ok), true);
    assert.equal(parse({ ...ok, amounts: [] }), false);
    assert.equal(parse({ ...ok, amounts: Array.from({ length: 100 }, () => '1') }), true);
    assert.equal(parse({ ...ok, amounts: Array.from({ length: 101 }, () => '1') }), false);
    assert.equal(parse({ ...ok, extra: 1 }), false);
    assert.equal(parse({ ...ok, from: 'IN' }), false);
    assert.equal(parse({ ...ok, to: 'EURO' }), false);
    assert.equal(parse({ ...ok, to: 'E/R' }), false);
    assert.equal(parse({ ...ok, to: 'E?R' }), false);
    assert.equal(parse({ ...ok, date: '2026-10-1' }), false);
    assert.equal(parse({ ...ok, amounts: [{}] }), false);
    assert.equal(parse({ ...ok, amounts: [null] }), false);
  });

  test('a date in the future or not on the calendar is refused before any call', async () => {
    for (const date of ['2026-10-17', '2030-01-01', '2026-02-30', '2026-13-01', '2026-00-10']) {
      const { fx, calls } = fakeFx(INR_EUR);
      await assert.rejects(run({ from: 'INR', to: 'EUR', amounts: ['1'], date }, fx), ToolInputError, date);
      assert.equal(calls.length, 0);
    }
  });

  test('today and a past day are accepted and the date is passed to the service', async () => {
    for (const date of ['2026-10-16', '2026-10-01']) {
      const { fx, calls } = fakeFx(INR_EUR);
      const answer = await run({ from: 'INR', to: 'EUR', amounts: ['1'], date }, fx);
      assert.equal(calls[0]?.date, date);
      assert.equal(answer.date, date);
    }
  });
});

describe('get_rate', () => {
  test('gives the rate, the day and the basis', async () => {
    const { fx } = fakeFx(INR_EUR);
    const answer = (await getRate.handler(getRate.inputSchema.parse({ from: 'EUR', to: 'INR' }), deps(fx))) as any;
    assert.deepEqual(answer, { from: 'EUR', to: 'INR', date: '2026-10-16', rate: '106.45', basis: 'direct pair' });
  });
});

describe('list_currencies', () => {
  const currencies: CurrencyInfo[] = [
    { code: 'EUR', name: 'Euro' },
    { code: 'INR', name: 'Indian Rupee' },
    { code: 'PKR', name: 'Pakistani Rupee' },
  ];

  test('without search it lists everything, with search it filters by code or name', async () => {
    const { fx } = fakeFx({}, { currencies });
    const all = (await listCurrencies.handler(listCurrencies.inputSchema.parse({}), deps(fx))) as any;
    assert.equal(all.total_matching, 3);
    const rupee = (await listCurrencies.handler(listCurrencies.inputSchema.parse({ search: 'RUPEE' }), deps(fx))) as any;
    assert.deepEqual(rupee.currencies.map((c: CurrencyInfo) => c.code), ['INR', 'PKR']);
    const byCode = (await listCurrencies.handler(listCurrencies.inputSchema.parse({ search: 'eu' }), deps(fx))) as any;
    assert.deepEqual(byCode.currencies.map((c: CurrencyInfo) => c.code), ['EUR']);
  });

  test('shows at most 60 and reports the number of matches', async () => {
    const many = Array.from({ length: 165 }, (_, i) => ({ code: 'AAA', name: `Currency ${i}` }));
    const { fx } = fakeFx({}, { currencies: many });
    const answer = (await listCurrencies.handler(listCurrencies.inputSchema.parse({}), deps(fx))) as any;
    assert.equal(answer.currencies.length, 60);
    assert.equal(answer.total_matching, 165);
  });
});

describe('runTool: failures become readable results', () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));

  test('an FxApiError becomes an error result with fixed text and no URL', async () => {
    const failing: ToolDeps = {
      fx: { getRate: async () => { throw new FxApiError('network', 'could not reach the rate service (ECONNREFUSED)'); }, listCurrencies: async () => [] },
      now: () => NOW,
    };
    const result = await runTool(getRate, getRate.inputSchema.parse({ from: 'EUR', to: 'INR' }), failing, logger);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /cannot be reached/);
    assert.doesNotMatch(result.content[0]?.text ?? '', /http|ECONNREFUSED/);
  });

  test('every kind has its own text', async () => {
    const kinds: Array<[FxApiError, RegExp]> = [
      [new FxApiError('timeout', 'x'), /did not answer in time/],
      [new FxApiError('rate-limited', 'x', 429), /limiting requests/],
      [new FxApiError('not-found', 'x', 404), /no rate for this request/],
      [new FxApiError('http', 'x', 422), /did not accept the currency code/],
      [new FxApiError('http', 'x', 503), /internal error \(status 503\)/],
      [new FxApiError('invalid-response', 'x'), /unexpected answer/],
      [new FxApiError('redirect', 'x', 302), /unexpected answer/],
    ];
    for (const [error, pattern] of kinds) {
      const failing: ToolDeps = { fx: { getRate: async () => { throw error; }, listCurrencies: async () => [] }, now: () => NOW };
      const result = await runTool(getRate, getRate.inputSchema.parse({ from: 'EUR', to: 'INR' }), failing, logger);
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? '', pattern);
    }
  });

  test('an input error is shown as it is; an unexpected error is hidden', async () => {
    const { fx } = fakeFx(INR_EUR);
    const input = await runTool(convertAmounts, convertAmounts.inputSchema.parse({ from: 'INR', to: 'EUR', amounts: ['x'] }), deps(fx), logger);
    assert.match(input.content[0]?.text ?? '', /amounts\[0\]/);
    const boom: ToolDeps = { fx: { getRate: async () => { throw new Error('secret-detail at http://internal'); }, listCurrencies: async () => [] }, now: () => NOW };
    const hidden = await runTool(getRate, getRate.inputSchema.parse({ from: 'EUR', to: 'INR' }), boom, logger);
    assert.equal(hidden.isError, true);
    assert.doesNotMatch(hidden.content[0]?.text ?? '', /secret-detail|internal/);
    assert.ok(!lines.join('\n').includes('secret-detail'), 'the message of an unexpected error was logged');
  });

  test('the log has the tool, the outcome and the duration, and never the amounts', async () => {
    const { fx } = fakeFx(INR_EUR);
    await runTool(convertAmounts, convertAmounts.inputSchema.parse({ from: 'INR', to: 'EUR', amounts: ['123456.78'] }), deps(fx), logger);
    const joined = lines.join('\n');
    assert.match(joined, /"tool":"convert_amounts"/);
    assert.match(joined, /"outcome":"ok"/);
    assert.ok(!joined.includes('123456'), 'an amount was logged');
  });
});

describe('the tool list', () => {
  test('three read-only tools, and no argument that could carry an address', () => {
    assert.deepEqual(tools.map((tool) => tool.name), ['list_currencies', 'get_rate', 'convert_amounts']);
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
      const names = Object.keys(tool.inputSchema.shape);
      for (const name of names) assert.doesNotMatch(name, /url|uri|host|path|address|endpoint|base|server|proxy/i, `${tool.name}.${name}`);
    }
  });
});
