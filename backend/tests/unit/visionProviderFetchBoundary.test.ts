import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/env", () => ({
  env: {
    GOOGLE_GEMINI_API_KEY: "test-gemini-key",
    OPENROUTER_API_KEY: "",
  },
}));

vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createGeminiReceiptAdapter } from "../../src/services/receiptScan/providerAdapters";
import { mergeReceiptProviderOutcome } from "../../src/services/receiptProviderContract";
import { localExtraction, providerRequest } from "../helpers/receiptProviderFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Gemini receipt provider fetch boundary", () => {
  it.each([
    [429, "RATE_LIMITED", "FAILED"],
    [503, "PROVIDER_SERVER_ERROR", "FAILED"],
    [400, "HTTP_ERROR", "FAILED"],
    [403, "AUTH_ERROR", "FAILED"],
  ] as const)("classifies HTTP %i without retrying the submitted extraction", async (status, outcomeCode, outcomeStatus) => {
    const fetchMock = vi.fn(async () => new Response("provider refused", {
      status,
      headers: status === 429 || status === 503 ? { "retry-after": "45" } : undefined,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const request = providerRequest();
    const local = localExtraction();

    const outcome = await createGeminiReceiptAdapter().extract(request);
    const merged = mergeReceiptProviderOutcome(local, request, outcome);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(outcome).toMatchObject({ status: outcomeStatus, outcomeCode });
    if (status === 429 || status === 503) expect(outcome.retryAfterMs).toBe(45_000);
    expect(merged).toMatchObject({
      receipt: local,
      appliedFields: [],
      providerResultAccepted: true,
      reason: "NOT_SUCCESSFUL",
    });
  });

  it("classifies a submitted timeout once and retains the deterministic fallback", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("deadline exceeded", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = providerRequest();
    const local = localExtraction();

    const outcome = await createGeminiReceiptAdapter().extract(request);
    const merged = mergeReceiptProviderOutcome(local, request, outcome);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: "AMBIGUOUS",
      outcomeCode: "TIMEOUT_AFTER_SUBMISSION",
      finalBillableUnits: null,
    });
    expect(merged.receipt).toEqual(local);
    expect(merged.appliedFields).toEqual([]);
  });

  it("treats an unusable 200 response as terminal and does not call a verifier", async () => {
    const fetchMock = vi.fn(async () => Response.json({ candidates: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: "FAILED",
      outcomeCode: "INVALID_RESULT",
      finalBillableUnits: 1,
    });
  });
});
