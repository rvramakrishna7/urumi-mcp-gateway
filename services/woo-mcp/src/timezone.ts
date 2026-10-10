// Helpers for "today" in the store's timezone. A store day is not a UTC day, and on a daylight saving
// change it is 23 or 25 hours long, so the bounds are computed from the timezone rules in Intl.

export interface DayBounds {
  // First instant of the day (inclusive) and first instant of the next day (exclusive).
  start: Date;
  end: Date;
}

// A name from the IANA database such as Asia/Kolkata, or UTC. Offset forms such as +05:30 are rejected.
export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// The calendar day, as YYYY-MM-DD, that the instant falls on in the given timezone.
export function localDay(now: Date, timeZone: string): string {
  const { year, month, day } = wallClock(now.getTime(), timeZone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

// The UTC instants that bound the store day `day` (YYYY-MM-DD) in the given timezone.
// A zone whose daylight saving change skips local midnight is not handled specially.
export function dayBounds(day: string, timeZone: string): DayBounds {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const date = Number(match?.[3]);
  const check = new Date(Date.UTC(year, month - 1, date));
  if (!match || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new RangeError('day must be a valid date in the form YYYY-MM-DD');
  }
  return {
    start: new Date(localMidnight(year, month, date, timeZone)),
    end: new Date(localMidnight(year, month, date + 1, timeZone)),
  };
}

// The `after` and `before` values for the WooCommerce query (with dates_are_gmt=true): the day bounds
// widened by one second on each side, as UTC without a zone suffix. The widening makes sure that the
// query never drops an order at the edge of the day because of rounding or inclusive and exclusive
// comparison. The exact answer comes from isInDay.
export function queryWindow(bounds: DayBounds): { after: string; before: string } {
  return { after: widenedAfter(bounds.start), before: widenedBefore(bounds.end) };
}

// One side of the window, for a query that has only a start or only an end.
export function widenedAfter(start: Date): string {
  return formatWooGmt(new Date(start.getTime() - 1000));
}

export function widenedBefore(end: Date): string {
  return formatWooGmt(new Date(end.getTime() + 1000));
}

// WooCommerce returns date_created_gmt as 2026-10-09T12:34:56 with no zone suffix. The value is UTC.
export function parseWooGmt(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const instant = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  // Date.UTC rolls an out-of-range field over (month 13 becomes January), so compare against the input.
  return formatWooGmt(instant) === value ? instant : null;
}

// The exact filter on date_created_gmt: start <= value < end. An unparseable value is not in the day.
export function isInDay(dateCreatedGmt: string, bounds: DayBounds): boolean {
  const instant = parseWooGmt(dateCreatedGmt);
  return instant !== null && instant >= bounds.start && instant < bounds.end;
}

function formatWooGmt(instant: Date): string {
  return instant.toISOString().slice(0, 19);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// The wall clock reading of an instant in a timezone.
function wallClock(instantMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

// Milliseconds that the timezone is ahead of UTC at the given instant.
function offsetMs(instantMs: number, timeZone: string): number {
  const { year, month, day, hour, minute, second } = wallClock(instantMs, timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(instantMs / 1000) * 1000;
}

// The instant at which the wall clock of the timezone reads 00:00:00 on the given date. `date` may run
// past the end of the month, because Date.UTC normalises it. The offset is read at a first guess and
// read again at the corrected instant, which fixes the case where a daylight saving change lies between.
function localMidnight(year: number, month: number, date: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, date);
  const candidate = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(candidate, timeZone);
}
