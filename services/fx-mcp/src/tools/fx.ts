import { z } from 'zod';
import { FxApiError } from '../fxClient.ts';
import type { FxClient } from '../fxClient.ts';
import { convertCents, formatCents, formatRatio, invert, ratioFromNumber, toCents } from '../money.ts';
import type { Ratio } from '../money.ts';
import { ToolInputError } from './common.ts';
import type { ToolDefinition } from './common.ts';

const MAX_AMOUNTS = 100;
const MAX_CURRENCIES_SHOWN = 60;

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a three-letter ISO currency code, for example EUR');

const dateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD')
  .describe('A past day as YYYY-MM-DD. If it is missing, the latest published rates are used.');

// A real calendar day that is not later than today (UTC). Rates exist for past days only.
function assertUsableDate(date: string, now: Date): void {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ToolInputError('date is not a real calendar day. Use YYYY-MM-DD.');
  }
  if (date > now.toISOString().slice(0, 10)) {
    throw new ToolInputError('date is in the future. Rates exist for past days only.');
  }
}

interface ResolvedRate {
  date: string;
  rate: Ratio;
  basis: 'direct pair' | 'inverse pair';
}

// The rate for from -> to. The service rounds a rate to a few significant digits, so a small rate such as INR -> EUR
// (0.00939) carries a rounding error of up to half a percent. For a rate below 1 the inverse pair (EUR -> INR, 106.45) is
// asked as well, on the same day, and 1 divided by it is used: it has more significant digits. If the inverse call fails or
// answers for another day, the direct rate is used and the answer says so.
export async function resolveRate(fx: Pick<FxClient, 'getRate'>, from: string, to: string, date: string | undefined): Promise<ResolvedRate> {
  const direct = await fx.getRate(from, to, date);
  const directRatio = ratioFromNumber(direct.rate);
  if (directRatio === null) throw new FxApiError('invalid-response', 'The rate service answered with a rate outside the accepted range');
  if (direct.rate >= 1 || from === to) return { date: direct.date, rate: directRatio, basis: 'direct pair' };
  try {
    const inverse = await fx.getRate(to, from, direct.date);
    const inverseRatio = ratioFromNumber(inverse.rate);
    if (inverseRatio !== null && inverse.date === direct.date) return { date: direct.date, rate: invert(inverseRatio), basis: 'inverse pair' };
  } catch (error) {
    if (!(error instanceof FxApiError)) throw error;
  }
  return { date: direct.date, rate: directRatio, basis: 'direct pair' };
}

const listCurrenciesSchema = z.strictObject({
  search: z.string().trim().min(1).max(50).optional().describe('Text to look for in the currency code or name, for example "rupee" or "eu".'),
});

export const listCurrencies: ToolDefinition<typeof listCurrenciesSchema> = {
  name: 'list_currencies',
  title: 'List currencies',
  description:
    'Lists the currencies that have exchange rates, each with its three-letter ISO code and name. Use search to narrow the list. ' +
    'At most 60 currencies are shown; the answer gives the number of matches.',
  inputSchema: listCurrenciesSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, { fx }) => {
    const all = await fx.listCurrencies();
    const needle = args.search?.toLowerCase();
    const matches = needle === undefined ? all : all.filter((item) => item.code.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle));
    return { currencies: matches.slice(0, MAX_CURRENCIES_SHOWN), total_matching: matches.length };
  },
};

const getRateSchema = z.strictObject({
  from: currencyCode.describe('The currency to convert from, for example INR.'),
  to: currencyCode.describe('The currency to convert to, for example EUR.'),
  date: dateText.optional(),
});

export const getRate: ToolDefinition<typeof getRateSchema> = {
  name: 'get_rate',
  title: 'Get an exchange rate',
  description:
    'Gives the exchange rate for one currency pair: how much of the "to" currency one unit of the "from" currency buys. ' +
    'It uses the latest published rates, or the rates of a past day. Rates are daily reference rates, not live trading prices. ' +
    'The answer says which day the rate is for.',
  inputSchema: getRateSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, { fx, now }) => {
    if (args.date !== undefined) assertUsableDate(args.date, now());
    const resolved = await resolveRate(fx, args.from, args.to, args.date);
    return { from: args.from, to: args.to, date: resolved.date, rate: formatRatio(resolved.rate), basis: resolved.basis };
  },
};

// A money amount: a decimal string or a number with at most two decimals, no sign.
const amount = z.union([z.string(), z.number()]);

const convertAmountsSchema = z.strictObject({
  from: currencyCode.describe('The currency of the amounts, for example INR.'),
  to: currencyCode.describe('The currency to convert to, for example EUR.'),
  amounts: z
    .array(amount)
    .min(1)
    .max(MAX_AMOUNTS)
    .describe(`One to ${MAX_AMOUNTS} amounts in the "from" currency, each a number or a decimal string with at most two decimals, for example "1250.50".`),
  date: dateText.optional(),
});

export const convertAmounts: ToolDefinition<typeof convertAmountsSchema> = {
  name: 'convert_amounts',
  title: 'Convert amounts',
  description:
    'Converts a list of money amounts from one currency to another and adds them up. Use it to turn the totals of several orders into ' +
    'one total in another currency: pass every total, and use the "total" in the answer. The total is converted from the exact sum ' +
    'of the original amounts, so it can differ by a cent from the sum of the converted amounts. Uses the latest published daily rate, ' +
    'or the rate of a past day.',
  inputSchema: convertAmountsSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, { fx, now }) => {
    if (args.date !== undefined) assertUsableDate(args.date, now());
    const cents: bigint[] = [];
    args.amounts.forEach((value, index) => {
      const parsed = toCents(value);
      if (parsed === null) {
        throw new ToolInputError(`amounts[${index}] is not a money amount. Use a number or a decimal string with at most two decimals, no sign, for example "1250.50".`);
      }
      cents.push(parsed);
    });
    const resolved = await resolveRate(fx, args.from, args.to, args.date);
    const sum = cents.reduce((total, value) => total + value, 0n);
    return {
      from: args.from,
      to: args.to,
      date: resolved.date,
      rate: formatRatio(resolved.rate),
      basis: resolved.basis,
      results: cents.map((value) => ({ amount: formatCents(value), converted: formatCents(convertCents(value, resolved.rate)) })),
      total: { amount: formatCents(sum), converted: formatCents(convertCents(sum, resolved.rate)) },
    };
  },
};
