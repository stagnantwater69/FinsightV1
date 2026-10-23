import { periodParams, type PeriodSelection } from "./reportingPeriod";

/*
 * The main read of a screen, as the screen makes it and as the navigation
 * warms it on intent (see routeDataPrefetch.tsx). One builder for both: the
 * cache keys on url, business, period, filters, sort, pagination and params,
 * so a warm-up that differs from the screen in any of them fetches something
 * the screen never reads.
 */

/** Expense Insights' two core panels, read in one request. */
export function expenseOverviewDetailRequest(businessProfileId: number, selection: PeriodSelection) {
  return {
    url: "/insights/expense-overview",
    params: {
      businessProfileId,
      ...periodParams(selection),
      view: "detail" as const,
    },
    scope: {
      businessProfileId,
      period: selection,
      tags: ["expense-insight", "financial", "expense-overview"],
    },
  };
}

/** The Recovery Target page's insight. */
export function recoveryInsightRequest(businessProfileId: number, selection: PeriodSelection) {
  return {
    url: "/insights/recovery",
    params: {
      businessProfileId,
      // The server bounds this to the selected interval through its as-of
      // date. Asking for the 31-day ceiling keeps every calendar month
      // available to the daily table without hiding older rows.
      coverageDays: 31,
      ...periodParams(selection),
    },
    scope: {
      businessProfileId,
      period: selection,
      tags: ["recovery", "financial"],
    },
  };
}
