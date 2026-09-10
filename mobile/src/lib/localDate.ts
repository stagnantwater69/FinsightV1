/**
 * The device's own calendar day, as "YYYY-MM-DD".
 *
 * WHY THIS EXISTS: `new Date().toISOString().slice(0, 10)` is the obvious way
 * to write this and it is wrong everywhere except UTC. `toISOString` converts
 * to UTC first, so at 02:30 on 20 August in Manila (UTC+8) it returns
 * "2026-08-19" — and the record the owner is filing right now is dated
 * yesterday. That date is permanent: it moves the dashboard period, the
 * daily-spend chart, recurring-schedule matching and the recovery target, and
 * nothing on screen ever hints that the day was shifted.
 *
 * The server is scrupulous about UTC day boundaries; this is purely about
 * which day the DEVICE thinks it is when a field is defaulted for the owner.
 * Nothing here changes how dates are stored, sent or displayed — every value
 * is still the same "YYYY-MM-DD" string the API takes.
 *
 * `DateField` has always parsed and formatted in local time for exactly this
 * reason (a date built with `new Date("2026-08-01")` is UTC midnight, which
 * renders as 31 July anywhere behind UTC). This module is that helper, lifted
 * out of the component so every caller that needs "today" shares one
 * implementation instead of reaching for `toISOString` again.
 */

/** `date` as "YYYY-MM-DD" in the device's LOCAL calendar, never shifted to UTC. */
export function toLocalISODate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today, in the device's local calendar, as "YYYY-MM-DD". The default for any date field. */
export function todayISO(): string {
  return toLocalISODate(new Date());
}
