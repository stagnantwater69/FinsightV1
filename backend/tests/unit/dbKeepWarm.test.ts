import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepWarmOptionsFromEnv, startDbKeepWarm } from "../../src/lib/dbKeepWarm";

function client(result: () => Promise<unknown> = async () => [{ ok: 1 }]) {
  const queryRaw = vi.fn((..._args: unknown[]) => result());
  return { queryRaw, client: { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => queryRaw(query, ...values) } };
}

describe("database keep-warm", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("touches every connection each round, and stops when asked", () => {
    const { queryRaw, client: fake } = client();
    const stop = startDbKeepWarm(fake, { connections: 3, intervalMs: 15_000 });

    vi.advanceTimersByTime(14_999);
    expect(queryRaw).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(15_000);
    expect(queryRaw).toHaveBeenCalledTimes(6);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(queryRaw).toHaveBeenCalledTimes(6);
  });

  it("swallows a failed touch, leaving reconnection to the next real query", async () => {
    const { queryRaw, client: fake } = client(async () => { throw new Error("pooler dropped the socket"); });
    const stop = startDbKeepWarm(fake, { connections: 1, intervalMs: 1_000 });

    vi.advanceTimersByTime(1_000);
    await vi.runOnlyPendingTimersAsync();

    expect(queryRaw).toHaveBeenCalled();
    stop();
  });

  it("does nothing when keep-warm is off", () => {
    const { queryRaw, client: fake } = client();
    startDbKeepWarm(fake, { connections: 0, intervalMs: 1_000 });
    vi.advanceTimersByTime(10_000);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("keep-warm settings", () => {
  it("warms the whole API pool, more often than idle sessions were dropped", () => {
    expect(keepWarmOptionsFromEnv({ DATABASE_POOL_SIZE: "8" })).toEqual({ connections: 8, intervalMs: 15_000 });
  });

  it("caps the count and falls back when no pool size is set", () => {
    expect(keepWarmOptionsFromEnv({ DATABASE_POOL_SIZE: "40" }).connections).toBe(10);
    expect(keepWarmOptionsFromEnv({}).connections).toBe(5);
  });

  it("honours an override, including 0 to turn it off", () => {
    expect(keepWarmOptionsFromEnv({ DATABASE_POOL_SIZE: "8", DATABASE_KEEP_WARM_CONNECTIONS: "2" }).connections).toBe(2);
    expect(keepWarmOptionsFromEnv({ DATABASE_POOL_SIZE: "8", DATABASE_KEEP_WARM_CONNECTIONS: "0" }).connections).toBe(0);
    expect(keepWarmOptionsFromEnv({ DATABASE_KEEP_WARM_CONNECTIONS: "nonsense" }).connections).toBe(0);
  });
});
