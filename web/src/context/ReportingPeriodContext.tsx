import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { subscribeToServerState } from "../lib/serverStateCache";
import { useBusinessProfiles } from "./BusinessProfileContext";
import { THIS_WEEK, type PeriodSelection } from "../lib/reportingPeriod";

/**
 * The period the owner is looking at, shared by every date-dependent screen.
 *
 * One selection for the Dashboard, Expense Insights and Spending Impact: an
 * owner who picks August on the Dashboard and opens Expense Insights is still
 * looking at August, rather than at whatever window that page defaulted to.
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

const STORAGE_KEY = "finsight.reportingPeriod";

function readStored(businessId: number): PeriodSelection | null {
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_KEY}.${businessId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PeriodSelection;
    if (parsed.kind === "week" || parsed.kind === "all") return parsed;
    if (parsed.kind === "month" && typeof parsed.month === "string" && /^\d{4}-\d{2}$/.test(parsed.month)) return parsed;
  } catch {
    // Unavailable or corrupt storage just means the default applies.
  }
  return null;
}

function writeStored(businessId: number, selection: PeriodSelection) {
  try {
    window.sessionStorage.setItem(`${STORAGE_KEY}.${businessId}`, JSON.stringify(selection));
  } catch {
    // A private window can refuse storage; the selection still holds for this visit.
  }
}

function defaultFor(months: string[]): PeriodSelection {
  return months[0] ? { kind: "month", month: months[0] } : THIS_WEEK;
}

function useReportingPeriodState(): ReportingPeriodValue {
  const { selected } = useBusinessProfiles();
  const businessId = selected?.id ?? null;
  const [monthResult, setMonthResult] = useState<{
    businessId: number | null;
    months: string[];
    state: "loading" | "ready" | "error";
  }>(() => ({ businessId, months: [], state: businessId === null ? "ready" : "loading" }));
  const [chosen, setChosen] = useState<{ businessId: number | null; selection: PeriodSelection } | null>(null);
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

  // A business's own selection, if it made one this visit.
  const stored = chosen && chosen.businessId === businessId ? chosen.selection : businessId !== null ? readStored(businessId) : null;
  const settled = monthsState !== "loading";
  // A chosen month that no longer has records falls back to the default.
  const storedStillValid =
    stored && (stored.kind !== "month" || (settled && (months.includes(stored.month) || monthsState === "error")));
  const selection = storedStillValid ? stored : defaultFor(months);

  const setSelection = useCallback(
    (next: PeriodSelection) => {
      setChosen({ businessId, selection: next });
      if (businessId !== null) writeStored(businessId, next);
    },
    [businessId],
  );

  const refreshMonths = useCallback(() => {
    if (businessId === null || activeRequest.current?.businessId === businessId) return;
    void load(true);
  }, [businessId, load]);

  return {
    selection,
    setSelection,
    months,
    monthsState,
    refreshMonths,
    ready: settled || (stored !== null && stored.kind !== "month"),
  };
}

export function ReportingPeriodProvider({ children }: { children: ReactNode }) {
  const value = useReportingPeriodState();
  return <ReportingPeriodContext.Provider value={value}>{children}</ReportingPeriodContext.Provider>;
}

/**
 * Provides the period only where nothing above does. Each page that reads the
 * period renders inside one, so a page rendered on its own (as the page tests
 * do) still has ONE period shared by its filter and its figures.
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
