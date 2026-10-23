import { createContext, useContext } from "react";
import { DEFAULT_RECORD_SORT, emptyFilters, flaggedCountRequest, recordsListRequest } from "../pages/records/filters";
import { settlePeriodSelection, storedPeriodSelection, type MonthsState } from "./periodSelection";
import type { cachedApiGet } from "./serverStateApi";
import { expenseOverviewDetailRequest, recoveryInsightRequest } from "./screenRequests";

/*
 * Starts a screen's main read when the owner signals they are going there:
 * pointing at, focusing or pressing its link, the same intent that already
 * warms the screen's code (PrefetchLink). Pointing at a link and clicking it
 * are a few hundred milliseconds apart, and each request costs a round trip
 * to the database region, so the screen opens on data that is already on its
 * way or already cached.
 *
 * It asks through the same cache the screen reads, with the request the
 * screen builds (screenRequests.ts, records/filters.ts) and the period rule
 * the screen applies (periodSelection.ts), so the screen joins the request in
 * flight or reads its result. A fresh cached answer costs no request, so
 * pointing at the same link again does nothing for 30 seconds. The provider
 * that runs it is RouteDataPrefetchProvider (routeDataPrefetch.tsx).
 */

export type CachedRequest = {
  url: string;
  params: Record<string, unknown>;
  scope: Parameters<typeof cachedApiGet>[2];
};

/** The reads to warm for `destination`, or none when the screen's own first read cannot be predicted. */
export function routeDataRequests(
  destination: string,
  businessProfileId: number,
  months: string[],
  monthsState: MonthsState,
): CachedRequest[] {
  // A query or hash means filters or state the bare screen would not open with.
  if (/[?#]/.test(destination)) return [];
  const period = (scope: "expense-insight" | "recovery-target") =>
    settlePeriodSelection(storedPeriodSelection(businessProfileId, scope), months, monthsState);
  switch (destination) {
    case "/records":
      return [
        recordsListRequest(businessProfileId, emptyFilters, DEFAULT_RECORD_SORT),
        flaggedCountRequest(businessProfileId),
      ];
    case "/insights/expense-behavior": {
      const { selection, ready } = period("expense-insight");
      return ready ? [expenseOverviewDetailRequest(businessProfileId, selection)] : [];
    }
    case "/insights/recovery": {
      const { selection, ready } = period("recovery-target");
      return ready ? [recoveryInsightRequest(businessProfileId, selection)] : [];
    }
    default:
      return [];
  }
}

export const RouteDataPrefetchContext = createContext<((destination: string) => void) | null>(null);

/** The warm-up for a link's destination; null outside the signed-in app. */
export function useRouteDataPrefetch() {
  return useContext(RouteDataPrefetchContext);
}
