// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginServerStateSession, endServerStateSession } from "../../lib/serverStateCache";
import { useCashflow, useRecentRecords, useUpcomingExpenses, type CashflowGranularity } from "./useDashboardFeeds";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const firstFlow = { granularity: "monthly", points: [{ date: "2026-09", sales: 25_000, expenses: 5_000 }] };
const secondFlow = { granularity: "monthly", points: [{ date: "2026-09", sales: 750, expenses: 200 }] };
const firstRecords = { items: [{ id: 1, description: "First business sale" }], nextCursor: null };

beforeEach(() => {
  get.mockReset();
  beginServerStateSession("dashboard-feed-owner");
});
afterEach(endServerStateSession);

describe("dashboard feed scope isolation", () => {
  it("never renders the previous business's cash flow while its replacement loads or fails", async () => {
    const pending = deferred<{ data: typeof secondFlow }>();
    get.mockResolvedValueOnce({ data: firstFlow }).mockImplementationOnce(() => pending.promise);
    const snapshots: unknown[] = [];
    const { result, rerender } = renderHook(({ businessId }) => {
      const feed = useCashflow(businessId, "monthly");
      snapshots.push(feed.state.data);
      return feed;
    }, { initialProps: { businessId: 1 } });
    await waitFor(() => expect(result.current.state.data).toEqual(firstFlow));

    snapshots.length = 0;
    rerender({ businessId: 2 });

    expect(result.current.state.data).toBeNull();
    expect(snapshots.every((data) => data === null)).toBe(true);
    await act(async () => { pending.reject(new Error("offline")); });
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state.data).toBeNull();
    expect(snapshots.every((data) => data === null)).toBe(true);
  });

  it("does not relabel a monthly chart's points as daily during a range change", async () => {
    get.mockResolvedValueOnce({ data: firstFlow }).mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ granularity }: { granularity: CashflowGranularity }) => useCashflow(1, granularity),
      { initialProps: { granularity: "monthly" } },
    );
    await waitFor(() => expect(result.current.state.data).toEqual(firstFlow));

    rerender({ granularity: "daily" });

    expect(result.current.state.data).toBeNull();
    expect(result.current.state.status).toBe("loading");
  });

  it("ignores a slower response from a previously selected business", async () => {
    const first = deferred<{ data: typeof firstFlow }>();
    const second = deferred<{ data: typeof secondFlow }>();
    get.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook(({ businessId }) => useCashflow(businessId, "monthly"), {
      initialProps: { businessId: 1 },
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender({ businessId: 2 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    await act(async () => { second.resolve({ data: secondFlow }); });
    await waitFor(() => expect(result.current.state.data).toEqual(secondFlow));
    await act(async () => { first.resolve({ data: firstFlow }); });

    expect(result.current.state.data).toEqual(secondFlow);
  });

  it("clears recent records while a new period is unresolved and after that period's request fails", async () => {
    const pending = deferred<{ data: typeof firstRecords }>();
    get.mockResolvedValueOnce({ data: firstRecords }).mockImplementationOnce(() => pending.promise);
    const september = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
    const august = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    const { result, rerender } = renderHook(
      ({ range, ready }) => useRecentRecords(1, range, ready),
      { initialProps: { range: september, ready: true } },
    );
    await waitFor(() => expect(result.current.state.data).toEqual(firstRecords));

    rerender({ range: august, ready: false });
    expect(result.current.state.data).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);

    rerender({ range: august, ready: true });
    expect(result.current.state.data).toBeNull();
    await act(async () => { pending.reject(new Error("offline")); });
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state.data).toBeNull();
  });

  it("clears the last business's feed when there is no active business", async () => {
    get.mockResolvedValueOnce({ data: firstFlow });
    const { result, rerender } = renderHook(
      ({ businessId }: { businessId: number | null }) => useCashflow(businessId, "monthly"),
      { initialProps: { businessId: 1 as number | null } },
    );
    await waitFor(() => expect(result.current.state.data).toEqual(firstFlow));

    rerender({ businessId: null });

    expect(result.current.state.data).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retains same-scope data with an error status when a refresh fails", async () => {
    get.mockResolvedValueOnce({ data: firstFlow }).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useCashflow(1, "monthly"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    act(() => result.current.reload());

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state.data).toEqual(firstFlow);
  });
});

describe("optional recurring schedule availability", () => {
  it("treats a disabled recurring endpoint as unavailable instead of an empty schedule", async () => {
    get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    const { result } = renderHook(() => useUpcomingExpenses(1));

    await waitFor(() => expect(result.current.state.status).toBe("unavailable"));

    expect(result.current.state.data).toBeNull();
  });

  it("keeps a temporary failure retryable and can recover to a genuinely empty schedule", async () => {
    get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } }).mockResolvedValueOnce({ data: [] });
    const { result } = renderHook(() => useUpcomingExpenses(1));
    await waitFor(() => expect(result.current.state.status).toBe("error"));

    act(() => result.current.reload());

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state.data).toEqual([]);
  });
});

describe("dashboard feeds after the owner returns to the tab", () => {
  // Only Date is faked: the cache ages entries by Date.now, waitFor needs real timers.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-18T09:00:00Z")); });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  function returnToTab() {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  }

  it("keeps a read that is still inside its cache window without fetching", async () => {
    get.mockResolvedValue({ data: firstFlow });
    const { result } = renderHook(() => useCashflow(1, "monthly"));
    await waitFor(() => expect(result.current.state.data).toEqual(firstFlow));

    vi.setSystemTime(new Date("2026-10-18T09:00:10Z"));
    await act(async () => { returnToTab(); });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fetches a stale read once on return and shows what changed elsewhere", async () => {
    get.mockResolvedValueOnce({ data: firstFlow }).mockResolvedValueOnce({ data: secondFlow });
    const { result } = renderHook(() => useCashflow(1, "monthly"));
    await waitFor(() => expect(result.current.state.data).toEqual(firstFlow));

    vi.setSystemTime(new Date("2026-10-18T09:05:00Z"));
    await act(async () => { returnToTab(); });

    await waitFor(() => expect(result.current.state.data).toEqual(secondFlow));
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]![1]).toMatchObject({ params: { businessProfileId: 1, granularity: "monthly" } });
  });

  it("does nothing while the tab stays hidden", async () => {
    get.mockResolvedValue({ data: firstFlow });
    const { result } = renderHook(() => useCashflow(1, "monthly"));
    await waitFor(() => expect(result.current.state.data).toEqual(firstFlow));

    vi.setSystemTime(new Date("2026-10-18T09:05:00Z"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(get).toHaveBeenCalledTimes(1);
  });
});
