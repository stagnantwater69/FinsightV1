/**
 * Calendar dates, in the owner's timezone.
 *
 * WHY THIS FILE EXISTS (QA register FUN-005).
 *
 * Every "today" default in the web client used to be
 * `new Date().toISOString().slice(0, 10)`. `toISOString()` is UTC, and FinSight's
 * owners are in Manila (UTC+8). Between midnight and 8 a.m. local, UTC is still
 * on yesterday's date — so an owner opening "Add expense" at 02:30 on 20 August
 * got a form pre-filled with `2026-08-19` and, unless they noticed, filed the
 * expense a day early. That date is then permanent: it moves the record in and
 * out of the dashboard period, shifts the daily-spend chart, changes which
 * recurring schedule it matches, and lands in the wrong day of the recovery
 * target.
 *
 * SCOPE. This changes only how a DEFAULT is computed. Storage, transport and
 * display are untouched: dates still go to the server as `YYYY-MM-DD`, are
 * still stored as calendar dates, and every display path still formats with
 * `timeZone: "UTC"` so a stored calendar date is never re-shifted on the way
 * out. `backend/src/lib/dates.ts` is already correct and is not involved.
 *
 * WHY LOCAL GETTERS. `getFullYear`/`getMonth`/`getDate` read the calendar in
 * the environment's own zone, which in a browser is the owner's zone — the
 * same thing `Intl.DateTimeFormat("en-CA")` resolves to, without the
 * formatter's cost or its locale-numbering edge cases. Pass `timeZone` when a
 * caller needs a zone other than the local one.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A `Date` as `YYYY-MM-DD` in the local calendar — what `<input type="date">`
 * binds to.
 *
 * @param date the instant to read; defaults to now.
 * @param timeZone an IANA zone to read the calendar in, instead of the
 *        environment's own. Only needed when the owner's zone is known to
 *        differ from the device's.
 */
export function toLocalIsoDate(date: Date = new Date(), timeZone?: string): string {
  if (timeZone) {
    // "en-CA" formats as YYYY-MM-DD, which is exactly the shape wanted.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today as `YYYY-MM-DD` in the owner's own calendar. */
export function todayIso(timeZone?: string): string {
  return toLocalIsoDate(new Date(), timeZone);
}
