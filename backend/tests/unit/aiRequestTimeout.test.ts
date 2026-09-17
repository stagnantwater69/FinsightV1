import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every model call has to carry a deadline, the way the OCR services' calls
 * already do. Without one, undici's default applies: a connection that is
 * accepted and then goes quiet holds the request for ~300s, and because each
 * of these paths chains Gemini into an OpenRouter fallback, a single stall
 * cost about ten minutes before the caller learnt anything.
 *
 * What is asserted is the deadline and the graceful result, not what a model
 * says — answer quality belongs to tests/ai-quality's rubric, which runs
 * against a live provider and is deliberately outside CI.
 */

vi.mock("../../src/config/env", () => ({
  env: {
    GOOGLE_GEMINI_API_KEY: "test-gemini-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
  },
}));

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    expenseCategory: { findMany: vi.fn(async () => [{ id: 1, name: "Inventory" }]) },
  },
}));

vi.mock("../../src/lib/ownership", () => ({
  requireOwnedBusinessProfile: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../../src/lib/categoryHistory", () => ({
  loadConfirmedCategoryHistory: vi.fn(async () => []),
  categoryFromHistory: vi.fn(() => null),
}));

vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { askFinSight, categoriseReceiptItems, reviewPlannedPurchase, suggestCategoryForDescription } =
  await import("../../src/services/ai.service");

/**
 * Fails the round trip immediately but records the signal it was handed, so
 * the chain runs at test speed. The deadline itself is `AbortSignal.timeout`,
 * whose behaviour is Node's; what regressed here was never passing one.
 */
function capturingFetch(seen: (AbortSignal | undefined)[]) {
  return (_input: unknown, init?: RequestInit) => {
    seen.push(init?.signal ?? undefined);
    return Promise.reject(new Error("connection reset"));
  };
}

function expectBothLegsBounded(seen: (AbortSignal | undefined)[]) {
  // Gemini, then the OpenRouter fallback.
  expect(seen).toHaveLength(2);
  for (const signal of seen) {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI request deadlines", () => {
  it("bounds both legs of an Ask FinSight call and still answers the owner", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", capturingFetch(seen));

    const result = await askFinSight({
      question: "Why did my expenses rise?",
      context: "Expenses rose 20% this month.",
      module: "EXPENSE_INSIGHT",
    });

    expectBothLegsBounded(seen);
    expect(result.provider).toBe("unavailable");
  });

  it("bounds both legs of the single-category classifier", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", capturingFetch(seen));

    expect(await suggestCategoryForDescription(1, 1, "new rice sacks")).toBeNull();
    expectBothLegsBounded(seen);
  });

  it("bounds both legs of the receipt item categoriser", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", capturingFetch(seen));

    expect(await categoriseReceiptItems(["Rice 25kg"], ["Inventory"])).toEqual([]);
    expectBothLegsBounded(seen);
  });

  it("bounds both legs of the planned-purchase review", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", capturingFetch(seen));

    expect(await reviewPlannedPurchase("a second freezer", 45_000, "sari-sari store")).toBeNull();
    expectBothLegsBounded(seen);
  });

  it("abandons a connection that is accepted and then never answers", async () => {
    // The shape the default undici timeout used to sit on for five minutes.
    // A tight signal of this test's own proves the chain treats an aborted
    // call as an ordinary provider failure rather than propagating it.
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const local = AbortSignal.timeout(20);
        local.addEventListener("abort", () => reject(local.reason));
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));

    const result = await askFinSight({
      question: "Why did my expenses rise?",
      context: "Expenses rose 20% this month.",
      module: "EXPENSE_INSIGHT",
    });

    expect(result.provider).toBe("unavailable");
    expect(result.answer).toContain("can't reach its AI assistant");
  });
});
