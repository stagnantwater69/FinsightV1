import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * A provider that rejects a request can quote it back in the error body. The
 * chat falls back from Gemini to OpenRouter and logs each failure; what is
 * asserted is that neither log line carries the owner's question or context.
 */

vi.mock("../../src/config/env", () => ({
  env: { GOOGLE_GEMINI_API_KEY: "test-gemini-key", OPENROUTER_API_KEY: "test-openrouter-key" },
}));

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../src/config/logger", () => ({
  logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { askFinSight } = await import("../../src/services/ai.service");

const QUESTION = "Can I afford a new freezer for Aling Nena's store?";
const CONTEXT = "Sales this month: PHP 84,200. Owner: nena@example.ph";

afterEach(() => {
  vi.unstubAllGlobals();
  error.mockReset();
});

describe("AI provider failures in the logs", () => {
  it("logs both failed providers without the question, context or provider message", async () => {
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const echoed = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: `Bad request: ${echoed}` } }),
        { status: 400 },
      );
    });

    const result = await askFinSight({ context: CONTEXT, question: QUESTION });

    expect(result.provider).toBe("unavailable");
    expect(error).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(error.mock.calls, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    );
    expect(logged).toContain("Gemini responded 400 (INVALID_ARGUMENT)");
    expect(logged).toContain("OpenRouter responded 400 (INVALID_ARGUMENT)");
    for (const leak of ["Aling Nena", "84,200", "nena@example.ph", "Bad request"]) {
      expect(logged).not.toContain(leak);
    }
  });
});
