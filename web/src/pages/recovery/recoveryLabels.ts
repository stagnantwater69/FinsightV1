import { STATUS_TEXT_COLORS } from "../../lib/chartPalette";
import type {
  DailyCoverageStatus,
  DayStatus,
  MonthlyExpenseBasis,
  RecoveryInsight,
  RecoveryReportingPeriod,
} from "../../lib/types";
import { monthLabel } from "../../lib/reportingPeriod";

// Text-variant colors: used for the Gap column, which stays a plain coloured
// figure rather than a chip — see the Pill mapping below for the Status
// column, which IS a chip.
//
// `statusColor` only ever needs to answer for the three statuses a figure is
// actually drawn for — a closed day renders "—" instead (see
// DAILY_COVERAGE_COLUMNS' Gap cell), so it never reaches here.
export function statusColor(status: DayStatus): string {
  return status === "below"
    ? STATUS_TEXT_COLORS.critical
    : status === "at"
      ? STATUS_TEXT_COLORS.warning
      : STATUS_TEXT_COLORS.good;
}

export function statusLabel(status: DayStatus): string {
  return status === "below"
    ? "Below target"
    : status === "at"
      ? "Reached target"
      : "Above target";
}

/** Same wording, extended for the daily table's `"closed"` row status —
 * plan §8.3. Kept separate from `statusLabel` above because every OTHER call
 * site (today's status, the scenario summaries) only ever has a `DayStatus`
 * and can never be handed `"closed"`. */
export function dailyRowStatusLabel(status: DailyCoverageStatus): string {
  return status === "closed" ? "Closed" : statusLabel(status);
}

export function recoveryPeriodLabel(period: RecoveryReportingPeriod): string {
  if (period.kind === "week") return "This week";
  return monthLabel(period.month ?? period.start.slice(0, 7));
}

export function recoveryPeriodPhrase(period: RecoveryReportingPeriod): string {
  if (period.kind === "week") return "this week";
  return `in ${recoveryPeriodLabel(period)}`;
}

export function recoveryPeriodStatusLabel(period: RecoveryReportingPeriod): string {
  switch (period.status) {
    case "needs_setup":
      return "Recovery Target isn't ready yet";
    case "no_data":
      return period.kind === "week"
        ? "No sales recorded this week"
        : `No sales recorded in ${recoveryPeriodLabel(period)}`;
    case "covered":
      return "Sales coverage target reached";
    case "ahead":
      return period.isComplete ? "Finished above target" : "Ahead";
    case "on_pace":
      return period.isComplete ? "Finished on target" : "On pace";
    case "behind":
      return period.isComplete ? "Finished below target" : "Behind";
  }
}

export function formatOperatingDayNumber(value: number, approximated: boolean): string {
  return approximated
    ? (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "")
    : String(Math.round(value));
}

export function formatOperatingDays(value: number, approximated: boolean): string {
  const rounded = formatOperatingDayNumber(value, approximated);
  return approximated ? `≈ ${rounded}` : rounded;
}

function basisRecordSource(basis: MonthlyExpenseBasis): string {
  const records = `${basis.eligibleRecordCount} confirmed expense ${basis.eligibleRecordCount === 1 ? "record" : "records"}`;
  return basis.sourceMonth
    ? `${records} in ${monthLabel(basis.sourceMonth)}`
    : records;
}

export function reportingPeriodBasisSource(
  data: RecoveryInsight,
  period: RecoveryReportingPeriod,
): string {
  const entries = period.monthlyExpenseBases ?? [];

  if (entries.length > 1) {
    const sources = entries.map(({ targetMonth, basis }) =>
      basis.source === "previous_complete_month"
        ? `${monthLabel(targetMonth)} (${basisRecordSource(basis)})`
        : `${monthLabel(targetMonth)} (starting estimate)`,
    );
    return `Prorated across ${sources.join(" and ")}.`;
  }

  const selectedMonth = period.start.slice(0, 7) === period.end.slice(0, 7);
  const basis =
    entries[0]?.basis ??
    (!data.reportingPeriod || (period.isCurrent && selectedMonth)
      ? data.monthlyExpenseBasis
      : undefined);

  if (!basis) {
    return period.targetBasis === "prorated_monthly_expenses"
      ? "Prorated from monthly costs"
      : "Monthly costs";
  }

  if (basis.source === "previous_complete_month") {
    const source = basisRecordSource(basis);
    return period.targetBasis === "prorated_monthly_expenses"
      ? `Prorated from ${source}.`
      : `From ${source}.`;
  }

  return period.targetBasis === "prorated_monthly_expenses"
    ? "Prorated from your starting estimate."
    : "Starting estimate from your business profile.";
}

export function legacyReportingPeriod(data: RecoveryInsight): RecoveryReportingPeriod {
  const start = data.monthStart.slice(0, 10);
  const month = start.slice(0, 7);
  const end = `${month}-${String(data.daysInMonth).padStart(2, "0")}`;
  const status: RecoveryReportingPeriod["status"] =
    data.status === "no_current_month_data" || data.status === "data_incomplete"
      ? "no_data"
      : data.status ?? (data.needsSetup ? "needs_setup" : data.onTrack ? "on_pace" : "behind");
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

/**
 * Scrolls an in-page anchor target into view and moves keyboard focus to it —
 * WCAG 2.4.3. The target needs `tabIndex={-1}` so it's programmatically
 * focusable without joining the normal tab order; `preventScroll: true` on
 * `.focus()` avoids a second, competing scroll after `scrollIntoView` already
 * placed it.
 */
export function focusSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduceMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
  el.focus({ preventScroll: true });
}
