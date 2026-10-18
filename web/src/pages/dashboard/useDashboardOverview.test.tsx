// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginServerStateSession, endServerStateSession, invalidateServerState } from "../../lib/serverStateCache";
import type { DashboardSummary, ReductionOpportunity } from "../../lib/types";
import type { DashboardExpenseOverview } from "../../lib/expenseOverview";
import type { PeriodSelection } from "../../lib/reportingPeriod";
import { useDashboardOverview } from "./useDashboardOverview";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function summary(availableFunds: number): DashboardSummary {
  return {
    periodDays: 30, periodStart: "2026-09-01", periodEnd: "2026-09-30",
    overview: { availableFunds, totalExpenses: 100, totalSalesReference: 200 },
    expenseCategoryBreakdown: [], recordsNeedingReview: 0, alerts: [], unreadAlertCount: 0,
    recoveryStatus: {
      expectedMonthlyExpenses: 100, operatingDays: 26, dailyNeededTarget: 4,
      salesThisMonth: 200, remainingTarget: 0, daysInMonth: 30, calendarDaysLeftInMonth: 10,
      remainingOperatingDays: 8, remainingOperatingDaysIsApproximated: false,
      adjustedDailyTarget: 0, todaysTarget: 4, todaysSales: 0, todaysGap: -4,
      todaysStatus: "below", monthCoveragePercent: 100, onTrack: true,
    },
  };
}

const opportunity: ReductionOpportunity = {
  id: "inventory-review", type: "CATEGORY_PRESSURE", categoryId: 1, categoryName: "Inventory",
  priority: "high", confidence: "strong", observation: "Inventory spending increased.",
  rationale: "Compare recent purchases.", costBehavior: "variable", suggestedChecks: [],
  relatedRecordIds: [], limitations: [], evidence: {
    currentAmount: 100, previousAmount: 50, changeAmount: 50, changePercent: 100,
    expenseSharePercent: 100, recordCount: 3, unusualRecordCount: 0, possibleDuplicateCount: 0,
  },
};
const details: DashboardExpenseOverview = {
  view: "dashboard",
  comparison: { status: "available", data: { totals: { current: 100, previous: 50 }, categoryTrends: [] } },
  topOpportunity: { status: "available", data: opportunity },
};
const september: PeriodSelection = { kind: "month", month: "2026-09" };

beforeEach(() => {
  get.mockReset();
  beginServerStateSession("dashboard-overview-owner");
});
afterEach(endServerStateSession);

describe("dashboard overview request lifecycle", () => {
  it.each([
    { name: "business", businessId: 2, selection: september },
    { name: "period", businessId: 1, selection: { kind: "month", month: "2026-08" } as PeriodSelection },
  ])("keeps previous $name details hidden when the new request is invalidated and then fails", async ({ businessId, selection }) => {
    const newDetails = deferred<{ data: DashboardExpenseOverview }>();
    const replacement = deferred<{ data: DashboardExpenseOverview }>();
    let detailCalls = 0;
    get.mockImplementation((url: string) => {
      if (url === "/dashboard/summary") return Promise.resolve({ data: summary(500) });
      detailCalls += 1;
      return detailCalls === 1 ? Promise.resolve({ data: details })
        : detailCalls === 2 ? newDetails.promise : replacement.promise;
    });
    const snapshots: Array<{ comparison: unknown; topOpportunity: unknown }> = [];
    const { result, rerender } = renderHook(({ id, period }) => {
      const view = useDashboardOverview(id, period, true);
      snapshots.push({ comparison: view.comparison, topOpportunity: view.topOpportunity });
      return view;
    }, { initialProps: { id: 1, period: september as PeriodSelection } });
    await waitFor(() => expect(result.current.topOpportunity).toEqual(opportunity));
    snapshots.length = 0;

    rerender({ id: businessId, period: selection });
    expect(result.current.comparison).toBeNull();
    expect(result.current.topOpportunity).toBeNull();
    await waitFor(() => expect(detailCalls).toBe(2));
    act(() => invalidateServerState({ businessProfileId: businessId, resourcePrefix: "/insights/expense-overview" }));
    await waitFor(() => expect(detailCalls).toBe(3));
    await act(async () => replacement.reject(new Error("offline")));
    await waitFor(() => expect(result.current.comparisonState).toBe("error"));
    await act(async () => newDetails.resolve({ data: details }));

    expect(result.current.overviewRefreshError).toBeNull();
    expect(result.current.opportunityState).toBe("error");
    expect(snapshots.every((snapshot) => snapshot.comparison === null && snapshot.topOpportunity === null)).toBe(true);
  });

  it("retains only same-scope details with a warning when a refresh fails", async () => {
    let fail = false;
    get.mockImplementation((url: string) => {
      if (url === "/dashboard/summary") return Promise.resolve({ data: summary(500) });
      return fail ? Promise.reject(new Error("offline")) : Promise.resolve({ data: details });
    });
    const { result } = renderHook(() => useDashboardOverview(1, september, true));
    await waitFor(() => expect(result.current.topOpportunity).toEqual(opportunity));
    fail = true;

    act(() => invalidateServerState({ businessProfileId: 1, resourcePrefix: "/insights/expense-overview" }));

    await waitFor(() => expect(result.current.overviewRefreshError).toBe("offline"));
    expect(result.current.comparison).toEqual(details.comparison.data);
    expect(result.current.topOpportunity).toEqual(opportunity);
    expect(result.current.summary?.overview.availableFunds).toBe(500);
    expect(result.current.error).toBeNull();
  });

  it("ignores an older same-scope summary response even without a cache session", async () => {
    endServerStateSession();
    const first = deferred<{ data: DashboardSummary }>();
    const refreshed = deferred<{ data: DashboardSummary }>();
    let summaryCalls = 0;
    get.mockImplementation((url: string) => url === "/insights/expense-overview"
      ? Promise.resolve({ data: details })
      : ++summaryCalls === 1 ? first.promise : refreshed.promise);
    const { result } = renderHook(() => useDashboardOverview(1, september, true));
    act(() => result.current.reload());
    await waitFor(() => expect(summaryCalls).toBe(2));
    await act(async () => refreshed.resolve({ data: summary(900) }));
    await waitFor(() => expect(result.current.summary?.overview.availableFunds).toBe(900));

    await act(async () => first.resolve({ data: summary(100) }));

    expect(result.current.summary?.overview.availableFunds).toBe(900);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ignores an aborted response after switching away and back to the same business", async () => {
    endServerStateSession();
    const first = deferred<{ data: DashboardSummary }>();
    let summaryCalls = 0;
    let firstSignal: AbortSignal | undefined;
    get.mockImplementation((url: string, config: { signal?: AbortSignal }) => {
      if (url === "/insights/expense-overview") return Promise.resolve({ data: details });
      if (++summaryCalls === 1) { firstSignal = config.signal; return first.promise; }
      return Promise.resolve({ data: summary(summaryCalls === 2 ? 200 : 900) });
    });
    const { result, rerender } = renderHook(({ id }) => useDashboardOverview(id, september, true), { initialProps: { id: 1 } });
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.summary?.overview.availableFunds).toBe(200));
    rerender({ id: 1 });
    await waitFor(() => expect(result.current.summary?.overview.availableFunds).toBe(900));
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => first.resolve({ data: summary(100) }));

    expect(result.current.summary?.overview.availableFunds).toBe(900);
  });

  it("settles an absent business and skips detail reads for All time", async () => {
    get.mockResolvedValue({ data: summary(500) });
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useDashboardOverview(id, { kind: "all" }, true), {
      initialProps: { id: null as number | null },
    });
    expect(result.current.loading).toBe(false);
    expect(get).not.toHaveBeenCalled();
    rerender({ id: 1 });
    await waitFor(() => expect(result.current.summary?.overview.availableFunds).toBe(500));
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.comparison).toBeNull();
    expect(result.current.topOpportunity).toBeNull();
    expect(result.current.comparisonState).toBe("ready");
  });
});
