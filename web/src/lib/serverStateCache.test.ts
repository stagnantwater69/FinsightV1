import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_STATE_MAX_ENTRIES,
  beginServerStateSession,
  endServerStateSession,
  invalidateServerState,
  isServerStateAffected,
  peekServerState,
  queryServerState,
  serverStateCacheStats,
  subscribeToServerState,
  type ServerStateScope,
} from "./serverStateCache";

function scope(overrides: Partial<ServerStateScope> = {}): ServerStateScope {
  return {
    resource: "/records/search",
    businessProfileId: 1,
    period: { kind: "month", month: "2026-09" },
    filters: { type: "expense", categoryId: 3 },
    sort: { by: "date", order: "desc" },
    pagination: { cursor: null, limit: 25 },
    params: { q: "rice" },
    tags: ["records"],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => beginServerStateSession("user-a"));

afterEach(() => {
  vi.restoreAllMocks();
  endServerStateSession();
});

describe("server-state cache scoping", () => {
  it("separates session, business, period, filter, sort, and cursor keys", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal, value: string) => value);
    const variants = [
      scope(),
      scope({ businessProfileId: 2 }),
      scope({ period: { kind: "month", month: "2026-08" } }),
      scope({ filters: { type: "sales", categoryId: null } }),
      scope({ sort: { by: "amount", order: "asc" } }),
      scope({ pagination: { cursor: "next-page", limit: 25 } }),
    ];

    for (const [index, key] of variants.entries()) {
      expect(await queryServerState(key, (signal) => fetcher(signal, `value-${index}`))).toBe(`value-${index}`);
    }
    for (const [index, key] of variants.entries()) {
      expect(await queryServerState(key, (signal) => fetcher(signal, "unexpected"))).toBe(`value-${index}`);
    }
    expect(fetcher).toHaveBeenCalledTimes(variants.length);

    beginServerStateSession("user-b");
    expect(await queryServerState(scope(), (signal) => fetcher(signal, "user-b"))).toBe("user-b");
    expect(fetcher).toHaveBeenCalledTimes(variants.length + 1);
  });

  it("deduplicates concurrent reads for an identical scope", async () => {
    const held = deferred<string>();
    const fetcher = vi.fn(() => held.promise);

    const first = queryServerState(scope(), fetcher);
    const second = queryServerState(scope(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    held.resolve("shared");
    await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"]);
  });

  it("retains stale data while one background refresh is in flight", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await queryServerState(scope(), async () => "cached", { staleTimeMs: 10, cacheTimeMs: 1_000 });

    now = 1_011;
    expect(peekServerState<string>(scope())).toMatchObject({ data: "cached", stale: true });

    const held = deferred<string>();
    const refresh = queryServerState(scope(), () => held.promise);
    expect(peekServerState<string>(scope())).toMatchObject({ data: "cached", stale: true });

    held.resolve("fresh");
    await expect(refresh).resolves.toBe("fresh");
    expect(peekServerState<string>(scope())).toMatchObject({ data: "fresh", stale: false });
  });

  it("retains stale cached data when a weak-network refresh fails", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await queryServerState(scope(), async () => "last-known-good", { staleTimeMs: 10, cacheTimeMs: 1_000 });

    now = 1_011;
    await expect(
      queryServerState(scope(), async () => {
        throw new Error("Network Error");
      }),
    ).rejects.toThrow("Network Error");

    expect(peekServerState<string>(scope())).toMatchObject({
      data: "last-known-good",
      stale: true,
    });
  });

  it("clears data and cancels in-flight work when the session ends", async () => {
    await queryServerState(scope({ resource: "/cached" }), async () => "private");
    let aborted = false;
    const pending = queryServerState(scope({ resource: "/pending" }), (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );

    endServerStateSession();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
    expect(serverStateCacheStats()).toEqual({ entries: 0, inFlight: 0, activeUserId: null });
  });

  it("invalidates and cancels only matching scoped work", async () => {
    const target = scope({ resource: "/records/target", businessProfileId: 1 });
    const other = scope({ resource: "/records/other", businessProfileId: 2 });
    await queryServerState(target, async () => "old-target");
    await queryServerState(other, async () => "keep-other");

    let aborted = false;
    const pendingTarget = queryServerState(
      scope({ resource: "/records/pending", businessProfileId: 1 }),
      (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );

    invalidateServerState({ businessProfileId: 1, resourcePrefix: "/records" });
    await expect(pendingTarget).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
    expect(peekServerState(target)).toBeNull();
    expect(peekServerState<string>(other)?.data).toBe("keep-other");
  });

  it("publishes scoped invalidations to mounted consumers and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToServerState(listener);
    const target = { businessProfileId: 1, resourcePrefix: "/records", tags: ["records"] };

    invalidateServerState(target);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ type: "invalidate", target });
    expect(isServerStateAffected(scope(), target)).toBe(true);
    expect(isServerStateAffected(scope({ businessProfileId: 2 }), target)).toBe(false);

    unsubscribe();
    invalidateServerState(target);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not let an aborted fetcher that resolves late overwrite its replacement", async () => {
    const oldRequest = deferred<string>();
    const consumer = new AbortController();
    const oldResult = queryServerState(scope(), () => oldRequest.promise, { signal: consumer.signal });
    consumer.abort();
    await expect(oldResult).rejects.toMatchObject({ name: "AbortError" });

    await expect(queryServerState(scope(), async () => "replacement")).resolves.toBe("replacement");
    oldRequest.resolve("stale");
    await oldRequest.promise;
    await Promise.resolve();

    expect(peekServerState<string>(scope())?.data).toBe("replacement");
  });

  it("rejects an invalidated consumer even when its fetcher ignores abort and resolves late", async () => {
    const oldRequest = deferred<string>();
    const oldResult = queryServerState(scope(), () => oldRequest.promise);

    invalidateServerState({ businessProfileId: 1, resourcePrefix: "/records" });
    await expect(oldResult).rejects.toMatchObject({ name: "AbortError" });
    await expect(queryServerState(scope(), async () => "fresh")).resolves.toBe("fresh");

    oldRequest.resolve("stale");
    await oldRequest.promise;
    await Promise.resolve();
    expect(peekServerState<string>(scope())?.data).toBe("fresh");
  });

  it("still caches unrelated in-flight data across a scoped invalidation", async () => {
    const unrelated = scope({ resource: "/dashboard/summary", tags: ["dashboard"] });
    const held = deferred<string>();
    const pending = queryServerState(unrelated, () => held.promise);

    invalidateServerState({ businessProfileId: 1, resourcePrefix: "/records" });
    held.resolve("unrelated-result");

    await expect(pending).resolves.toBe("unrelated-result");
    expect(peekServerState<string>(unrelated)?.data).toBe("unrelated-result");
  });

  it("keeps the cache within its configured entry bound", async () => {
    for (let index = 0; index <= SERVER_STATE_MAX_ENTRIES; index += 1) {
      await queryServerState(scope({ params: { index } }), async () => index);
    }
    expect(serverStateCacheStats().entries).toBe(SERVER_STATE_MAX_ENTRIES);
  });
});
