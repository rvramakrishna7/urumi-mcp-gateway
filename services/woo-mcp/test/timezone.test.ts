import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dayBounds, isInDay, isValidTimeZone, localDay, parseWooGmt, queryWindow, widenedAfter, widenedBefore } from '../src/timezone.ts';

// The expected bounds were computed outside the code under test: a Python script that applies the offsets
// by hand from the daylight saving rules (US: second Sunday of March and first Sunday of November,
// 2026-03-08 and 2026-11-01; New Zealand: last Sunday of September, 2026-09-27). It does not use a
// timezone database.
const cases = [
  { zone: 'Asia/Kolkata', day: '2026-10-09', start: '2026-10-08T18:30:00.000Z', end: '2026-10-09T18:30:00.000Z', hours: 24 },
  { zone: 'UTC', day: '2026-10-09', start: '2026-10-09T00:00:00.000Z', end: '2026-10-10T00:00:00.000Z', hours: 24 },
  { zone: 'America/New_York', day: '2026-03-08', start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z', hours: 23 },
  { zone: 'America/New_York', day: '2026-11-01', start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z', hours: 25 },
  { zone: 'Pacific/Auckland', day: '2026-09-27', start: '2026-09-26T12:00:00.000Z', end: '2026-09-27T11:00:00.000Z', hours: 23 },
  { zone: 'Pacific/Auckland', day: '2026-09-28', start: '2026-09-27T11:00:00.000Z', end: '2026-09-28T11:00:00.000Z', hours: 24 },
];

describe('dayBounds', () => {
  for (const { zone, day, start, end, hours } of cases) {
    test(`${zone} on ${day} is ${hours} hours`, () => {
      const bounds = dayBounds(day, zone);
      assert.equal(bounds.start.toISOString(), start);
      assert.equal(bounds.end.toISOString(), end);
      assert.equal((bounds.end.getTime() - bounds.start.getTime()) / 3_600_000, hours);
    });
  }

  test('runs past the end of a month and a year', () => {
    assert.equal(dayBounds('2026-12-31', 'UTC').end.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(dayBounds('2028-02-29', 'UTC').end.toISOString(), '2028-03-01T00:00:00.000Z');
  });

  test('rejects a day that is not a real date', () => {
    for (const day of ['2026-02-30', '2026-13-01', '2026-1-1', 'today', '', '2026-10-09T00:00:00']) {
      assert.throws(() => dayBounds(day, 'UTC'), RangeError, day);
    }
  });
});

describe('localDay', () => {
  test('is the calendar day in the store timezone, not in UTC', () => {
    // 20:00 UTC on 2026-10-09 is already 01:30 on 2026-10-10 in Kolkata and still 16:00 in New York.
    const instant = new Date('2026-10-09T20:00:00Z');
    assert.equal(localDay(instant, 'UTC'), '2026-10-09');
    assert.equal(localDay(instant, 'Asia/Kolkata'), '2026-10-10');
    assert.equal(localDay(instant, 'America/New_York'), '2026-10-09');
  });

  test('changes exactly at the bounds of the store day', () => {
    const { start, end } = dayBounds('2026-10-09', 'Asia/Kolkata');
    assert.equal(localDay(new Date(start.getTime() - 1), 'Asia/Kolkata'), '2026-10-08');
    assert.equal(localDay(start, 'Asia/Kolkata'), '2026-10-09');
    assert.equal(localDay(new Date(end.getTime() - 1), 'Asia/Kolkata'), '2026-10-09');
    assert.equal(localDay(end, 'Asia/Kolkata'), '2026-10-10');
  });
});

describe('queryWindow', () => {
  test('widens the day by one second on each side, in the WooCommerce format', () => {
    const window = queryWindow(dayBounds('2026-10-09', 'Asia/Kolkata'));
    assert.deepEqual(window, { after: '2026-10-08T18:29:59', before: '2026-10-09T18:30:01' });
  });
});

describe('widenedAfter and widenedBefore', () => {
  test('widen one side by one second', () => {
    assert.equal(widenedAfter(new Date('2026-10-08T18:30:00Z')), '2026-10-08T18:29:59');
    assert.equal(widenedBefore(new Date('2026-10-09T18:30:00Z')), '2026-10-09T18:30:01');
  });
});

describe('isInDay', () => {
  const bounds = dayBounds('2026-10-09', 'Asia/Kolkata');

  test('is inclusive at the start and exclusive at the end', () => {
    assert.equal(isInDay('2026-10-08T18:29:59', bounds), false);
    assert.equal(isInDay('2026-10-08T18:30:00', bounds), true);
    assert.equal(isInDay('2026-10-09T18:29:59', bounds), true);
    assert.equal(isInDay('2026-10-09T18:30:00', bounds), false);
  });

  test('drops the orders that the widened query returns and that are outside the day', () => {
    const window = queryWindow(bounds);
    const returned = [window.after, '2026-10-08T18:30:00', '2026-10-09T10:00:00', '2026-10-09T18:30:00', window.before];
    assert.deepEqual(
      returned.filter((value) => isInDay(value, bounds)),
      ['2026-10-08T18:30:00', '2026-10-09T10:00:00'],
    );
  });

  test('treats a value that cannot be parsed as outside the day', () => {
    for (const value of ['', 'not a date', '2026-10-09', '2026-10-09T10:00:00Z', '2026-13-40T99:00:00']) {
      assert.equal(isInDay(value, bounds), false, value);
    }
  });
});

describe('parseWooGmt', () => {
  test('reads a value without a zone suffix as UTC', () => {
    assert.equal(parseWooGmt('2026-10-09T12:34:56')?.toISOString(), '2026-10-09T12:34:56.000Z');
  });

  test('returns null for a value that is malformed or out of range', () => {
    for (const value of ['', '2026-10-09', '2026-10-09T10:00:00Z', '2026-13-40T99:00:00', '2026-02-30T10:00:00', '2026-10-09T24:00:00']) {
      assert.equal(parseWooGmt(value), null, value);
    }
  });
});

describe('isValidTimeZone', () => {
  test('accepts IANA names and rejects everything else', () => {
    for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC', 'America/Argentina/Buenos_Aires']) {
      assert.equal(isValidTimeZone(zone), true, zone);
    }
    for (const zone of ['', 'Not/AZone', '+05:30', 'IST5', 'Asia/Kolkata; rm', ' UTC']) {
      assert.equal(isValidTimeZone(zone), false, zone);
    }
  });
});
