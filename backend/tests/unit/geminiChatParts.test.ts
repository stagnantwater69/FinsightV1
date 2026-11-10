import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Gemini can return one reply in several text parts. Reading only the first
 * part showed owners a reply cut off mid-sentence (seen in the live eval as
 * "PHP 7,900.00 [fact:"). And a reply that stops early is logged, so a
 * cut-off in production says why.
 */

vi.mock("../../src/config/env", () => ({ env: { GOOGLE_GEMINI_API_KEY: "test-gemini-key", OPENROUTER_API_KEY: "test-openrouter-key" } }));
const warn = vi.fn();
vi.mock("../../src/config/logger", () => ({ logger: { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() } }));

const { askFinSight } = await import("../../src/services/ai.service");

function gemini(candidate: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [candidate] }) })));
}

afterEach(() => { vi.unstubAllGlobals(); warn.mockReset(); });

describe("Gemini chat replies", () => {
  it("joins every text part of a reply, leaving out thought parts", async () => {
    gemini({ finishReason: "STOP", content: { parts: [
      { text: "planning…", thought: true },
      { text: "In December 2021, total expenses were PHP 7,900.00 [fact:" },
      { text: "f16]; in January 2022, PHP 8,750.00 [fact:f17]." },
    ] } });
    const result = await askFinSight({ context: "", question: "Compare January and December" });
    expect(result.answer).toBe("In December 2021, total expenses were PHP 7,900.00 [fact:f16]; in January 2022, PHP 8,750.00 [fact:f17].");
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a reply that stopped early", async () => {
    gemini({ finishReason: "MAX_TOKENS", content: { parts: [{ text: "In December 2021, total" }] } });
    const result = await askFinSight({ context: "", question: "Compare January and December" });
    expect(result.answer).toBe("In December 2021, total");
    expect(warn).toHaveBeenCalledWith({ finishReason: "MAX_TOKENS", answerLength: 23 }, "Gemini chat reply did not finish normally");
  });
});
