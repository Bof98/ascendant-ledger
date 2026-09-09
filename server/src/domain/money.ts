/**
 * Monetary handling.
 *
 * Two distinct kinds of number come out of the Sim Companies exports, and
 * conflating them is the single easiest way to corrupt this application's
 * accounting. They are kept apart deliberately:
 *
 *   CASH — the Account History `Money` column and every statement column.
 *          Verified against the reference exports: always whole integers, range
 *          -8,377..12,000. Stored as INTEGER and added with ordinary integer
 *          arithmetic. No scaling, no floats, no rounding, ever.
 *
 *   ANALYTIC DECIMALS — `price`, `unit_cogs` and `quality` inside the Details
 *          JSON. These carry up to 16 decimal places because the game divides
 *          floats. They describe rates, not cash. Stored twice: the exact
 *          original string for display and audit, and a REAL used only for
 *          sorting and charting. A REAL never feeds a cash calculation.
 *
 * The `Money` column is authoritative for every cash figure. Where a rate and a
 * quantity could in principle reproduce it, `Money` still wins.
 */

export class MoneyParseError extends Error {
  constructor(readonly input: string) {
    super(`Value is not a whole SIM$ amount: ${JSON.stringify(input)}`);
    this.name = 'MoneyParseError';
  }
}

/** Accepts optional sign, digits, and thousands separators. Rejects decimals. */
const CASH_PATTERN = /^-?\d{1,3}(?:,\d{3})*$|^-?\d+$/;

/**
 * Parses a cash cell into whole SIM$.
 *
 * Rejects any fractional value rather than rounding it. If Sim Companies ever
 * starts exporting fractional cash the correct response is a loud import error
 * and a schema revision, not a silent rounding that quietly unbalances the
 * books.
 */
export function parseCash(input: string | number | null | undefined): number {
  if (input === null || input === undefined) throw new MoneyParseError(String(input));

  if (typeof input === 'number') {
    if (!Number.isInteger(input)) throw new MoneyParseError(String(input));
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === '') throw new MoneyParseError(input);

  // Accounting-style parentheses for negatives, tolerated defensively.
  const negated = /^\((.*)\)$/.exec(trimmed);
  const body = negated ? `-${negated[1]!.trim()}` : trimmed;

  const cleaned = body.replace(/^\+/, '').replace(/\s/g, '');
  if (!CASH_PATTERN.test(cleaned)) throw new MoneyParseError(input);

  const value = Number(cleaned.replace(/,/g, ''));
  if (!Number.isSafeInteger(value)) throw new MoneyParseError(input);
  return value;
}

/** Cash parse that reports rather than throws. Missing/blank cells become 0. */
export function parseCashOrDefault(
  input: string | number | null | undefined,
  fallback = 0,
): { value: number; ok: boolean } {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { value: fallback, ok: true };
  }
  try {
    return { value: parseCash(input), ok: true };
  } catch {
    return { value: fallback, ok: false };
  }
}

export interface AnalyticDecimal {
  /** Exact original representation, preserved for display and audit. */
  text: string;
  /** Float form. Sorting and charting only — never cash arithmetic. */
  real: number;
}

/**
 * Captures an analytic decimal from parsed JSON.
 *
 * The JSON has already been through `JSON.parse` by the time it reaches here, so
 * the true original digits are gone. `toPrecision(17)` then trimmed round-trips
 * an IEEE-754 double exactly, which is the closest recoverable equivalent.
 */
export function toAnalyticDecimal(value: unknown): AnalyticDecimal | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return { text: exactDoubleString(value), real: value };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const real = Number(trimmed);
    if (!Number.isFinite(real)) return null;
    return { text: trimmed, real };
  }
  return null;
}

/** Shortest string that parses back to exactly this double. */
function exactDoubleString(value: number): string {
  const short = String(value);
  if (Number(short) === value) return short;
  return value.toPrecision(17);
}

/** An integer from JSON, or null when absent or non-integral. */
export function toIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** A float from JSON, or null. Used for `quality`, which arrives as int or float. */
export function toFloatOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Sums cash safely, surfacing an overflow rather than producing a wrong total. */
export function sumCash(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('Cash total exceeded safe integer range');
  }
  return total;
}
