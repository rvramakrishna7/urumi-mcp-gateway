import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { convertCents, formatCents, formatRatio, invert, ONE, ratioFromNumber, toCents } from '../src/money.ts';

describe('toCents', () => {
  test('accepts decimal strings and numbers with at most two decimals', () => {
    assert.equal(toCents('12.5'), 1250n);
    assert.equal(toCents(12.5), 1250n);
    assert.equal(toCents('0.01'), 1n);
    assert.equal(toCents('1250'), 125000n);
    assert.equal(toCents(0), 0n);
    assert.equal(toCents('999999999999.99'), 99_999_999_999_999n);
  });

  test('rejects everything else', () => {
    for (const value of ['-1', '+1', '1e3', '1,000', '1.234', '', ' 1', '1 ', '.5', '5.', 'abc', '1_000', '0x10', String.fromCharCode(0x661), null, undefined, {}, [], true]) {
      assert.equal(toCents(value), null, String(value));
    }
    assert.equal(toCents(-5), null);
    assert.equal(toCents(NaN), null);
    assert.equal(toCents(Infinity), null);
    assert.equal(toCents(1e21), null);
    assert.equal(toCents(0.1 + 0.2), null, 'a float with a long tail is not a money amount');
    assert.equal(toCents('1000000000000'), null, '13 digits before the point');
  });

  test('the sum of 0.1 and 0.2 is exactly 0.30', () => {
    assert.equal(formatCents((toCents('0.1') ?? 0n) + (toCents('0.2') ?? 0n)), '0.30');
  });
});

describe('formatCents', () => {
  test('always two decimals', () => {
    assert.equal(formatCents(0n), '0.00');
    assert.equal(formatCents(5n), '0.05');
    assert.equal(formatCents(1250n), '12.50');
    assert.equal(formatCents(99_999_999_999_999n), '999999999999.99');
  });
});

describe('ratioFromNumber', () => {
  test('is exact for the numbers of the rate service', () => {
    assert.deepEqual(ratioFromNumber(106.45), { num: 10645n, den: 100n });
    assert.deepEqual(ratioFromNumber(0.00939), { num: 939n, den: 100000n });
    assert.deepEqual(ratioFromNumber(1), { num: 1n, den: 1n });
    assert.deepEqual(ratioFromNumber(1.0), { num: 1n, den: 1n });
    assert.deepEqual(ratioFromNumber(1e-7), { num: 1n, den: 10_000_000n });
  });

  test('rejects values that are not a usable rate', () => {
    for (const value of [0, -1, -0.5, NaN, Infinity, -Infinity, 1e-10, 1e21, 2e9, '5', null, undefined, {}, 5n]) {
      assert.equal(ratioFromNumber(value), null, String(value));
    }
  });

  test('accepts the edges of the sanity bound', () => {
    assert.notEqual(ratioFromNumber(1e-9), null);
    assert.notEqual(ratioFromNumber(1e9), null);
  });
});

describe('convertCents', () => {
  test('rounds half up to whole cents', () => {
    const tenth = { num: 1n, den: 10n };
    assert.equal(convertCents(5n, tenth), 1n, '0.5 cent rounds up');
    assert.equal(convertCents(4n, tenth), 0n, '0.4 cent rounds down');
    assert.equal(convertCents(15n, tenth), 2n, '1.5 cents rounds up');
  });

  test('is exact for a large amount: 250000.00 INR at 1/106.45', () => {
    const rate = invert({ num: 10645n, den: 100n });
    assert.equal(formatCents(convertCents(25_000_000n, rate)), '2348.52');
  });

  test('the rate 1 changes nothing and a tiny amount can round to zero', () => {
    assert.equal(convertCents(123_456n, ONE), 123_456n);
    assert.equal(formatCents(convertCents(1n, { num: 939n, den: 100_000n })), '0.00');
  });
});

describe('formatRatio', () => {
  test('keeps up to 8 significant digits and drops trailing zeros', () => {
    assert.equal(formatRatio({ num: 10645n, den: 100n }), '106.45');
    assert.equal(formatRatio({ num: 1n, den: 1n }), '1');
    assert.equal(formatRatio({ num: 1n, den: 3n }), '0.33333333');
    assert.equal(formatRatio({ num: 2n, den: 3n }), '0.66666667');
    assert.equal(formatRatio({ num: 939n, den: 100_000n }), '0.00939');
    assert.equal(formatRatio(invert({ num: 10645n, den: 100n })), '0.0093940817');
  });

  test('a large ratio keeps its magnitude', () => {
    assert.equal(formatRatio({ num: 123_456_789n, den: 1n }), '123456790');
    assert.equal(formatRatio({ num: 2_000_000_000n, den: 1n }), '2000000000');
  });

  test('rounding can carry into a new digit', () => {
    assert.equal(formatRatio({ num: 999_999_999n, den: 1_000_000_000n }), '1');
  });
});
