import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_STATE_MAX_ENTRIES,
  beginServerStateSession,
  clearServerStateCache,
  createServerStateKey,
  fetchServerState,
  getServerStateCacheStats,
  invalidateServerStateForMutation,
  peekServerState,
} from "../src/lib/serverStateCache";

beforeEach(() => {
  clearServerStateCache();
});

afterEach(() => {
  clearServerStateCache();
});

describe("server state cache identity", () => {
  it("canonicalizes query order while separating session, business, period, filter, and cursor", () => {
    beginServerStateSession(7);
    const path = "/records/search";
    const base = {
      businessProfileId: 1,
      periodKind: "month",
      month: "2026-08",
      keyword: "rice",
      cursor: "cursor-1",
    };
    const baseKey = createServerStateKey(path, base);

    expect(
      createServerStateKey(path, {
        cursor: "cursor-1",
        keyword: "rice",
        month: "2026-08",
        periodKind: "month",
        businessProfileId: 1,
      }),
    ).toBe(baseKey);

    const scopedKeys = [
      baseKey,
      createServerStateKey(path, { ...base, businessProfileId: 2 }),
      createServerStateKey(path, { ...base, month: "2026-09" }),
      createServerStateKey(path, { ...base, keyword: "fuel" }),
      createServerStateKey(path, { ...base, cursor: "cursor-2" }),
    ];
    expect(new Set(scopedKeys).size).toBe(scopedKeys.length);

    beginServerStateSession(7);
    expect(createServerStateKey(path, base)).not.toBe(baseKey);
    beginServerStateSession(8);
    expect(createServerStateKey(path, base)).not.toBe(baseKey);
  });

  it("drops all prior data when a session rotates or clears", async () => {
    beginServerStateSession(7);
    await fetchServerState({
      path: "/dashboard/summary",
      query: { businessProfileId: 1, month: "2026-08" },
      fetcher: async () => ({ total: 10 }),
    });
    expect(
      peekServerState("/dashboard/summary", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).not.toBeNull();

    beginServerStateSession(8);
    expect(
      peekServerState("/dashboard/summary", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();

    clearServerStateCache();
    expect(getServerStateCacheStats()).toEqual({
      entries: 0,
      inFlight: 0,
      scoped: false,
    });
    expect(createServerStateKey("/dashboard/summary", {})).toBeNull();
  });
});

describe("server state cache reads", () => {
  it("deduplicates concurrent reads for the same scoped key", async () => {
    beginServerStateSession(7);
    let finish!: (value: { total: number }) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<{ total: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const options = {
      path: "/dashboard/summary",
      query: { businessProfileId: 1, month: "2026-08" },
      fetcher,
    };

    const first = fetchServerState(options);
    const second = fetchServerState(options);
    expect(fetcher).toHaveBeenCalledTimes(1);

    finish({ total: 42 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.data).toEqual({ total: 42 });
    expect(secondResult.data).toEqual({ total: 42 });
    expect(firstResult.updatedAt).toBe(secondResult.updatedAt);
  });

  it("serves a fresh read without another fetch and lets an explicit refresh bypass it", async () => {
    beginServerStateSession(7);
    const fetcher = vi
      .fn<() => Promise<{ version: number }>>()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });
    const options = {
      path: "/insights/expense-overview",
      query: { businessProfileId: 1, month: "2026-08", view: "detail" },
      fetcher,
    };

    await fetchServerState(options);
    const cached = await fetchServerState(options);
    expect(cached.data).toEqual({ version: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const refreshed = await fetchServerState({ ...options, force: true });
    expect(refreshed.data).toEqual({ version: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the retained cache bounded", async () => {
    beginServerStateSession(7);
    for (let index = 0; index <= SERVER_STATE_MAX_ENTRIES; index += 1) {
      await fetchServerState({
        path: `/test/cache-entry-${index}`,
        fetcher: async () => index,
      });
    }

    expect(getServerStateCacheStats().entries).toBe(SERVER_STATE_MAX_ENTRIES);
    expect(peekServerState("/test/cache-entry-0")).toBeNull();
    expect(peekServerState(`/test/cache-entry-${SERVER_STATE_MAX_ENTRIES}`)).not.toBeNull();
  });
});

describe("server state mutation invalidation", () => {
  it("invalidates affected reads for one business without evicting another business or unrelated state", async () => {
    beginServerStateSession(7);
    const seed = (path: string, businessProfileId?: number) =>
      fetchServerState({
        path,
        query:
          businessProfileId === undefined
            ? {}
            : { businessProfileId, month: "2026-08" },
        fetcher: async () => ({ path, businessProfileId }),
      });

    await Promise.all([
      seed("/records/search", 1),
      seed("/dashboard/summary", 1),
      seed("/insights/expense-overview", 1),
      seed("/records/search", 2),
      seed("/notifications", 1),
      seed("/notifications", 2),
      fetchServerState({
        path: "/business-profiles/1/financial-position",
        fetcher: async () => ({ calculatedAmount: 90 }),
      }),
      fetchServerState({
        path: "/business-profiles/2/financial-position",
        fetcher: async () => ({ calculatedAmount: 180 }),
      }),
      fetchServerState({
        path: "/business-profiles",
        fetcher: async () => [{ id: 1 }, { id: 2 }],
      }),
      seed("/auth/me"),
    ]);

    invalidateServerStateForMutation("POST", "/records/expenses", {
      businessProfileId: 1,
    });

    expect(
      peekServerState("/records/search", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    expect(
      peekServerState("/dashboard/summary", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    expect(
      peekServerState("/insights/expense-overview", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    // A record can raise a notification, so the list goes with the records.
    expect(peekServerState("/notifications", { businessProfileId: 1, month: "2026-08" })).toBeNull();
    expect(peekServerState("/notifications", { businessProfileId: 2, month: "2026-08" })).not.toBeNull();
    expect(
      peekServerState("/records/search", {
        businessProfileId: 2,
        month: "2026-08",
      }),
    ).not.toBeNull();
    expect(
      peekServerState("/business-profiles/1/financial-position"),
    ).toBeNull();
    expect(
      peekServerState("/business-profiles/2/financial-position"),
    ).not.toBeNull();
    expect(peekServerState("/business-profiles")).not.toBeNull();
    expect(peekServerState("/auth/me")).not.toBeNull();
  });

  it("invalidates the expense overview after finding review changes duplicate evidence", async () => {
    beginServerStateSession(7);
    const seed = (path: string, businessProfileId: number) =>
      fetchServerState({
        path,
        query: { businessProfileId, month: "2026-08" },
        fetcher: async () => ({ path, businessProfileId }),
      });

    await Promise.all([
      seed("/insights/findings", 1),
      seed("/dashboard/summary", 1),
      seed("/insights/expense-overview", 1),
      seed("/insights/recurring-patterns", 1),
      seed("/insights/findings", 2),
      seed("/dashboard/summary", 2),
      seed("/insights/expense-overview", 2),
    ]);

    invalidateServerStateForMutation(
      "PATCH",
      "/insights/findings/42/review",
      undefined,
      { businessProfileId: 1 },
    );

    expect(
      peekServerState("/insights/findings", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    expect(
      peekServerState("/dashboard/summary", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    expect(
      peekServerState("/insights/expense-overview", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    expect(
      peekServerState("/insights/recurring-patterns", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).not.toBeNull();
    expect(
      peekServerState("/insights/findings", {
        businessProfileId: 2,
        month: "2026-08",
      }),
    ).not.toBeNull();
    expect(
      peekServerState("/dashboard/summary", {
        businessProfileId: 2,
        month: "2026-08",
      }),
    ).not.toBeNull();
    expect(
      peekServerState("/insights/expense-overview", {
        businessProfileId: 2,
        month: "2026-08",
      }),
    ).not.toBeNull();
  });

  it("uses the business id in a business-profile mutation path", async () => {
    beginServerStateSession(7);
    await Promise.all(
      [1, 2].map((businessProfileId) =>
        fetchServerState({
          path: "/insights/recovery",
          query: { businessProfileId, month: "2026-08" },
          fetcher: async () => ({ businessProfileId }),
        }),
      ),
    );

    invalidateServerStateForMutation(
      "DELETE",
      "/business-profiles/1/recovery-plans/2026-08",
    );

    expect(
      peekServerState("/insights/recovery", {
        businessProfileId: 1,
        month: "2026-08",
      }),
    ).toBeNull();
    expect(
      peekServerState("/insights/recovery", {
        businessProfileId: 2,
        month: "2026-08",
      }),
    ).not.toBeNull();
  });

  it.each(["PUT", "DELETE"])(
    "%s invalidates only the embedded-business recovery-plan cache",
    async (method) => {
      beginServerStateSession(7);
      await Promise.all(
        [1, 2].map((businessProfileId) =>
          fetchServerState({
            path: `/business-profiles/${businessProfileId}/recovery-plans`,
            query: { month: "2026-08" },
            fetcher: async () => ({ businessProfileId }),
          }),
        ),
      );

      invalidateServerStateForMutation(
        method,
        "/business-profiles/1/recovery-plans/2026-08",
      );

      expect(
        peekServerState("/business-profiles/1/recovery-plans", { month: "2026-08" }),
      ).toBeNull();
      expect(
        peekServerState("/business-profiles/2/recovery-plans", { month: "2026-08" }),
      ).not.toBeNull();
    },
  );

  it("does not invalidate before an asynchronous CSV import commits", async () => {
    beginServerStateSession(7);
    await Promise.all([
      fetchServerState({
        path: "/records/search",
        query: { businessProfileId: 1 },
        fetcher: async () => ({ version: 1 }),
      }),
      fetchServerState({
        path: "/business-profiles/1/financial-position",
        fetcher: async () => ({ calculatedAmount: 90 }),
      }),
    ]);

    invalidateServerStateForMutation(
      "POST",
      "/records/csv-imports/confirm",
      undefined,
      { businessProfileId: 1 },
      { processingStatus: "PENDING" },
    );

    expect(peekServerState("/records/search", { businessProfileId: 1 })).not.toBeNull();
    expect(peekServerState("/business-profiles/1/financial-position")).not.toBeNull();
  });

  it.each(["COMPLETE", "FAILED"])(
    "invalidates scoped record state when a CSV confirm is %s",
    async (processingStatus) => {
      beginServerStateSession(7);
      await Promise.all(
        [1, 2].flatMap((businessProfileId) =>
          ["/records/search", "/dashboard/summary", "/insights/expense-overview"].map((path) =>
            fetchServerState({
              path,
              query: { businessProfileId },
              fetcher: async () => ({ businessProfileId, path }),
            }),
          ),
        ),
      );
      await Promise.all(
        [1, 2].map((businessProfileId) =>
          fetchServerState({
            path: `/business-profiles/${businessProfileId}/financial-position`,
            fetcher: async () => ({ businessProfileId }),
          }),
        ),
      );

      invalidateServerStateForMutation(
        "POST",
        "/records/csv-imports/confirm",
        undefined,
        { businessProfileId: 1 },
        { processingStatus },
      );

      for (const path of ["/records/search", "/dashboard/summary", "/insights/expense-overview"]) {
        expect(peekServerState(path, { businessProfileId: 1 })).toBeNull();
        expect(peekServerState(path, { businessProfileId: 2 })).not.toBeNull();
      }
      expect(peekServerState("/business-profiles/1/financial-position")).toBeNull();
      expect(peekServerState("/business-profiles/2/financial-position")).not.toBeNull();
    },
  );
});
