import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useBusinessProfiles } from "./BusinessProfileContext";
import { THIS_WEEK, type PeriodSelection } from "../lib/reportingPeriod";
import { isServerStateAffected, subscribeToServerState } from "../lib/serverStateCache";
import { toLoadFailure, type LoadFailure } from "../lib/connectionState";

/**
 * The period the owner is looking at, shared by Home, Expense Insights and
 * Spending Impact — the same model web uses (web/src/context/
 * ReportingPeriodContext.tsx): This week, a month the business has records
 * in, or All time.
 *
 * The Month list is the business's own months with records, newest first,
 * from `GET /records/months`. The default is the newest of them, so a
 * business whose imported books end last year opens on that month rather
 * than on an empty week; with no records at all (or no answer) it is This
 * week.
 *
 * Held in memory per business for as long as the app runs: the provider sits
 * above the tabs, so moving between Home and Insights keeps the choice, and a
 * business switch starts from that business's own default.
 */
export interface ReportingPeriodValue {
  selection: PeriodSelection;
  setSelection: (selection: PeriodSelection) => void;
  /** YYYY-MM keys, newest first. */
  months: string[];
  monthsState: "loading" | "ready" | "error";
  monthsFailure: LoadFailure | null;
  monthsUpdatedAt: number | null;
  monthsRefreshing: boolean;
  refreshMonths: () => void;
  /** False until the default is known, so screens load once for the right period. */
  ready: boolean;
}

const ReportingPeriodContext = createContext<ReportingPeriodValue | null>(null);

interface MonthsSnapshot {
  businessId: number | null;
  months: string[];
  state: "loading" | "ready" | "error";
  failure: LoadFailure | null;
  updatedAt: number | null;
  refreshing: boolean;
}

function defaultFor(months: string[]): PeriodSelection {
  return months[0] ? { kind: "month", month: months[0] } : THIS_WEEK;
}

function useReportingPeriodState(): ReportingPeriodValue {
  const { selected } = useBusinessProfiles();
  const businessId = selected?.id ?? null;
  const [monthsSnapshot, setMonthsSnapshot] = useState<MonthsSnapshot>({
    businessId: null,
    months: [],
    state: "loading",
    failure: null,
    updatedAt: null,
    refreshing: false,
  });
  const [chosen, setChosen] = useState<Record<number, PeriodSelection>>({});
  const version = useRef(0);
  const activeRequest = useRef<{ businessId: number; version: number } | null>(null);
  const queuedRefreshBusinessId = useRef<number | null>(null);
  const loadRef = useRef<(quiet: boolean) => Promise<void>>(async () => undefined);

  const load = useCallback(
    async (quiet: boolean) => {
      if (businessId === null) {
        version.current += 1;
        activeRequest.current = null;
        queuedRefreshBusinessId.current = null;
        setMonthsSnapshot({
          businessId: null,
          months: [],
          state: "ready",
          failure: null,
          updatedAt: null,
          refreshing: false,
        });
        return;
      }
      if (activeRequest.current?.businessId === businessId) {
        queuedRefreshBusinessId.current = businessId;
        return;
      }
      const request = ++version.current;
      activeRequest.current = { businessId, version: request };
      if (!quiet) {
        setMonthsSnapshot((current) => ({
          businessId,
          months: current.businessId === businessId ? current.months : [],
          state: "loading",
          failure: null,
          updatedAt: current.businessId === businessId ? current.updatedAt : null,
          refreshing: false,
        }));
      } else {
        setMonthsSnapshot((current) => current.businessId === businessId
          ? { ...current, refreshing: true }
          : {
              businessId,
              months: [],
              state: "loading",
              failure: null,
              updatedAt: null,
              refreshing: true,
            });
      }
      try {
        const data = await api.get<{ months: string[] }>("/records/months", { businessProfileId: businessId });
        if (
          request !== version.current ||
          queuedRefreshBusinessId.current === businessId
        ) return;
        setMonthsSnapshot({
          businessId,
          months: Array.isArray(data?.months) ? data.months : [],
          state: "ready",
          failure: null,
          updatedAt: Date.now(),
          refreshing: false,
        });
      } catch (err) {
        if (
          request !== version.current ||
          queuedRefreshBusinessId.current === businessId
        ) return;
        const failure = toLoadFailure(err);
        if (!quiet) {
          setMonthsSnapshot({
            businessId,
            months: [],
            state: "error",
            failure,
            updatedAt: null,
            refreshing: false,
          });
        } else {
          setMonthsSnapshot((current) => current.businessId === businessId
            ? { ...current, state: "error", failure, refreshing: false }
            : {
                businessId,
                months: [],
                state: "error",
                failure,
                updatedAt: null,
                refreshing: false,
              });
        }
      } finally {
        const active = activeRequest.current;
        if (active?.businessId === businessId && active.version === request) {
          activeRequest.current = null;
          if (request === version.current && queuedRefreshBusinessId.current === businessId) {
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

  useEffect(() => subscribeToServerState((event) => {
    if (
      event.type === "invalidate" &&
      businessId !== null &&
      isServerStateAffected("/records/months", { businessProfileId: businessId }, event)
    ) {
      void load(true);
    }
  }), [businessId, load]);

  // Effects update after render, so bind visible months to their source
  // business or a switch can briefly expose the previous ready period.
  const ownsSnapshot = monthsSnapshot.businessId === businessId;
  const months = ownsSnapshot ? monthsSnapshot.months : [];
  const monthsState = ownsSnapshot ? monthsSnapshot.state : "loading";
  const monthsFailure = ownsSnapshot ? monthsSnapshot.failure : null;
  const monthsUpdatedAt = ownsSnapshot ? monthsSnapshot.updatedAt : null;
  const monthsRefreshing = ownsSnapshot ? monthsSnapshot.refreshing : false;
  const stored = businessId !== null ? chosen[businessId] ?? null : null;
  const settled = monthsState !== "loading";
  const storedStillValid =
    stored && (stored.kind !== "month" || (settled && (months.includes(stored.month) || monthsState === "error")));
  const selection = storedStillValid ? stored : defaultFor(months);

  const setSelection = useCallback(
    (next: PeriodSelection) => {
      if (businessId === null) return;
      setChosen((current) => ({ ...current, [businessId]: next }));
    },
    [businessId],
  );

  const refreshMonths = useCallback(() => {
    void load(true);
  }, [load]);

  return {
    selection,
    setSelection,
    months,
    monthsState,
    monthsFailure,
    monthsUpdatedAt,
    monthsRefreshing,
    refreshMonths,
    ready: settled || (stored !== null && stored.kind !== "month"),
  };
}

export function ReportingPeriodProvider({ children }: { children: ReactNode }) {
  const value = useReportingPeriodState();
  return <ReportingPeriodContext.Provider value={value}>{children}</ReportingPeriodContext.Provider>;
}

/**
 * Provides the period only where nothing above does, so a screen rendered on
 * its own (as the render tests do) still has one period for its selector and
 * its figures.
 */
export function ReportingPeriodScope({ children }: { children: ReactNode }) {
  const existing = useContext(ReportingPeriodContext);
  if (existing) return <>{children}</>;
  return <ReportingPeriodProvider>{children}</ReportingPeriodProvider>;
}

export function useReportingPeriod(): ReportingPeriodValue {
  const value = useContext(ReportingPeriodContext);
  if (!value) throw new Error("useReportingPeriod must be used inside a ReportingPeriodProvider or ReportingPeriodScope");
  return value;
}
