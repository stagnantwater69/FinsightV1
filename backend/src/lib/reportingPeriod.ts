import { z } from "zod";
import { ApiError } from "../middleware/error.middleware";
import { utcAddDays, utcDateKey, utcDaysInMonth, utcEndOfDay, utcIsoWeekday } from "./dates";

/**
 * The period a date-dependent figure is computed over, as the owner chose it.
 *
 * ONE RESOLVER FOR EVERY SCREEN. The Dashboard, Expense Insights and Spending
 * Impact each used to build their own window from `periodDays`, and each
 * window was a rolling lookback ending today. That made "This month" on the
 * 20th cover 22 Jul-20 Aug, and made a calendar month impossible to ask for:
 * the 30 days before 30 September are not August. Every endpoint now resolves
 * the same selection here, so two screens showing "September 2026" cannot be
 * looking at different days.
 *
 *   week   Monday to Sunday of the business's current week.
 *   month  The whole calendar month named by `month` (YYYY-MM).
 *   all    No date bound at all. "Every record" is not a long window; a large
 *          one would start excluding history the day a business outlived it.
 *   rolling The legacy `periodDays` window, kept so the mobile client and any
 *          other caller that still sends `periodDays` sees no change.
 *
 * Record dates are date-only values stored at UTC midnight, so every boundary
 * here is a UTC-midnight day (see lib/dates.ts). "Today" is always the
 * business's own calendar day, resolved by the caller.
 */
export type PeriodSelection =
  | { kind: "week" }
  | { kind: "month"; month: string }
  | { kind: "all" }
  | { kind: "rolling"; days: number; endDate?: Date };

/** An inclusive span of calendar days. */
export interface DateWindow {
  start: Date;
  end: Date;
}

export interface ReportingWindow {
  kind: PeriodSelection["kind"];
  /** YYYY-MM when the selection is a month, otherwise null. */
  month: string | null;
  /** First day covered, or null when there is no lower bound (all time). */
  start: Date | null;
  /** Last day covered, or null when there is no upper bound (all time). */
  end: Date | null;
  /** Calendar days covered, or null for all time. */
  days: number | null;
  /**
   * Days of the window that have already happened. Equal to `days` for a
   * finished period; smaller while the current week or month is in progress.
   */
  elapsedDays: number | null;
  /**
   * The span a change is measured against, or null when there is none.
   *
   * For a period still in progress this is the SAME NUMBER OF DAYS at the start
   * of the previous period (1-24 Aug against 1-24 Sep), not the whole previous
   * period: comparing four days of this week with seven days of last week
   * reports a fall in spending that is only the calendar.
   */
  previous: DateWindow | null;
}

export const MONTH_KEY_PATTERN = /^(19|2\d)\d{2}-(0[1-9]|1[0-2])$/;

/** Query fields every period-aware endpoint accepts, beside its legacy `periodDays`. */
export const periodQueryFields = {
  period: z.enum(["week", "month", "all"]).optional(),
  month: z.string().regex(MONTH_KEY_PATTERN, "month must be YYYY-MM").optional(),
};

/** Midnight UTC on the 1st of a YYYY-MM key. */
function monthStartOf(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1, 1));
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function clampElapsed(start: Date, end: Date, today: Date): number {
  if (today < start) return 0;
  if (today > end) return daysBetween(start, end);
  return daysBetween(start, today);
}

/**
 * The window a selection covers, given the business's own "today".
 *
 * Pure, so the arithmetic is unit-tested without a database.
 */
export function resolveReportingWindow(selection: PeriodSelection, today: Date): ReportingWindow {
  switch (selection.kind) {
    case "all":
      return { kind: "all", month: null, start: null, end: null, days: null, elapsedDays: null, previous: null };

    case "week": {
      const start = utcAddDays(today, -(utcIsoWeekday(today) - 1));
      const end = utcAddDays(start, 6);
      const elapsed = clampElapsed(start, end, today);
      return {
        kind: "week",
        month: null,
        start,
        end,
        days: 7,
        elapsedDays: elapsed,
        previous: { start: utcAddDays(start, -7), end: utcAddDays(start, -7 + Math.max(elapsed, 1) - 1) },
      };
    }

    case "month": {
      if (!MONTH_KEY_PATTERN.test(selection.month)) {
        throw new ApiError(400, "month must be YYYY-MM");
      }
      const start = monthStartOf(selection.month);
      const days = utcDaysInMonth(start);
      const end = utcAddDays(start, days - 1);
      const elapsed = clampElapsed(start, end, today);
      const previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
      const previousDays = utcDaysInMonth(previousStart);
      // In progress: the same days of last month. Finished or ahead: all of it.
      const inProgress = elapsed > 0 && elapsed < days;
      const previousLength = inProgress ? Math.min(elapsed, previousDays) : previousDays;
      return {
        kind: "month",
        month: selection.month,
        start,
        end,
        days,
        elapsedDays: elapsed,
        previous: { start: previousStart, end: utcAddDays(previousStart, previousLength - 1) },
      };
    }

    case "rolling": {
      const end = selection.endDate ?? today;
      const start = utcAddDays(end, -(selection.days - 1));
      const previousEnd = utcAddDays(start, -1);
      return {
        kind: "rolling",
        month: null,
        start,
        end,
        days: selection.days,
        elapsedDays: selection.days,
        previous: { start: utcAddDays(previousEnd, -(selection.days - 1)), end: previousEnd },
      };
    }
  }
}

/**
 * A Prisma `date` filter for the window, never reaching past `latest`.
 *
 * `latest` is the business's today. A week or month still in progress ends
 * after it, and all time has no end at all, so without the cap a record dated
 * in the future counted in this week's total, this month's comparison and the
 * all-time figures. Those records are invalid (see lib/transactionDate.ts) and
 * the owner is asked to correct them; until then they count nowhere.
 *
 * The upper bound is the END of the last day: record dates sit at 00:00:00Z,
 * and an `lte: midnight` bound excluded every record on the last day whenever
 * a server was not running in UTC.
 */
export function windowDateFilter(
  window: { start: Date | null; end: Date | null },
  latest: Date,
): { gte?: Date; lte: Date } {
  const end = window.end && window.end < latest ? window.end : latest;
  return {
    ...(window.start ? { gte: window.start } : {}),
    lte: utcEndOfDay(end),
  };
}

/**
 * The selection a request made.
 *
 * `period` wins when it is present; otherwise the legacy `periodDays`
 * (with `0` meaning all time, the Dashboard's old sentinel) is honoured as a
 * rolling window, so older clients keep exactly the figures they had.
 */
export function selectionFromQuery(query: {
  period?: "week" | "month" | "all";
  month?: string;
  periodDays?: number;
  endDate?: Date;
}, defaultDays = 30): PeriodSelection {
  if (query.period === "week") return { kind: "week" };
  if (query.period === "all") return { kind: "all" };
  if (query.period === "month") {
    if (!query.month) throw new ApiError(400, "month is required when period is month");
    return { kind: "month", month: query.month };
  }
  const days = query.periodDays ?? defaultDays;
  if (days === 0) return { kind: "all" };
  return { kind: "rolling", days, ...(query.endDate ? { endDate: query.endDate } : {}) };
}

/** The window as it travels in a response: date keys, never Date objects the client must re-parse. */
export function describeWindow(window: ReportingWindow) {
  return {
    kind: window.kind,
    month: window.month,
    start: window.start ? utcDateKey(window.start) : null,
    end: window.end ? utcDateKey(window.end) : null,
    days: window.days,
    elapsedDays: window.elapsedDays,
    previous: window.previous
      ? { start: utcDateKey(window.previous.start), end: utcDateKey(window.previous.end) }
      : null,
  };
}
