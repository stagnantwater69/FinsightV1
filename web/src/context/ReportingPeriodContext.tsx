import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { subscribeToServerState } from "../lib/serverStateCache";
import { useBusinessProfiles } from "./BusinessProfileContext";
import type { PeriodSelection } from "../lib/reportingPeriod";
import {
  settlePeriodSelection,
  storePeriodSelection,
  storedPeriodSelection,
  type ReportingPeriodScopeName,
} from "../lib/periodSelection";

/**
 * Pages keep independent selections while sharing the business's month list.
 *
 * The Month list is the business's own months with records, newest first,
 * from `GET /records/months` — never a fixed January to December.
 *
 * DEFAULT: the newest month that has records. For a business recording daily
 * that is the current month; for one that imported last year's books it is
 * the month those books end in, instead of an empty screen. With no records at
 * all (or no answer from the server) it is This week.
 *
 * Kept per business: another business has different months, so a switch
 * starts from that business's own default.
 */
export interface ReportingPeriodValue {
  selection: PeriodSelection;
  setSelection: (selection: PeriodSelection) => void;
  /** YYYY-MM keys, newest first. */
  months: string[];
  monthsState: "loading" | "ready" | "error";
  /** Reloads the month list, e.g. after records were added or imported. */
  refreshMonths: () => void;
  /**
   * False until the default is known. Pages wait for it so they load once,
   * for the right period, rather than once for a placeholder and again.
   */
  ready: boolean;
}

const ReportingPeriodContext = createContext<ReportingPeriodValue | null>(null);

export type { ReportingPeriodScopeName } from "../lib/periodSelection";

function usePeriodSelection(
  months: string[],
  monthsState: ReportingPeriodValue["monthsState"],
  scope?: ReportingPeriodScopeName,
): Pick<ReportingPeriodValue, "selection" | "setSelection" | "ready"> {
  const { selected } = useBusinessProfiles();
  const businessId = selected?.id ?? null;
  const [chosen, setChosen] = useState<{
    businessId: number | null;
    scope: ReportingPeriodScopeName | undefined;
    selection: PeriodSelection;
  } | null>(null);
  const stored = chosen && chosen.businessId === businessId && chosen.scope === scope
    ? chosen.selection
    : businessId !== null ? storedPeriodSelection(businessId, scope) : null;
  const { selection, ready } = settlePeriodSelection(stored, months, monthsState);

  const setSelection = useCallback(
    (next: PeriodSelection) => {
      setChosen({ businessId, scope, selection: next });
      if (businessId !== null) storePeriodSelection(businessId, next, scope);
    },
    [businessId, scope],
  );

  return { selection, setSelection, ready };
}

function useReportingPeriodState(scope?: ReportingPeriodScopeName): ReportingPeriodValue {
  const { selected } = useBusinessProfiles();
  const businessId = selected?.id ?? null;
  const [monthResult, setMonthResult] = useState<{
    businessId: number | null;
    months: string[];
    state: "loading" | "ready" | "error";
  }>(() => ({ businessId, months: [], state: businessId === null ? "ready" : "loading" }));
  const version = useRef(0);
  const activeRequest = useRef<{
    businessId: number;
    version: number;
    discardResult: boolean;
  } | null>(null);
  const queuedRefreshBusinessId = useRef<number | null>(null);
  const loadRef = useRef<(quiet: boolean) => Promise<void>>(async () => undefined);

  const load = useCallback(
    async (quiet: boolean) => {
      const request = ++version.current;
      if (businessId === null) {
        activeRequest.current = null;
        queuedRefreshBusinessId.current = null;
        setMonthResult({ businessId: null, months: [], state: "ready" });
        return;
      }
      activeRequest.current = { businessId, version: request, discardResult: false };
      if (!quiet) {
        setMonthResult({ businessId, months: [], state: "loading" });
      } else {
        setMonthResult((current) =>
          current.businessId === businessId
            ? current
            : { businessId, months: [], state: "loading" },
        );
      }
      try {
        const { data } = await api.get<{ months: string[] }>("/records/months", { params: { businessProfileId: businessId } });
        const active = activeRequest.current;
        if (request !== version.current || active?.version !== request || active.discardResult) return;
        setMonthResult({
          businessId,
          months: Array.isArray(data?.months) ? data.months : [],
          state: "ready",
        });
      } catch {
        const active = activeRequest.current;
        if (request !== version.current || active?.version !== request || active.discardResult) return;
        // A quiet refresh keeps the list it had; a first load settles as an
        // error so the pages load This week instead of waiting forever.
        if (!quiet) {
          setMonthResult({ businessId, months: [], state: "error" });
        } else {
          setMonthResult((current) =>
            current.businessId === businessId
              ? { ...current, state: "error" }
              : { businessId, months: [], state: "error" },
          );
        }
      } finally {
        const active = activeRequest.current;
        if (active?.businessId === businessId && active.version === request) {
          activeRequest.current = null;
          if (queuedRefreshBusinessId.current === businessId) {
            queuedRefreshBusinessId.current = null;
            void loadRef.current(true);
          }
        }
      }
    },
    [businessId],
  );
  loadRef.current = load;

  useEffect(() => {
    queuedRefreshBusinessId.current = null;
    void load(false);
    return () => {
      version.current += 1;
      if (activeRequest.current?.businessId === businessId) activeRequest.current = null;
      if (queuedRefreshBusinessId.current === businessId) queuedRefreshBusinessId.current = null;
    };
  }, [businessId, load]);

  useEffect(() => {
    if (businessId === null) return;
    return subscribeToServerState((event) => {
      if (event.type !== "invalidate") return;
      if (
        event.target.businessProfileId !== undefined &&
        event.target.businessProfileId !== businessId
      ) return;
      if (!event.target.tags?.includes("record-months")) return;

      const active = activeRequest.current;
      if (active?.businessId === businessId) {
        active.discardResult = true;
        queuedRefreshBusinessId.current = businessId;
        return;
      }
      void load(true);
    });
  }, [businessId, load]);

  const ownsMonthResult = monthResult.businessId === businessId;
  const months = ownsMonthResult ? monthResult.months : [];
  const monthsState = ownsMonthResult
    ? monthResult.state
    : businessId === null
      ? "ready"
      : "loading";

  const period = usePeriodSelection(months, monthsState, scope);

  const refreshMonths = useCallback(() => {
    if (businessId === null || activeRequest.current?.businessId === businessId) return;
    void load(true);
  }, [businessId, load]);

  return {
    ...period,
    months,
    monthsState,
    refreshMonths,
  };
}

export function ReportingPeriodProvider({ children, scope }: { children: ReactNode; scope?: ReportingPeriodScopeName }) {
  const value = useReportingPeriodState(scope);
  return <ReportingPeriodContext.Provider value={value}>{children}</ReportingPeriodContext.Provider>;
}

/**
 * Scoped pages share month loading, while keeping their filter and figures on
 * one page-owned selection. Standalone pages load their own month list.
 */
export function ReportingPeriodScope({ children, scope }: { children: ReactNode; scope?: ReportingPeriodScopeName }) {
  const existing = useContext(ReportingPeriodContext);
  if (existing) {
    return scope
      ? <ScopedReportingPeriod shared={existing} scope={scope}>{children}</ScopedReportingPeriod>
      : <>{children}</>;
  }
  return <ReportingPeriodProvider scope={scope}>{children}</ReportingPeriodProvider>;
}

function ScopedReportingPeriod({ children, shared, scope }: {
  children: ReactNode;
  shared: ReportingPeriodValue;
  scope: ReportingPeriodScopeName;
}) {
  const period = usePeriodSelection(shared.months, shared.monthsState, scope);
  return <ReportingPeriodContext.Provider value={{ ...shared, ...period }}>{children}</ReportingPeriodContext.Provider>;
}

export function useReportingPeriod(): ReportingPeriodValue {
  const value = useContext(ReportingPeriodContext);
  if (!value) throw new Error("useReportingPeriod must be used inside a ReportingPeriodProvider or ReportingPeriodScope");
  return value;
}
