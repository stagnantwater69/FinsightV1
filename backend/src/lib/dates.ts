// Day-boundary helpers, all in UTC.
//
// WHY UTC AND NOT LOCAL TIME: expense/sales dates are date-only values.
// The API takes "2026-07-25", and Prisma stores it as the instant
// 2026-07-25T00:00:00.000Z. There is no time-of-day component and no
// timezone attached — "the 25th" is just "the 25th".
//
// So a query boundary must be built the same way. Computing it with local
// getters silently breaks whenever the server's timezone isn't UTC. On a
// UTC+8 server (the target market — Philippine small businesses), local
// midnight on the 25th is 2026-07-24T16:00:00Z, which sorts BEFORE the
// 25th's stored value: every record dated today disappeared from the
// dashboard and from expense-behaviour trends. On a UTC-5 server the same
// mistake pulls in tomorrow's records instead.
//
// Rule for this codebase: never use getDate()/getMonth()/setHours() on a
// record date or on a boundary derived from one. Use these helpers.

/** Midnight UTC on the day `d` falls in. */
export function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Midnight UTC today — the canonical "today" for all record queries. */
export function utcToday(): Date {
  return utcStartOfDay(new Date());
}

/**
 * The last representable instant of the day `d` falls in. Use as an
 * inclusive upper bound so a record stored at exactly midnight is included.
 */
export function utcEndOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/**
 * "Today" as the business's own IANA timezone sees it right now, encoded the
 * same way every other date-only value in this codebase is encoded: a Date
 * pinned to UTC midnight of that calendar day.
 *
 * WHY THIS EXISTS ALONGSIDE utcToday(). Record dates (SalesReferenceRecord.date,
 * ExpenseRecord.date) are date-only values stored as UTC-midnight instants —
 * they encode a calendar day, not a real timezone-aware instant, and nothing
 * about them changes here. What changes is which calendar day counts as
 * "today" for month/day boundary queries. The server's own UTC clock is the
 * wrong clock for that: a Manila business (UTC+8) has already turned over to
 * its next local calendar day for roughly 16:00-23:59 UTC, and utcToday()
 * would still report the previous day for that whole window.
 *
 * Resolved with Intl rather than a fixed offset so this is correct for any
 * IANA zone (including ones with daylight saving), not just Manila's fixed
 * +08:00 — see docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.1.
 */
export function resolveBusinessToday(timezone: string): Date {
  const now = new Date();
  // en-CA formats as YYYY-MM-DD directly, so no separate re-ordering step is
  // needed between the formatter's output and the UTC-midnight encoding below.
  const localDateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = localDateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

export function utcAddDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** Midnight UTC on the 1st of the month `d` falls in. */
export function utcStartOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Number of days in the month `d` falls in. */
export function utcDaysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Day of the month (1-31) for `d`, read in UTC. */
export function utcDayOfMonth(d: Date): number {
  return d.getUTCDate();
}

/** YYYY-MM-DD key for grouping records by day. */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM key for grouping records by calendar month. */
export function utcMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/**
 * ISO weekday for `d`, read in UTC: 1=Monday ... 7=Sunday. This is the
 * convention `BusinessOperatingDay.weekday` uses (RECOVERY-TARGET-IMPROVEMENT-PLAN.md
 * §7.2) — `getUTCDay()` returns 0=Sunday..6=Saturday, so it is remapped here
 * rather than at every call site.
 */
export function utcIsoWeekday(d: Date): number {
  const jsDay = d.getUTCDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 7 : jsDay;
}
