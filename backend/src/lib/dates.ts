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
