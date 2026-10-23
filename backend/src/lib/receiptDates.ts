/*
 * The one rule for a numeric receipt date whose day and month could be either
 * way round ("07/06/2024"), shared by the local parser and the provider
 * adapter so both readers settle it identically.
 *
 * Philippine registers print both orders. Measured on 50 public Metro Manila
 * receipts (Wendy's, Jollibee, 7-Eleven, Mercury Drug, Robinsons, Starbucks,
 * McDonald's), every date that could only be read one way was month-first
 * (06/18/2024, 05/31/2024), while the original Cebu receipt behind the old
 * day-first default was day-first (11/07/2026 for 11 July). Neither convention
 * is safe on its own, so the scan's own upload date decides: a receipt cannot
 * be dated after it was uploaded, and is usually photographed within days.
 * The reading closest to the upload date, and not after it, wins. With no
 * upload date to compare against, day-first remains the fallback.
 *
 * The answer is still inferred, not read, so it stays flagged ambiguous and
 * the owner is asked to check the day and month. The flag only drops when the
 * upload date rules one reading out entirely.
 */

export interface NumericDateReading {
  iso: string;
  ambiguous: boolean;
}

/** A receipt printed late in the evening can be uploaded "tomorrow" in another clock. */
const UPLOAD_CLOCK_GRACE_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isoIfValid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check catches e.g. 31 February, which Date silently rolls over.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The calendar date in the Philippines at `at`, as YYYY-MM-DD. */
export function philippineDate(at: Date): string {
  return new Date(at.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/**
 * Resolves `first/second/year` as printed. A component above 12 can only be
 * the day, which settles the order. When both could be the month, the upload
 * date decides as described above.
 */
export function resolveNumericDate(
  first: number,
  second: number,
  year: number,
  referenceDate: string | null,
): NumericDateReading | null {
  if (second > 12) {
    const iso = isoIfValid(year, first, second);
    return iso ? { iso, ambiguous: false } : null;
  }
  const dayFirst = isoIfValid(year, second, first);
  if (first > 12 || first === second) return dayFirst ? { iso: dayFirst, ambiguous: false } : null;
  const monthFirst = isoIfValid(year, first, second);
  if (!dayFirst || !monthFirst) return null;
  if (referenceDate === null) return { iso: dayFirst, ambiguous: true };

  const latest = utcDay(referenceDate) + UPLOAD_CLOCK_GRACE_DAYS * DAY_MS;
  const possible = [dayFirst, monthFirst].filter((iso) => utcDay(iso) <= latest);
  if (possible.length === 0) return { iso: dayFirst, ambiguous: true };
  if (possible.length === 1) return { iso: possible[0]!, ambiguous: false };
  return { iso: utcDay(monthFirst) > utcDay(dayFirst) ? monthFirst : dayFirst, ambiguous: true };
}

const NUMERIC_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/;

/** The first numeric date in `text`, resolved by `resolveNumericDate`, with the text it came from. */
export function readNumericDate(
  text: string,
  referenceDate: string | null,
): (NumericDateReading & { sourceText: string; first: number; second: number; year: number }) | null {
  const match = text.match(NUMERIC_DATE);
  if (!match) return null;
  const [, firstRaw, secondRaw, yearRaw] = match;
  const year = yearRaw!.length === 2 ? Number(`20${yearRaw}`) : Number(yearRaw);
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const reading = resolveNumericDate(first, second, year, referenceDate);
  return reading ? { ...reading, sourceText: match[0], first, second, year } : null;
}
