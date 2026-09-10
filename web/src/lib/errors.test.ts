import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./errors";
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

function withResponse(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", config as never, {}, {
    status,
    statusText: "",
    data,
    headers: {},
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
    expect(getErrorMessage(withResponse(500, {}))).not.toMatch(/couldn't reach/i);
  });

  it("passes ordinary errors through", () => {
    expect(getErrorMessage(new Error("Boom"))).toBe("Boom");
    expect(getErrorMessage("not an error")).toBe("Something went wrong. Please try again.");
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
