import { utcAddDays, utcToday } from "./dates";

// Calendar-date parsing for CSV imports, built entirely on Date.UTC.
//
// WHY THE STRING Date CONSTRUCTOR IS BANNED HERE. `new Date("01/05/2026")`
// does three wrong things at once: it guesses the convention (always
// month-first, so a day-first file silently swaps day and month whenever the
// day is ≤ 12), it parses in SERVER-LOCAL time (on a UTC+8 host — the target
// market — `.toISOString().slice(0, 10)` then lands the record one day
// early), and it "helpfully" rolls impossible dates over (Feb 31 becomes
// Mar 3 instead of an error). lib/dates.ts documents the local-time half of
// this failure class; this module exists so the import path can never hit
// any of the three.
//
// Every accepted date is therefore built with Date.UTC from explicit
// components, validated as a REAL calendar date by round-tripping the
// components, and bounded to a plausible business range.

export type CsvDateFormat = "iso" | "dmy" | "mdy" | "month-name";

/**
 * Plausibility bounds.
 *
 * A typo like "31/12/0226" or "2026-01-05" read under the wrong column both
 * parse as structurally valid dates — the bounds are what catch a figure that
 * cannot be a record in a small business's books. The future bound allows a
 * year ahead (post-dated cheques, scheduled bills) and no more.
 */
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);

function maxPlausibleMs(): number {
  return utcAddDays(utcToday(), 366).getTime();
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

// Year first is unambiguous, so ISO is accepted with either separator.
const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
// Two small numbers and a 4-digit year: the shape that NEEDS a convention.
// Two-digit years are deliberately not accepted — "05/01/26" is ambiguous
// three ways instead of two, and no explicit format choice can rescue it.
const NUMERIC_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
// "5 Jan 2026", "05-January-2026"
const DAY_FIRST_NAME_RE = /^(\d{1,2})[ -]([A-Za-z]+),?[ -](\d{4})$/;
// "Jan 5 2026", "January 5, 2026"
const NAME_FIRST_RE = /^([A-Za-z]+)[ -](\d{1,2}),?[ -]?(\d{4})$/;

/**
 * Builds YYYY-MM-DD from explicit components, or null.
 *
 * The round-trip check is the impossible-date guard: Date.UTC(2026, 1, 31)
 * happily returns March 3rd, so a result whose components differ from the
 * inputs means the inputs were never a real day.
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
 * Parses one raw CSV cell under an explicit convention. Returns the ISO
 * YYYY-MM-DD string (safe to hand to `new Date(...)`, which parses THAT
 * format as UTC), or null when the cell is not a valid, plausible date.
 *
 * ISO input is accepted under EVERY format, deliberately: the row-correction
 * panel's date input emits ISO regardless of what convention the file used,
 * and ISO is the one shape that cannot be misread.
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

  // month-name
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

/**
 * Whether a cell is date-shaped at all — used to find the date column in a
 * preview, where no mapping exists yet. Structure only; a column of dates
 * with one typo is still a date column.
 */
export function looksLikeDate(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (ISO_RE.test(value) || NUMERIC_RE.test(value)) return true;
  return parseCsvDate(value, "month-name") !== null;
}

export interface DateFormatDetection {
  format: CsvDateFormat;
  /**
   * True when the samples cannot distinguish day-first from month-first —
   * every numeric date fits both readings. An ambiguous file must not be
   * imported on a guess: half the rows landing months away is exactly the
   * failure this flag forces the owner to rule out.
   */
  ambiguous: boolean;
}

/**
 * Infers the file's date convention from sampled cells.
 *
 * Junk cells are ignored rather than flipping the answer — a dmy file with
 * one "N/A" is still a dmy file, and the bad row will be skipped with its own
 * reason at validation.
 */
export function detectDateFormat(samples: string[]): DateFormatDetection {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  const numeric = values.filter((v) => NUMERIC_RE.test(v));

  if (numeric.length > 0) {
    const dmyFitsAll = numeric.every((v) => parseCsvDate(v, "dmy") !== null);
    const mdyFitsAll = numeric.every((v) => parseCsvDate(v, "mdy") !== null);
    if (dmyFitsAll && mdyFitsAll) return { format: "dmy", ambiguous: true };
    if (dmyFitsAll) return { format: "dmy", ambiguous: false };
    if (mdyFitsAll) return { format: "mdy", ambiguous: false };
    // Contradictory — some rows only read day-first, others only month-first.
    // No single convention imports this file correctly, so it is treated as
    // ambiguous and the owner must state one; the losing rows then skip
    // VISIBLY instead of importing months off.
    return { format: "dmy", ambiguous: true };
  }

  const monthNamed = values.filter((v) => !ISO_RE.test(v) && parseCsvDate(v, "month-name") !== null);
  if (monthNamed.length > 0 && values.every((v) => ISO_RE.test(v) || parseCsvDate(v, "month-name") !== null)) {
    return { format: "month-name", ambiguous: false };
  }

  return { format: "iso", ambiguous: false };
}

export interface AmbiguousDateExample {
  raw: string;
  dmyIso: string;
  mdyIso: string;
}

/**
 * The first sample that reads validly BOTH ways, with both readings spelled
 * out — so the rejection can say "05/01/2026 could be 2026-01-05 or
 * 2026-05-01" instead of just "ambiguous".
 */
export function ambiguousDateExample(samples: string[]): AmbiguousDateExample | null {
  for (const sample of samples) {
    const value = sample.trim();
    if (!NUMERIC_RE.test(value)) continue;
    const dmyIso = parseCsvDate(value, "dmy");
    const mdyIso = parseCsvDate(value, "mdy");
    if (dmyIso && mdyIso && dmyIso !== mdyIso) return { raw: value, dmyIso, mdyIso };
  }
  return null;
}
