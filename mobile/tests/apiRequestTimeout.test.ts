import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { api, errorMessage } = await import("../src/lib/api");

const JSON_TIMEOUT_MS = 90_000;

/** A fetch that answers nothing until its signal aborts: a half-open connection. */
function stalledFetch() {
  const signals: (AbortSignal | undefined)[] = [];
  const stub = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
    signals.push(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail);
    });
  });
  return { stub, signals };
}

/** Tracks settlement so a still-pending request is a failure, not a hung test. */
function watch<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as unknown };
  const done = promise.then(
    (value) => { state.settled = true; state.value = value; },
    (err) => { state.settled = true; state.value = err; },
  );
  return { state, done };
}

describe("JSON requests give up instead of hanging", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch; });

  it("fails a stalled GET once the timeout passes, rather than waiting for ever", async () => {
    const { stub } = stalledFetch();
    globalThis.fetch = stub as unknown as typeof fetch;

    const watched = watch(api.get("/records/receipts/1"));
    await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS - 1);
    expect(watched.state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await watched.done;
    expect(watched.state.settled).toBe(true);
    expect(errorMessage(watched.state.value)).toMatch(/timed out/);
    expect((watched.state.value as { status: number }).status).toBe(0);
  });

  it("applies the same ceiling to a stalled POST", async () => {
    const { stub } = stalledFetch();
    globalThis.fetch = stub as unknown as typeof fetch;

    const watched = watch(api.post("/records/receipts/1/confirm", {}));
    await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS + 1);
    await watched.done;
    expect(errorMessage(watched.state.value)).toMatch(/timed out/);
  });

  it("leaves no timer behind once a request answers", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => "{}",
    })) as unknown as typeof fetch;

    await api.get("/dashboard");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cancellation reaches every verb, not just GET", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it.each([
    ["get", (signal: AbortSignal) => api.get("/auth/me", undefined, signal)],
    ["post", (signal: AbortSignal) => api.post("/records/receipts/1/confirm", {}, signal)],
    ["put", (signal: AbortSignal) => api.put("/business-profiles/1/schedule", {}, signal)],
    ["patch", (signal: AbortSignal) => api.patch("/records/expenses/1", {}, undefined, signal)],
    ["delete", (signal: AbortSignal) => api.delete("/records/receipts/1", undefined, undefined, signal)],
  ])("%s stops when the caller's signal aborts", async (_verb, call) => {
    const { stub } = stalledFetch();
    globalThis.fetch = stub as unknown as typeof fetch;

    const controller = new AbortController();
    const watched = watch(call(controller.signal));
    await Promise.resolve();
    expect(watched.state.settled).toBe(false);

    controller.abort();
    await watched.done;
    expect(watched.state.settled).toBe(true);
    expect((watched.state.value as { status: number }).status).toBe(0);
  });

  it("fails at once when the signal aborted before the call", async () => {
    const { stub } = stalledFetch();
    globalThis.fetch = stub as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const watched = watch(api.post("/records/receipts/1/confirm", {}, controller.signal));
    await watched.done;
    expect((watched.state.value as { status: number }).status).toBe(0);
  });
});
