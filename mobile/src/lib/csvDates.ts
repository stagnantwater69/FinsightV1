/**
 * Calendar-date parsing for the CSV import preview, mirroring
 * backend/src/lib/csvDates.ts.
 *
 * WHY THE STRING `Date` CONSTRUCTOR IS BANNED HERE TOO. `new Date("01/05/2026")`
 * guesses month-first, parses in the DEVICE's local time (UTC+8 in this
 * market, which lands the day before), and rolls impossible dates over
 * (Feb 31 becomes Mar 3 instead of failing). The server stopped doing all
 * three; a client pre-check that still did them would flag rows the server
 * accepts and pass rows it rejects — worse than no pre-check, because the
 * owner would "fix" a row that was never wrong.
 *
 * KNOWN DRIFT, reported rather than silently patched: web's ImportCsv.tsx
 * still validates rows with `new Date(rawDate)`. That is web-frontend's to
 * fix; this file does not reach into web to do it.
 *
 * Scope: only what the row-review panel needs — "would the server accept this
 * cell as a date under the chosen convention?". Everything else about dates
 * stays on the server.
 */

export type CsvDateFormat = "iso" | "dmy" | "mdy" | "month-name";

/** The same plausibility floor the server applies. */
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);

/** One year ahead: post-dated cheques and scheduled bills, and no more. */
function maxPlausibleMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 366 * 24 * 60 * 60 * 1000;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const NUMERIC_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
const DAY_FIRST_NAME_RE = /^(\d{1,2})[ -]([A-Za-z]+),?[ -](\d{4})$/;
const NAME_FIRST_RE = /^([A-Za-z]+)[ -](\d{1,2}),?[ -]?(\d{4})$/;

/**
 * YYYY-MM-DD from explicit components, or null.
 *
 * The round-trip is the impossible-date guard: `Date.UTC(2026, 1, 31)`
 * happily returns March 3rd, so components that come back different were
 * never a real day.
 */
function calendarIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  const ms = date.getTime();
  if (ms < MIN_PLAUSIBLE_MS || ms > maxPlausibleMs()) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * One raw cell under an explicit convention, as ISO YYYY-MM-DD, or null when
 * the server would not accept it.
 *
 * ISO input is accepted under EVERY format, exactly as the server does it:
 * the correction field emits ISO whatever convention the file uses, and ISO
 * is the one shape that cannot be misread.
 */
export function parseCsvDate(raw: string, format: CsvDateFormat): string | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = ISO_RE.exec(value);
  if (iso) return calendarIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (format === "iso") return null;

  if (format === "dmy" || format === "mdy") {
    const m = NUMERIC_RE.exec(value);
    if (!m) return null;
    const [, first, second, year] = m;
    return format === "dmy"
      ? calendarIso(Number(year), Number(second), Number(first))
      : calendarIso(Number(year), Number(first), Number(second));
  }

  const dayFirst = DAY_FIRST_NAME_RE.exec(value);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.toLowerCase()];
    return month ? calendarIso(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }
  const nameFirst = NAME_FIRST_RE.exec(value);
  if (nameFirst) {
    const month = MONTHS[nameFirst[1]!.toLowerCase()];
    return month ? calendarIso(Number(nameFirst[3]), month, Number(nameFirst[2])) : null;
  }
  return null;
}

/** How the owner is asked about an ambiguous file. `month-name` is only ever detected. */
export type ChosenDateFormat = Exclude<CsvDateFormat, "month-name">;

export const DATE_FORMAT_LABELS: Record<ChosenDateFormat, string> = {
  iso: "Year first — 2026-01-05",
  dmy: "Day first — 05/01/2026 is 5 January",
  mdy: "Month first — 05/01/2026 is 1 May",
};
