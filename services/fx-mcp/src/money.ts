// Exact decimal arithmetic for currency conversion. Amounts are integers of minor units (cents) and a rate is a ratio of two
// BigInts, so nothing is summed or multiplied in floating point (decision 41).

// A positive rational number, num / den.
export interface Ratio {
  num: bigint;
  den: bigint;
}

// "12.5" or 12.5 to 1250n cents. At most 12 digits before the point and two decimals, no sign, no exponent. Returns null for anything else.
export function toCents(value: unknown): bigint | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return null;
  }
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const units = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return units * 100n + BigInt(fraction);
}

export function formatCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

// A positive decimal number from the service, for example 106.45, 0.00939 or 1e-7, as an exact ratio. Returns null for a value
// that is not finite, not positive, or outside 1e-9 .. 1e9 (a sanity bound, not a market rule).
export function ratioFromNumber(value: unknown): Ratio | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return null;
  const digits = `${match[1]}${match[2] ?? ''}`;
  const exponent = Number(match[3] ?? '0') - (match[2] ?? '').length;
  let num = BigInt(digits);
  let den = 1n;
  if (exponent >= 0) num *= 10n ** BigInt(exponent);
  else den = 10n ** BigInt(-exponent);
  if (value < 1e-9 || value > 1e9) return null;
  return { num, den };
}

export const ONE: Ratio = { num: 1n, den: 1n };

export function invert(ratio: Ratio): Ratio {
  return { num: ratio.den, den: ratio.num };
}

// cents * ratio, rounded half up to whole cents.
export function convertCents(cents: bigint, rate: Ratio): bigint {
  return (cents * rate.num * 2n + rate.den) / (rate.den * 2n);
}

// The ratio as a decimal string with `significant` significant digits (rounded half up), for example 106.45 or 0.0093891.
export function formatRatio(ratio: Ratio, significant = 8): string {
  // scale so that the integer part of num*10^k/den has at least `significant` digits
  let k = 0;
  let scaled = ratio.num;
  while (scaled / ratio.den < 10n ** BigInt(significant - 1)) {
    scaled *= 10n;
    k += 1;
  }
  // scaled / den now has at least `significant` digits; cut to exactly `significant` digits, rounding half up
  let quotient = (scaled * 2n + ratio.den) / (ratio.den * 2n);
  let digits = quotient.toString();
  let decimals = k;
  while (digits.length > significant) {
    quotient = (quotient * 2n + 10n) / 20n;
    digits = quotient.toString();
    decimals -= 1;
  }
  if (decimals <= 0) return digits + '0'.repeat(-decimals);
  const padded = digits.padStart(decimals + 1, '0');
  const text = `${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`;
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
