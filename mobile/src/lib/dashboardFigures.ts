import { formatDayRange } from "./reportingPeriod";
import type { DashboardPeriodComparison, RecurringSchedule } from "./types";

export type SummaryFigure = "sales" | "expenses" | "net";

export interface SummaryDelta {
  percent: number | null;
  amount: number;
  /** What the change is measured against: "Sep 1-7", "Aug 1 to Sep 3, 2026". */
  against: string;
  /** True when a rise is the unwelcome direction (expenses). */
  upIsBad: boolean;
}

/**
 * The previous window as a short label. The year is added once, at the end,
 * because a comparison across a year boundary is otherwise ambiguous.
 */
export function previousPeriodCaption(comparison: DashboardPeriodComparison): string {
  const start = comparison.previousStart.slice(0, 10);
  const end = comparison.previousEnd.slice(0, 10);
  if (start.slice(0, 4) === end.slice(0, 4)) return `${formatDayRange(start, end)}, ${start.slice(0, 4)}`;
  return `${formatDayRange(start, start)}, ${start.slice(0, 4)} to ${formatDayRange(end, end)}, ${end.slice(0, 4)}`;
}

/** Null when the server sent no comparison (All time, or an older response). */
export function summaryDelta(
  comparison: DashboardPeriodComparison | null | undefined,
  figure: SummaryFigure,
): SummaryDelta | null {
  if (!comparison) return null;
  return {
    percent: comparison[figure].changePercent,
    amount: comparison[figure].changeAmount,
    against: previousPeriodCaption(comparison),
    upIsBad: figure === "expenses",
  };
}

export type DeltaTone = "good" | "bad" | "flat";

export function deltaTone(delta: SummaryDelta): DeltaTone {
  if (delta.amount === 0) return "flat";
  const rose = delta.amount > 0;
  return rose === delta.upIsBad ? "bad" : "good";
}

/** "▲ 12% vs Sep 1-7, 2026". A previous period of zero has no percentage. */
export function deltaText(delta: SummaryDelta): string {
  if (delta.amount === 0) return `No change vs ${delta.against}`;
  const arrow = delta.amount > 0 ? "▲" : "▼";
  const size = delta.percent === null ? "new" : `${Math.abs(delta.percent).toFixed(0)}%`;
  return `${arrow} ${size} vs ${delta.against}`;
}

/** The line under Net: what it means, in the owner's terms. */
export function netCaption(net: number, sales: number): string {
  if (net < 0) return "Expenses exceeded sales";
  if (sales > 0) return `${Math.round((net / sales) * 100)}% of sales kept`;
  return "Sales minus expenses";
}

const DUE_ORDER: Record<RecurringSchedule["dueState"], number> = { OVERDUE: 0, DUE_SOON: 1, SCHEDULED: 2 };

/** The few active schedules worth showing on Home: overdue first, then soonest. */
export function upcomingSchedules(schedules: readonly RecurringSchedule[], limit = 3): RecurringSchedule[] {
  return schedules
    .filter((schedule) => schedule.isActive)
    .sort((a, b) => DUE_ORDER[a.dueState] - DUE_ORDER[b.dueState] || a.nextDueDate.localeCompare(b.nextDueDate))
    .slice(0, limit);
}

/** The pill form of a change: "▲ 15%", "▼ 3%", "New", "0%". The period it is against is said once, elsewhere. */
export function deltaPillText(delta: SummaryDelta): string {
  if (delta.amount === 0) return "0%";
  if (delta.percent === null) return "New";
  return `${delta.amount > 0 ? "▲" : "▼"} ${Math.abs(delta.percent).toFixed(0)}%`;
}

/** The previous window, short, for the one line under the figure tiles: "Sep 28 – Oct 2". */
export function previousRangeShort(comparison: DashboardPeriodComparison): string {
  return formatDayRange(comparison.previousStart.slice(0, 10), comparison.previousEnd.slice(0, 10));
}
