import { useCallback, useRef, type ReactNode } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useFutureDatedRecords } from "../context/FutureDatedRecordsContext";
import { useReportingPeriod } from "../context/ReportingPeriodContext";
import { isGatedPath } from "../components/FutureDateGate";
import { connectionAllowsRoutePrefetch, currentConnection } from "./routeLoaders";
import { RouteDataPrefetchContext, routeDataRequests } from "./routeDataRequests";
import { cachedApiGet } from "./serverStateApi";
import { captureServerStateAccount } from "./serverStateCache";

/** Lets nav links start a screen's main read on intent; see routeDataRequests.ts. */
export function RouteDataPrefetchProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const { months, monthsState } = useReportingPeriod();
  const { blocked } = useFutureDatedRecords();
  const latest = useRef({ businessProfileId: selected?.id ?? null, months, monthsState, blocked });
  latest.current = { businessProfileId: selected?.id ?? null, months, monthsState, blocked };

  const warm = useCallback((destination: string) => {
    const { businessProfileId, months: knownMonths, monthsState: knownState, blocked: gated } = latest.current;
    if (businessProfileId === null || !captureServerStateAccount()) return;
    if (gated && isGatedPath(destination)) return;
    if (!connectionAllowsRoutePrefetch(currentConnection())) return;
    for (const request of routeDataRequests(destination, businessProfileId, knownMonths, knownState)) {
      // The screen reports its own failures when it opens; a warm-up has nobody to tell.
      cachedApiGet(request.url, { params: request.params }, request.scope).catch(() => undefined);
    }
  }, []);

  return <RouteDataPrefetchContext.Provider value={warm}>{children}</RouteDataPrefetchContext.Provider>;
}
