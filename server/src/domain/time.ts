/**
 * Timestamp handling.
 *
 * Sim Companies exports ISO-8601 with SIX fractional digits and an explicit
 * offset, e.g. `2026-01-02T03:04:05.123456+00:00`. JavaScript's Date only holds
 * milliseconds, so parsing through Date silently truncates the last three
 * digits. Two rows 40 microseconds apart would collapse onto the same instant.
 *
 * Everything here therefore works in MICROSECONDS since the Unix epoch, parsed
 * from the string by hand. The original string is always stored verbatim
 * alongside the integer so nothing about the export is lost.
 */

/** `2026-01-02T03:04:05.123456+00:00` → components. Fraction may be 0-9 digits. */
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

export const MICROS_PER_MS = 1000;
export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_DAY = 86_400 * MICROS_PER_SECOND;

export class TimestampParseError extends Error {
  constructor(readonly input: string) {
    super(`Unrecognised timestamp format: ${JSON.stringify(input)}`);
    this.name = 'TimestampParseError';
  }
}

export interface ParsedTimestamp {
  /** The input string, untouched. This is what gets stored. */
  raw: string;
  /** Microseconds since the Unix epoch, UTC. */
  epochMicros: number;
  /** `YYYY-MM-DD` in UTC. The logical statement upsert key. */
  utcDate: string;
  /** Canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ`, for display and comparison. */
  iso: string;
}

/**
 * Parses a Sim Companies timestamp.
 *
 * A missing offset is treated as UTC. Every timestamp observed in the reference
 * exports carries `+00:00`, but tolerating a bare local-looking timestamp costs
 * nothing and avoids failing a whole import over a format tweak.
 */
export function parseTimestamp(input: string): ParsedTimestamp {
  const trimmed = input.trim();
  const match = ISO_PATTERN.exec(trimmed);
  if (!match) throw new TimestampParseError(input);

  const [, y, mo, d, h, mi, s, frac = '', offset = 'Z'] = match;

  // Date.UTC gives millisecond resolution; the sub-millisecond remainder is
  // recovered from the fraction string separately.
  const wholeSeconds = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  if (Number.isNaN(wholeSeconds)) throw new TimestampParseError(input);

  // Right-pad the fraction to exactly 6 digits, truncating anything finer.
  // Truncation rather than rounding: a timestamp must never move forward past
  // a boundary it did not actually cross.
  const micros = Number(frac.padEnd(6, '0').slice(0, 6));

  const offsetMicros = parseOffsetMinutes(offset) * 60 * MICROS_PER_SECOND;
  const epochMicros = wholeSeconds * MICROS_PER_MS + micros - offsetMicros;

  return {
    raw: input,
    epochMicros,
    utcDate: formatUtcDate(epochMicros),
    iso: formatIso(epochMicros),
  };
}

/** Returns null instead of throwing. For validation paths that report rather than abort. */
export function tryParseTimestamp(input: string): ParsedTimestamp | null {
  try {
    return parseTimestamp(input);
  } catch {
    return null;
  }
}

function parseOffsetMinutes(offset: string): number {
  if (offset === 'Z' || offset === 'z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  const body = offset.slice(1).replace(':', '');
  const hours = Number(body.slice(0, 2));
  const minutes = Number(body.slice(2, 4));
  return sign * (hours * 60 + minutes);
}

/** `YYYY-MM-DD` for a microsecond epoch, in UTC. */
export function formatUtcDate(epochMicros: number): string {
  return new Date(Math.floor(epochMicros / MICROS_PER_MS)).toISOString().slice(0, 10);
}

/** Canonical UTC string preserving all six fractional digits. */
export function formatIso(epochMicros: number): string {
  const millis = Math.floor(epochMicros / MICROS_PER_MS);
  // Modulo on a negative numerator would go the wrong way; epochs here are
  // always positive, but the floor pairing keeps it correct regardless.
  const remainder = epochMicros - millis * MICROS_PER_MS;
  const base = new Date(millis).toISOString(); // ...THH:MM:SS.mmmZ
  return `${base.slice(0, 23)}${String(remainder).padStart(3, '0')}Z`;
}

/** Start-of-day in UTC, as a microsecond epoch. Used by calendar-day grouping. */
export function startOfUtcDay(epochMicros: number): number {
  return Math.floor(epochMicros / MICROS_PER_DAY) * MICROS_PER_DAY;
}

/** Converts a `YYYY-MM-DD` date to the microsecond epoch of its UTC midnight. */
export function utcDateToMicros(date: string): number {
  const parsed = parseTimestamp(`${date}T00:00:00.000000Z`);
  return parsed.epochMicros;
}

/** Current instant as an ISO string with millisecond precision. For audit columns. */
export function nowIso(): string {
  return new Date().toISOString();
}
