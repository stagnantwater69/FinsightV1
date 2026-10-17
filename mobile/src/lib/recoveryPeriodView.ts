import { formatMoney } from "./money";
import { monthLabel } from "./reportingPeriod";
import type {
  DailyCoverageRow,
  RecoveryCheckpoint,
  RecoveryInsight,
  RecoveryReportingPeriod,
} from "./types";

export function recoveryPeriodLabel(period: RecoveryReportingPeriod): string {
  if (period.kind === "week") return "This week";
  return monthLabel(period.month ?? period.start.slice(0, 7));
}

export function recoveryPeriodPhrase(period: RecoveryReportingPeriod): string {
  return period.kind === "week" ? "this week" : `in ${recoveryPeriodLabel(period)}`;
}

export function recoveryPeriodStatusLabel(period: RecoveryReportingPeriod): string {
  switch (period.status) {
    case "needs_setup":
      return "Recovery Target isn't ready yet";
    case "no_data":
      return period.kind === "week" ? "No sales recorded this week" : `No sales recorded in ${recoveryPeriodLabel(period)}`;
    case "covered":
      return "Sales coverage target reached";
    case "ahead":
      return period.isComplete ? "Finished above target" : "Ahead of pace";
    case "on_pace":
      return period.isComplete ? "Finished on target" : "On pace";
    case "behind":
      return period.isComplete ? "Finished below target" : "Behind pace";
  }
}

/** "≈ 21.5" when estimated from the profile, "22" when read off a schedule. */
export function formatOperatingDays(value: number, approximated: boolean): string {
  if (!approximated) return String(Math.round(value));
  return `≈ ${(Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "")}`;
}

/** An older server sends no `reportingPeriod`; its month-to-date fields say the same thing. */
export function legacyReportingPeriod(data: RecoveryInsight): RecoveryReportingPeriod {
  const start = data.monthStart.slice(0, 10);
  const month = start.slice(0, 7);
  const end = `${month}-${String(data.daysInMonth).padStart(2, "0")}`;
  const status: RecoveryReportingPeriod["status"] =
    data.status === "no_current_month_data" || data.status === "data_incomplete"
      ? "no_data"
      : (data.status as RecoveryReportingPeriod["status"] | undefined) ??
        (data.needsSetup ? "needs_setup" : data.onTrack ? "on_pace" : "behind");
  const operatingDays = data.operatingDaysThisMonth ?? data.operatingDays;
  return {
    kind: "month",
    month,
    start,
    end,
    asOfDate: data.asOfDate ?? data.today.slice(0, 10),
    timezone: data.timezone ?? "UTC",
    isCurrent: true,
    isComplete: false,
    targetBasis: "monthly_expenses",
    monthlyExpenseBases: [],
    target: data.expectedMonthlyExpenses,
    sales: data.salesThisMonth,
    confirmedSales: data.confirmedSalesThisMonth ?? data.salesThisMonth,
    provisionalSales: data.provisionalSalesThisMonth ?? 0,
    remainingTarget: data.remainingTarget,
    coveragePercent: data.monthCoveragePercent,
    dailyTarget: data.dailyNeededTarget,
    adjustedDailyTarget: data.adjustedDailyTarget,
    operatingDays,
    elapsedOperatingDays: Math.max(0, operatingDays - data.remainingOperatingDays),
    remainingOperatingDays: data.remainingOperatingDays,
    operatingScheduleConfigured: data.operatingScheduleConfigured ?? false,
    operatingDaysIsApproximated: data.remainingOperatingDaysIsApproximated,
    expectedSalesToDate: data.expectedSalesToDate ?? 0,
    paceVarianceAmount: data.paceVarianceAmount ?? 0,
    status,
    confidence: data.confidence ?? "unavailable",
    recordCount: data.dailyCoverage.length,
    dataWarnings: data.dataWarnings ?? [],
  };
}

export function reportingPeriodOf(data: RecoveryInsight): RecoveryReportingPeriod {
  return data.reportingPeriod ?? legacyReportingPeriod(data);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface CumulativePoint {
  date: string;
  /** Running sales total; null for days after the as-of date. */
  sales: number | null;
  target: number;
  /** True when `target` is drawn between known anchors rather than summed from the server's rows. */
  estimated: boolean;
}

/**
 * Running sales and target totals across the selected period. Past the as-of
 * date the target line runs straight between known anchors: any future weekly
 * checkpoint (an exact server figure) and the period target on its last day.
 * Same rule as web's recovery/recoverySeries.ts.
 */
export function buildCumulativeSeries(
  daily: readonly DailyCoverageRow[],
  period: Pick<RecoveryReportingPeriod, "start" | "end" | "target" | "isComplete">,
  checkpoints: readonly RecoveryCheckpoint[] = [],
): CumulativePoint[] {
  const rows = daily
    .filter((d) => d.date >= period.start && d.date <= period.end)
    .sort((a, b) => a.date.localeCompare(b.date));
  const points: CumulativePoint[] = [];
  let sales = 0;
  let target = 0;
  for (const row of rows) {
    sales += row.sales;
    target += row.neededTarget ?? 0;
    points.push({ date: row.date, sales, target, estimated: false });
  }
  if (period.isComplete) return points;

  const lastDate = points.at(-1)?.date ?? addDays(period.start, -1);
  const anchors = checkpoints
    .filter((c) => c.endDate > lastDate && c.endDate < period.end)
    .map((c) => ({ date: c.endDate, value: c.cumulativeTarget }));
  anchors.push({ date: period.end, value: Math.max(period.target, target) });

  let from = { date: lastDate, value: target };
  for (const anchor of anchors) {
    const span = daysBetween(from.date, anchor.date);
    for (let step = 1; step <= span; step += 1) {
      points.push({
        date: addDays(from.date, step),
        sales: null,
        target: from.value + ((anchor.value - from.value) * step) / span,
        estimated: true,
      });
    }
    from = anchor;
  }
  return points;
}

export function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export type HighlightKind = "on-target" | "best-day" | "closed";

export interface RecoveryHighlight {
  kind: HighlightKind;
  title: string;
  body: string;
}

/** Plain facts read straight off the daily rows. Nothing inferred, nothing predicted. */
export function recoveryHighlights(rows: readonly DailyCoverageRow[]): RecoveryHighlight[] {
  const open = rows.filter((r) => r.status !== "closed");
  const hit = open.filter((r) => r.status === "at" || r.status === "above");
  const best = rows.reduce<DailyCoverageRow | null>((top, r) => (r.sales > 0 && (!top || r.sales > top.sales) ? r : top), null);
  const closed = rows.length - open.length;
  const items: RecoveryHighlight[] = [];
  if (open.length > 0) {
    items.push({
      kind: "on-target",
      title: "Open days on target",
      body: `${hit.length} of ${open.length} open ${open.length === 1 ? "day" : "days"} so far reached the allocated target.`,
    });
  }
  if (best) {
    items.push({
      kind: "best-day",
      title: "Highest sales day",
      body: `${shortDay(best.date)}, with ${formatMoney(best.sales)} recorded.`,
    });
  }
  if (closed > 0) {
    items.push({
      kind: "closed",
      title: "Closed days",
      body: `${closed} ${closed === 1 ? "day was closed on your schedule and carries" : "days were closed on your schedule and carry"} no target.`,
    });
  }
  return items;
}

/** Share of today's target recorded so far, 0..∞ (it can pass 100). */
export function todayPercent(data: Pick<RecoveryInsight, "todaysSales" | "todaysTarget">): number {
  if (data.todaysTarget > 0) return (data.todaysSales / data.todaysTarget) * 100;
  return data.todaysSales > 0 ? 100 : 0;
}

/** The composed summary paragraph, word for word what web shows. */
export function recoverySummaryText(period: RecoveryReportingPeriod): string {
  const parts = [
    `Recorded sales ${recoveryPeriodPhrase(period)} are ${formatMoney(period.sales)} against a ${formatMoney(period.target)} target. ${recoveryPeriodStatusLabel(period)}.`,
  ];
  if (!period.isComplete && period.adjustedDailyTarget !== null) {
    parts.push(
      `The remaining target is ${formatMoney(period.remainingTarget)}, or about ${formatMoney(period.adjustedDailyTarget)} per remaining operating day.`,
    );
  }
  return parts.join(" ");
}

export function recoveryAskQuestion(period: RecoveryReportingPeriod): string {
  const variance = period.paceVarianceAmount;
  const position = variance < 0 ? "behind" : variance > 0 ? "ahead of" : "on";
  return `Why are my recorded sales ${formatMoney(Math.abs(variance))} ${position} pace ${recoveryPeriodPhrase(period)}, and what should I review?`;
}
