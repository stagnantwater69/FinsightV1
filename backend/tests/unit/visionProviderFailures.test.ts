import { describe, expect, it } from "vitest";
import {
  classifyVisionHttpFailure,
  classifyVisionTransportFailure,
  parseRetryAfterMs,
} from "../../src/services/visionOcr.service";

describe("Gemini provider failure classification", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [400, "http"],
  ] as const)("classifies HTTP %i as %s", (status, kind) => {
    expect(classifyVisionHttpFailure(status, null).kind).toBe(kind);
  });

  it("parses both Retry-After formats and bounds excessive delays", () => {
    const now = Date.parse("2026-09-28T00:00:00.000Z");

    expect(parseRetryAfterMs("45", now)).toBe(45_000);
    expect(parseRetryAfterMs("Mon, 28 Sep 2026 00:02:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfterMs("999999", now)).toBe(86_400_000);
    expect(parseRetryAfterMs("not-a-date", now)).toBeNull();
  });

  it("keeps transport, cancellation, and timeout distinct", () => {
    expect(classifyVisionTransportFailure(new Error("offline")).kind).toBe("transport");
    expect(classifyVisionTransportFailure(new DOMException("cancelled", "AbortError")).kind).toBe("cancelled");
    expect(classifyVisionTransportFailure(new DOMException("deadline", "TimeoutError")).kind).toBe("timeout");
  });
});
