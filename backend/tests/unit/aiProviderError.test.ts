import { describe, expect, it } from "vitest";
import { AiProviderError, providerErrorCode, providerHttpError } from "../../src/lib/aiProviderError";

const LEAKY = "Rice for Aling Nena PHP 1,250 owner@example.ph";

describe("AI provider errors", () => {
  it("keeps Gemini's status code and drops its message", async () => {
    const body = JSON.stringify({
      error: { code: 400, status: "INVALID_ARGUMENT", message: `Invalid value at contents: ${LEAKY}` },
    });
    const error = await providerHttpError("gemini", new Response(body, { status: 400 }));
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).toBe("Gemini responded 400 (INVALID_ARGUMENT)");
    expect(error.message).not.toContain("Aling Nena");
    expect(error.httpStatus).toBe(400);
    expect(error.providerCode).toBe("INVALID_ARGUMENT");
  });

  it("keeps OpenRouter's numeric code", async () => {
    const body = JSON.stringify({ error: { code: 429, message: `Rate limited while processing: ${LEAKY}` } });
    const error = await providerHttpError("openrouter", new Response(body, { status: 429 }));
    expect(error.message).toBe("OpenRouter responded 429 (429)");
  });

  it("refuses a code that is free text rather than an enum", () => {
    expect(providerErrorCode(JSON.stringify({ error: { status: LEAKY } }))).toBeUndefined();
    expect(providerErrorCode(JSON.stringify({ error: { code: "has spaces in it" } }))).toBeUndefined();
  });

  it("names only the status when the body is not JSON", async () => {
    const error = await providerHttpError("gemini", new Response(`<html>${LEAKY}</html>`, { status: 502 }));
    expect(error.message).toBe("Gemini responded 502");
  });
});
