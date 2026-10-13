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

import { extractReceiptWithVision, geminiAnswerTruncated } from "../../src/services/visionOcr.service";
import { createGeminiReceiptAdapter } from "../../src/services/receiptScan/providerAdapters";
import { providerRequest } from "../helpers/receiptProviderFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const page = { buffer: Buffer.from("receipt"), mimetype: "image/jpeg" };

/** An answer the model stopped writing when it ran out of output tokens. */
function truncatedAnswer() {
  const items = Array.from({ length: 40 }, (_, index) =>
    `{"name":"ITEM ${index}","quantity":1,"amount":10.25,"pageNumber":1,"sourceText":"00000${index} 1 10.25 10.25T"}`);
  return Response.json({
    candidates: [{
      finishReason: "MAX_TOKENS",
      content: { parts: [{ text: `{"date":null,"vendor":"GAISANO GRAND","total":7967.25,"items":[${items.join(",")},{"name":"ITEM` }] },
    }],
  });
}

describe("room for a long receipt's answer", () => {
  it("asks for enough output to list every item the schema allows", async () => {
    const fetchMock = vi.fn(async () => truncatedAnswer());
    vi.stubGlobal("fetch", fetchMock);
    await extractReceiptWithVision([page, page, page]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
    const body = JSON.parse(init.body) as { generationConfig: { maxOutputTokens: number } };
    // 100 items at an estimated 60-80 tokens each; the old 4,000 fit about 50.
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8_000);
  });

  it("rejects an answer cut off at the token limit as truncated, never half-read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => truncatedAnswer()));
    const outcome = await extractReceiptWithVision([page, page, page]);
    expect(outcome).toMatchObject({ receipt: null, rejectReason: "truncated", failure: null });
  });

  it("treats a truncated answer as an invalid result without asking the verifier", async () => {
    const fetchMock = vi.fn(async () => truncatedAnswer());
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "FAILED", outcomeCode: "INVALID_RESULT", finalBillableUnits: 1 });
  });

  it("recognises the finish reason only where Gemini reports it", () => {
    expect(geminiAnswerTruncated({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toBe(true);
    expect(geminiAnswerTruncated({ candidates: [{ finishReason: "STOP" }] })).toBe(false);
    expect(geminiAnswerTruncated({ candidates: [] })).toBe(false);
    expect(geminiAnswerTruncated(null)).toBe(false);
  });
});
