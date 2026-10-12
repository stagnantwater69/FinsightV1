/**
 * The period filter every date-dependent screen shares: This week, a calendar
 * month the business has records in, or All time.
 *
 * The server owns the arithmetic (backend/src/lib/reportingPeriod.ts): a week
 * is Monday to Sunday of the business's own week, a month is its first to its
 * last day, and all time has no date bound. This module only names the
 * selection, turns it into query parameters, and phrases it.
 *
 * It replaces the rolling "7 days / 30 days" windows, which could not answer
 * "what did I spend in August?" — the 30 days before 30 September are not
 * August.
 *
 * Kept word-for-word with mobile/src/lib/reportingPeriod.ts: both clients ask
 * the same endpoints, and an owner checking their phone and their laptop must
 * be told the same period in the same words. mobile/tests/webParity.test.ts
 * runs the two against each other.
 */

export type PeriodSelection = { kind: "week" } | { kind: "month"; month: string } | { kind: "all" };

/** The resolved window as the server reports it (`period` on each response). */
export interface PeriodWindow {
  kind: "week" | "month" | "all" | "rolling";
  month: string | null;
  start: string | null;
  end: string | null;
  days: number | null;
  elapsedDays: number | null;
  previous: { start: string; end: string } | null;
}

export const THIS_WEEK: PeriodSelection = { kind: "week" };
export const ALL_TIME: PeriodSelection = { kind: "all" };

/** Query parameters for any period-aware endpoint. */
export function periodParams(selection: PeriodSelection): { period: "week" | "month" | "all"; month?: string } {
  return selection.kind === "month" ? { period: "month", month: selection.month } : { period: selection.kind };
}

export function samePeriod(a: PeriodSelection, b: PeriodSelection): boolean {
  return periodKey(a) === periodKey(b);
}

/** A stable string for a selection: "week", "month:2026-09", "all". */
export function periodKey(selection: PeriodSelection): string {
  return selection.kind === "month" ? `month:${selection.month}` : selection.kind;
}

/**
 * The same key for the window a response was computed for, or null when an
 * older server sent no `period` (a result that cannot be matched is never
 * called stale on that account).
 */
export function windowKey(window: PeriodWindow | null | undefined): string | null {
  if (!window || window.kind === "rolling") return null;
  return window.kind === "month" ? `month:${window.month}` : window.kind;
}

/** "2026-09" as "September 2026". UTC, so the label never slips a month west of Greenwich. */
export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The selection as a heading or a caption: "This week", "September 2026", "All time". */
export function periodLabel(selection: PeriodSelection): string {
  if (selection.kind === "week") return "This week";
  if (selection.kind === "all") return "All time";
  return monthLabel(selection.month);
}

/** The selection mid-sentence: "this week", "in September 2026", "across all records". */
export function periodPhrase(selection: PeriodSelection): string {
  if (selection.kind === "week") return "this week";
  if (selection.kind === "all") return "across all records";
  return `in ${monthLabel(selection.month)}`;
}

function shortMonth(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
}

function dayOf(iso: string): number {
  return Number(iso.slice(8, 10));
}

/** A span of days, short: "Aug 1-24", "Sep 28 to Oct 4". */
export function formatDayRange(start: string, end: string): string {
  if (start === end) return `${shortMonth(start)} ${dayOf(start)}`;
  if (start.slice(0, 7) === end.slice(0, 7)) return `${shortMonth(start)} ${dayOf(start)}-${dayOf(end)}`;
  return `${shortMonth(start)} ${dayOf(start)} to ${shortMonth(end)} ${dayOf(end)}`;
}

/**
 * What a change is measured against, as a short label.
 *
 * A finished month is compared with the whole month before it, so it is named.
 * A week or month still in progress is compared with the same days of the
 * previous one, so the days are shown instead: "vs Last month" over 1-24 Aug
 * would claim a comparison with all of August.
 */
export function previousLabel(window: PeriodWindow | null | undefined): string | null {
  const previous = window?.previous;
  if (!window || !previous) return null;
  const inProgress = window.elapsedDays !== null && window.days !== null && window.elapsedDays < window.days;
  if (window.kind === "month" && !inProgress) return monthLabel(previous.start.slice(0, 7));
  if (window.kind === "week" && !inProgress) return "Last week";
  return formatDayRange(previous.start, previous.end);
}
