import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { pollUntilRead, ReceiptReadFailure, SCAN_POLL_MAX_ATTEMPTS } = await import(
  "../src/screens/records/scanReceipt/helpers"
);
import type { ReceiptScanResult } from "../src/screens/records/scanReceipt/types";

const POLL_INTERVAL_MS = 1500;

function scan(overrides: Partial<ReceiptScanResult> = {}): ReceiptScanResult {
  return {
    id: 7,
    businessProfileId: 1,
    receiptBatchId: null,
    receiptOrdinal: null,
    scanRevision: 0,
    extractedDate: null,
    extractedVendor: null,
    extractedDescription: null,
    extractedAmount: null,
    confirmationStatus: "Pending",
    processingStatus: "Processing",
    items: [],
    ...overrides,
  };
}

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Queues one fetch answer per poll, in order. */
function replies(queue: Response[]) {
  const stub = vi.fn(async () => queue.shift() ?? answer(200, scan()));
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

function watch<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as unknown };
  const done = promise.then(
    (value) => { state.settled = true; state.value = value; },
    (err) => { state.settled = true; state.value = err; },
  );
  return { state, done };
}

describe("pollUntilRead survives a transient failure", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch; });

  it("keeps waiting after two dropped polls and returns the finished scan", async () => {
    replies([
      answer(500, { error: "Internal server error" }),
      answer(503, { error: "FinSight can't reach its database right now." }),
      answer(200, scan({ processingStatus: "Complete" })),
    ]);

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await watched.done;

    expect((watched.state.value as ReceiptScanResult).processingStatus).toBe("Complete");
  });

  it("gives up once three polls in a row fail", async () => {
    replies([
      answer(500, { error: "Internal server error" }),
      answer(500, { error: "Internal server error" }),
      answer(500, { error: "Internal server error" }),
      answer(200, scan({ processingStatus: "Complete" })),
    ]);

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    await watched.done;

    expect((watched.state.value as { status: number }).status).toBe(500);
  });

  it("resets the tolerance after a poll that answers", async () => {
    replies([
      answer(500, { error: "Internal server error" }),
      answer(500, { error: "Internal server error" }),
      answer(200, scan()),
      answer(500, { error: "Internal server error" }),
      answer(500, { error: "Internal server error" }),
      answer(200, scan({ processingStatus: "Complete" })),
    ]);

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6);
    await watched.done;

    expect((watched.state.value as ReceiptScanResult).processingStatus).toBe("Complete");
  });

  it("does not retry an answer that will not change: a 404", async () => {
    replies([answer(404, { error: "Receipt not found" })]);

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await watched.done;

    expect((watched.state.value as { status: number }).status).toBe(404);
  });

  it("ends on a Failed status without spending a retry", async () => {
    const stub = replies([answer(200, scan({ processingStatus: "Failed", processingError: "Nothing readable." }))]);

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await watched.done;

    expect(watched.state.value).toBeInstanceOf(ReceiptReadFailure);
    expect((watched.state.value as { kind: string }).kind).toBe("failed");
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("the poll's ceiling counts polls, not wall-clock time", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch; });

  /*
   * A backgrounded phone suspends timers while its clock keeps running, which
   * is what setSystemTime reproduces here: four minutes pass without a single
   * poll firing. Real backgrounding, and whether the OS suspends this app at
   * all, still needs physical-device verification.
   */
  it("still reports a scan that finishes after the clock jumped past three minutes", async () => {
    replies([
      answer(200, scan()),
      answer(200, scan()),
      answer(200, scan({ processingStatus: "Complete" })),
    ]);

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(watched.state.settled).toBe(false);

    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(watched.state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await watched.done;

    expect((watched.state.value as ReceiptScanResult).processingStatus).toBe("Complete");
  });

  it("still ends a read that never finishes, after the full run of polls", async () => {
    globalThis.fetch = vi.fn(async () => answer(200, scan())) as unknown as typeof fetch;

    const watched = watch(pollUntilRead(scan()));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * (SCAN_POLL_MAX_ATTEMPTS + 1));
    await watched.done;

    expect((watched.state.value as { kind: string }).kind).toBe("timeout");
  });
});

describe("an aborted poll stops immediately and leaves no timer running", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch; });

  it("does not sit out the rest of the interval it was waiting on", async () => {
    replies([answer(200, scan())]);
    const controller = new AbortController();

    const watched = watch(pollUntilRead(scan(), controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(watched.state.settled).toBe(true);
    await watched.done;
    expect((watched.state.value as Error).message).toBe("Receipt processing paused.");
    expect(vi.getTimerCount()).toBe(0);
  });
});
