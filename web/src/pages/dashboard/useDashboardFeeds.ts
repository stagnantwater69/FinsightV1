import { useLayoutEffect, useRef, useState } from "react";
import { isAxiosError } from "axios";
import { cachedApiGet, peekCachedApiData } from "../../lib/serverStateApi";
import { useServerStateRefresh } from "../../lib/useServerStateRefresh";
import { useRevalidateOnReturn } from "../../lib/useRevalidateOnReturn";
import { getErrorMessage } from "../../lib/errors";
import type { PeriodSelection } from "../../lib/reportingPeriod";
import type { CashflowGranularity, DashboardCashflow, RecordItem, RecurringSchedule } from "../../lib/types";

export type { CashflowGranularity, CashflowPoint, DashboardCashflow } from "../../lib/types";

export type FeedState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: "error"; data: T | null }
  | { status: "unavailable"; data: null };

/** Retain data on same-scope refresh failures; never expose another scope's data. */
export function useCachedFeed<T>(
  url: string,
  params: Record<string, unknown> | null,
  businessProfileId: number | null,
  tags: readonly string[],
  options: { optional?: boolean; period?: PeriodSelection } = {},
) {
  const { optional = false, period } = options;
  const key = params && businessProfileId !== null ? JSON.stringify([url, businessProfileId, params]) : null;
  const [result, setResult] = useState<{
    key: string | null;
    state: FeedState<T>;
    error: string | null;
    updatedAt: number | null;
  }>({
    key: null,
    state: { status: "loading", data: null },
    error: null,
    updatedAt: null,
  });
  const activeKey = useRef(key);
  activeKey.current = key;
  const requestSequence = useRef(0);
  const state: FeedState<T> = key !== null && result.key === key
    ? result.state
    : { status: "loading", data: null };

  async function load(signal?: AbortSignal, force = false) {
    if (!params || businessProfileId === null || activeKey.current !== key) return;
    const requestKey = key;
    const sequence = ++requestSequence.current;
    const scope = { businessProfileId, tags, ...(period ? { period } : {}) };
    const cached = peekCachedApiData<T>(url, { params }, scope);
    setResult((prev) => ({
      key: requestKey,
      error: null,
      updatedAt: cached?.updatedAt ?? (prev.key === requestKey ? prev.updatedAt : null),
      state: cached && !cached.stale && !force
        ? { status: "ready", data: cached.data }
        : { status: "loading", data: cached?.data ?? (prev.key === requestKey ? prev.state.data : null) },
    }));
    if (cached && !cached.stale && !force) return;
    try {
      const { data } = await cachedApiGet<T>(url, { signal, params }, scope, { force });
      if (signal?.aborted || activeKey.current !== requestKey || sequence !== requestSequence.current) return;
      setResult({
        key: requestKey,
        state: { status: "ready", data },
        error: null,
        updatedAt: peekCachedApiData<T>(url, { params }, scope)?.updatedAt ?? null,
      });
    } catch (err) {
      if (signal?.aborted || (err as { name?: string })?.name === "AbortError") return;
      if (activeKey.current !== requestKey || sequence !== requestSequence.current) return;
      setResult((prev) => ({
        key: requestKey,
        error: getErrorMessage(err),
        updatedAt: prev.key === requestKey ? prev.updatedAt : null,
        state: optional && isAxiosError(err) && err.response?.status === 404
          ? { status: "unavailable", data: null }
          : { status: "error", data: prev.key === requestKey ? prev.state.data : null },
      }));
    }
  }

  useLayoutEffect(() => {
    if (key === null) {
      ++requestSequence.current;
      setResult({
        key: null,
        state: { status: "loading", data: null },
        error: null,
        updatedAt: null,
      });
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, businessProfileId]);

  useServerStateRefresh(
    [{ resource: url, businessProfileId, tags, ...(period ? { period } : {}) }],
    (signal) => void load(signal, true),
  );
  // Not forced: only a read past its cache window is fetched again, and the
  // key, so the owner's period and filters, stays as it was.
  useRevalidateOnReturn((signal) => void load(signal));

  const sameScope = key !== null && result.key === key;
  return {
    state,
    error: sameScope ? result.error : null,
    updatedAt: sameScope ? result.updatedAt : null,
    reload: () => void load(undefined, true),
  };
}

export function useUpcomingExpenses(businessProfileId: number | null) {
  return useCachedFeed<RecurringSchedule[]>(
    "/insights/recurring-schedules",
    businessProfileId === null ? null : { businessProfileId },
    businessProfileId,
    ["recurring-schedules", "financial"],
    { optional: true },
  );
}

/** Sales vs expenses: the last 7 days by day, or the last 6 months by month. */
export function useCashflow(businessProfileId: number | null, granularity: CashflowGranularity) {
  return useCachedFeed<DashboardCashflow>(
    "/dashboard/cashflow",
    businessProfileId === null ? null : { businessProfileId, granularity },
    businessProfileId,
    ["dashboard", "financial"],
  );
}

/** The newest records inside the selected period (or ever, for All time). */
export function useRecentRecords(
  businessProfileId: number | null,
  range: { dateFrom: string; dateTo: string } | null,
  ready: boolean,
) {
  return useCachedFeed<{ items: RecordItem[]; nextCursor: string | null }>(
    "/records/search",
    businessProfileId === null || !ready
      ? null
      : { businessProfileId, type: "all", limit: 6, sort: "date_desc", ...(range ?? {}) },
    businessProfileId,
    ["dashboard", "financial", "records"],
  );
}
