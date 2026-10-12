import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { getErrorMessage, getRetryAfterSeconds } from "./errors";
import { api } from "./api";

/**
 * WHAT A FAILED REQUEST SAYS OUT LOUD.
 *
 * The case this exists for is the one that reached a real user: a password
 * recovery request that was still being rate-limit-checked against a hosted
 * database, which the browser abandoned after six seconds. The server was
 * healthy and about to answer; the screen said "Network Error". That is axios's
 * internal wording leaking through `err.message` as though it were FinSight's
 * own diagnosis, and it points the reader at their wifi when their wifi is fine.
 */

function withResponse(status: number, data: unknown, headers: Record<string, string> | AxiosHeaders = {}): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", config as never, {}, {
    status,
    statusText: "",
    data,
    headers,
    config: config as never,
  });
}

/** Axios's shape for "no answer ever came back" — network drop or timeout. */
function withoutResponse(message: string, code: string): AxiosError {
  return new AxiosError(message, code, { headers: new AxiosHeaders() } as never, {});
}

describe("getErrorMessage", () => {
  it("prefers what the server actually said", () => {
    expect(getErrorMessage(withResponse(429, { error: "Too many attempts. Try again in 42 minutes." }))).toBe(
      "Too many attempts. Try again in 42 minutes.",
    );
  });

  it("does not put axios's own words on screen when nothing answered", () => {
    for (const err of [
      withoutResponse("Network Error", "ERR_NETWORK"),
      withoutResponse("timeout of 90000ms exceeded", "ECONNABORTED"),
    ]) {
      const message = getErrorMessage(err);
      expect(message).toBe("We couldn't reach FinSight. Check your connection and try again.");
      expect(message).not.toMatch(/network error|timeout|ms exceeded/i);
    }
  });

  /**
   * A response WITH a status but no `error` field is still a response — the
   * server was reached, so the "we couldn't reach FinSight" wording would be a
   * lie. It falls through to the generic message instead.
   */
  it("does not claim unreachability for a server that answered", () => {
    expect(getErrorMessage(withResponse(500, {}))).toBe(
      "FinSight is temporarily unavailable. Please try again in a moment.",
    );
  });

  it("does not expose gateway or Axios wording when a proxy answers without JSON", () => {
    const message = getErrorMessage(withResponse(502, ""));

    expect(message).toBe("FinSight is temporarily unavailable. Please try again in a moment.");
    expect(message).not.toMatch(/request failed|status code|502/i);
  });

  it("passes ordinary errors through", () => {
    expect(getErrorMessage(new Error("Boom"))).toBe("Boom");
    expect(getErrorMessage("not an error")).toBe("Something went wrong. Please try again.");
  });
});

describe("rate-limit retry timing", () => {
  const now = Date.parse("2026-10-12T08:00:00Z");

  it.each([0, 1, 42, 900])("reads %i seconds from Retry-After", (seconds) => {
    const error = withResponse(429, { error: "Slow down." }, { "retry-after": String(seconds) });
    expect(getRetryAfterSeconds(error, now)).toBe(seconds);
    expect(getErrorMessage(error)).toBe(`Too many requests. Try again in ${seconds}s.`);
  });

  it("reads AxiosHeaders case-insensitively and uses the header before the body", () => {
    const error = withResponse(429, { retryAfterSeconds: 99 }, new AxiosHeaders({ "Retry-After": "12" }));
    expect(getRetryAfterSeconds(error, now)).toBe(12);
  });

  it("rounds HTTP-date delays upward and accepts an already elapsed retry date", () => {
    expect(getRetryAfterSeconds(withResponse(429, {}, { "retry-after": "Mon, 12 Oct 2026 08:00:03 GMT" }), now + 500)).toBe(3);
    expect(getRetryAfterSeconds(withResponse(429, {}, { "retry-after": "Mon, 12 Oct 2026 07:59:59 GMT" }), now)).toBe(0);
  });

  it.each([undefined, "not a delay", "-1", "1.5", "Infinity"])("uses structured retry seconds when the header is %s", (header) => {
    const error = withResponse(429, { retryAfterSeconds: 8 }, header === undefined ? {} : { "retry-after": header });
    expect(getRetryAfterSeconds(error, now)).toBe(8);
    expect(getErrorMessage(error)).toBe("Too many requests. Try again in 8s.");
  });

  it.each([-1, 1.5, "12", null])("rejects invalid structured retry delay %s", (retryAfterSeconds) => {
    const error = withResponse(429, { retryAfterSeconds });
    expect(getRetryAfterSeconds(error, now)).toBeNull();
    expect(getErrorMessage(error)).toBe("Too many requests. Please wait a moment and try again.");
  });

  it("keeps headerless server guidance and does not misclassify other errors", () => {
    expect(getErrorMessage(withResponse(429, { error: "Wait until your import finishes." }))).toBe("Wait until your import finishes.");
    expect(getErrorMessage(withResponse(400, { error: "Choose a category." }, { "retry-after": "9" }))).toBe("Choose a category.");
    expect(getRetryAfterSeconds(new Error("Offline"), now)).toBeNull();
  });
});

describe("the api client", () => {
  /**
   * A CEILING, NOT A DEADLINE. Without any timeout a request the server never
   * answers spins forever with nothing on screen to explain it. But the slowest
   * things this app does are real work — receipt OCR, a vision model, a CSV
   * parse, a language-model answer — so a tidy-looking 10 or 15 seconds would
   * cancel a working feature and report it as broken. Pinned so nobody
   * "tightens" it without reading why.
   */
  it("waits long enough for the slow work this app really does", () => {
    expect(api.defaults.timeout).toBe(90_000);
  });
});
