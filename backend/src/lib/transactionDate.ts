import { ApiError } from "../middleware/error.middleware";
import { resolveBusinessToday, utcAddDays, utcDateKey, utcEndOfDay } from "./dates";

/**
 * Transaction dates may not be later than the business's own today.
 *
 * A record dated tomorrow is not a plan, it is a figure that lands in a period
 * that has not happened yet: it inflates "this month", swings the comparison
 * against last month, and sits in every total until someone notices. Recurring
 * schedules and operating-day overrides are the places that legitimately hold
 * future dates; expense and sales records are not.
 *
 * "Today" is the business's calendar day (`resolveBusinessToday`), never the
 * server's UTC day. Record dates are calendar dates stored at UTC midnight, so
 * the comparison is between two YYYY-MM-DD keys and no instant is converted.
 * A Manila business at 02:00 on the 1st is on the 1st, even though UTC is
 * still on the 31st.
 */

export const FUTURE_DATE_MESSAGE = "Date can't be in the future. Choose today or an earlier date.";
export const FUTURE_DATE_CODE = "FUTURE_DATE";

/** The business's current calendar day as YYYY-MM-DD. */
export function businessTodayKey(timezone: string, now: Date = new Date()): string {
  return utcDateKey(resolveBusinessToday(timezone, now));
}

/** True when a calendar date (YYYY-MM-DD, or a UTC-midnight Date) is after `todayKey`. */
export function isAfterToday(date: Date | string, todayKey: string): boolean {
  const key = typeof date === "string" ? date.slice(0, 10) : utcDateKey(date);
  return key > todayKey;
}

/**
 * Rejects a future transaction date with the API's usual error shape. The date
 * is never moved to today on the owner's behalf: they choose the right day.
 */
export function assertNotFutureDate(date: Date | string, timezone: string, now: Date = new Date()): void {
  const todayKey = businessTodayKey(timezone, now);
  if (isAfterToday(date, todayKey)) {
    throw new ApiError(400, FUTURE_DATE_MESSAGE, {
      code: FUTURE_DATE_CODE,
      responseDetails: { field: "date", latestDate: todayKey },
    });
  }
}

/** The inclusive upper bound for "up to and including the business's today". */
export function endOfBusinessToday(timezone: string, now: Date = new Date()): Date {
  return utcEndOfDay(resolveBusinessToday(timezone, now));
}

/** The first instant that counts as future for this business. */
export function startOfBusinessTomorrow(timezone: string, now: Date = new Date()): Date {
  return utcAddDays(resolveBusinessToday(timezone, now), 1);
}
