import { THIS_WEEK, type PeriodSelection } from "./reportingPeriod";

/*
 * How a page's reporting period is chosen: its stored choice for this business
 * when that is still valid, otherwise the default. Kept apart from the context
 * so the route data warm-up (routeDataRequests.ts) applies the same rule as
 * the page; a warm-up for a different period is a wasted request.
 */

const STORAGE_KEY = "finsight.reportingPeriod";

export type ReportingPeriodScopeName = "dashboard" | "expense-insight" | "recovery-target" | "spending-impact";

export type MonthsState = "loading" | "ready" | "error";

function storageKey(businessId: number, scope?: ReportingPeriodScopeName): string {
  return `${STORAGE_KEY}.${businessId}${scope ? `.${scope}` : ""}`;
}

/** The choice a page last stored for this business, or null. */
export function storedPeriodSelection(businessId: number, scope?: ReportingPeriodScopeName): PeriodSelection | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(businessId, scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PeriodSelection;
    if (parsed.kind === "week" || parsed.kind === "all") return parsed;
    if (parsed.kind === "month" && typeof parsed.month === "string" && /^\d{4}-\d{2}$/.test(parsed.month)) return parsed;
  } catch {
    // Unavailable or corrupt storage just means the default applies.
  }
  return null;
}

export function storePeriodSelection(businessId: number, selection: PeriodSelection, scope?: ReportingPeriodScopeName) {
  try {
    window.sessionStorage.setItem(storageKey(businessId, scope), JSON.stringify(selection));
  } catch {
    // A private window can refuse storage; the selection still holds for this visit.
  }
}

function defaultFor(months: string[]): PeriodSelection {
  return months[0] ? { kind: "month", month: months[0] } : THIS_WEEK;
}

/** The selection a page opens with, from its stored choice and the month list. */
export function settlePeriodSelection(
  stored: PeriodSelection | null,
  months: string[],
  monthsState: MonthsState,
): { selection: PeriodSelection; ready: boolean } {
  const settled = monthsState !== "loading";
  // Removed months fall back to the default; failed refreshes preserve the choice.
  const storedStillValid =
    stored && (stored.kind !== "month" || (settled && (months.includes(stored.month) || monthsState === "error")));
  return {
    selection: storedStillValid ? stored : defaultFor(months),
    ready: settled || (stored !== null && stored.kind !== "month"),
  };
}
