import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn(), refreshSession: vi.fn(),
}));
vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession, refreshSession } },
}));

const apiModule = await import("../src/lib/api");
const { api, ApiError, errorMessage, getFieldErrors, setSessionEndedHandler } = apiModule;
// Session-request isolation is not committed yet; reset it only where it exists.
const invalidateApiSessionRequests = () =>
  (apiModule as { invalidateApiSessionRequests?: () => void }).invalidateApiSessionRequests?.();
const { beginServerStateSession, clearServerStateCache, fetchServerState, peekServerState } =
  await import("../src/lib/serverStateCache");

type Transport = "fetch" | "upload";
const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
const ended = vi.fn();
let response = { status: 429, body: {} as unknown, header: undefined as string | undefined, malformed: false };

class FakeXhr {
  static sent: FakeXhr[] = [];
  status = 0;
  responseText = "";
  timeout = 0;
  headers: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  getResponseHeader(name: string) { return name.toLowerCase() === "retry-after" ? response.header ?? null : null; }
  send() {
    FakeXhr.sent.push(this);
    this.status = response.status;
    this.responseText = response.malformed ? "not JSON" : JSON.stringify(response.body);
    queueMicrotask(() => this.onload?.());
  }
  abort() { this.onabort?.(); }
}

beforeEach(() => {
  // Freeze date arithmetic without replacing the transport's timeout timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T00:00:00.250Z"));
  invalidateApiSessionRequests();
  clearServerStateCache();
  beginServerStateSession("synthetic-retry-owner");
  ended.mockReset();
  getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "synthetic-access-token" } }, error: null });
  refreshSession.mockReset();
  setSessionEndedHandler(ended);
  FakeXhr.sent = [];
  response = { status: 429, body: {}, header: undefined, malformed: false };
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  globalThis.fetch = vi.fn(async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: new Headers(response.header === undefined ? {} : { "Retry-After": response.header }),
    json: async () => {
      if (response.malformed) throw new SyntaxError("Synthetic malformed body");
      return response.body;
    },
    text: async () => response.malformed ? "not JSON" : JSON.stringify(response.body),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  invalidateApiSessionRequests();
  clearServerStateCache();
  setSessionEndedHandler(null);
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
  vi.useRealTimers();
});

async function rejectRequest(transport: Transport) {
  const pending = transport === "fetch"
    ? api.patch("/records/expenses/7", { amount: 12 }, { cacheScope: { businessProfileId: 11 } })
    : api.upload("/records/receipts", new FormData(), { cacheScope: { businessProfileId: 11 } });
  const err: unknown = await pending.catch((error: unknown) => error);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: response.status });
  return err;
}

const guidance = "Please wait before retrying this request.";
const fallback = "Too many requests. Please wait a moment and try again.";
const timingCases: Array<[string, string | undefined, unknown, string]> = [
  ["header seconds precede body timing", "17", { retryAfterSeconds: 900 }, "Too many requests. Try again in 17s."],
  ["zero seconds remain valid", "0", { retryAfterSeconds: 9 }, "Too many requests. Try again in 0s."],
  ["GMT date rounds a partial second up", "Tue, 13 Oct 2026 00:00:03 GMT", { retryAfterSeconds: 9 }, "Too many requests. Try again in 3s."],
  ["past GMT date clamps to zero", "Tue, 13 Oct 2026 00:00:00 GMT", { retryAfterSeconds: 9 }, "Too many requests. Try again in 0s."],
  ["headerless numeric body timing", undefined, { retryAfterSeconds: 9 }, "Too many requests. Try again in 9s."],
  ["malformed header falls back to the body", "later", { retryAfterSeconds: 9 }, "Too many requests. Try again in 9s."],
  ["fractional header falls back to the body", "1.5", { retryAfterSeconds: 9 }, "Too many requests. Try again in 9s."],
  ["non-GMT date cannot override body timing", "Tue, 13 Oct 2026 00:00:03 +0000", { retryAfterSeconds: 9 }, "Too many requests. Try again in 9s."],
  ["numeric body strings are rejected", undefined, { error: guidance, retryAfterSeconds: "9" }, guidance],
  ["negative body timing is rejected", undefined, { error: guidance, retryAfterSeconds: -1 }, guidance],
  ["fractional body timing is rejected", undefined, { error: guidance, retryAfterSeconds: 1.5 }, guidance],
  ["unsafe body timing is rejected", undefined, { error: guidance, retryAfterSeconds: Number.MAX_SAFE_INTEGER + 1 }, guidance],
  ["server guidance remains useful without timing", undefined, { error: guidance }, guidance],
  ["missing timing and guidance use the clear fallback", undefined, {}, fallback],
];

describe.each(["fetch", "upload"] as const)("%s rate-limit response behavior", (transport) => {
  it.each(timingCases)("%s", async (_label, header, body, expected) => {
    response.header = header;
    response.body = body;
    expect(errorMessage(await rejectRequest(transport))).toBe(expected);
  });

  it.each([
    ["21", "Too many requests. Try again in 21s."],
    [undefined, fallback],
  ])("handles malformed JSON with retry header %s", async (header, expected) => {
    response.malformed = true;
    response.header = header;
    const err = await rejectRequest(transport);
    expect(errorMessage(err)).toBe(expected);
    expect((err as InstanceType<typeof ApiError>).responseBody).toBeUndefined();
  });

  it("preserves server code, body and field messages alongside cooldown guidance", async () => {
    const body = {
      error: "Validation failed", code: "RATE_LIMITED", retryAfterSeconds: 7,
      details: { fieldErrors: { amount: ["Keep the recorded amount.", "A second message."] } },
    };
    response.body = body;
    const err = await rejectRequest(transport);
    expect(errorMessage(err)).toBe("Too many requests. Try again in 7s.");
    expect(err).toMatchObject({ code: "RATE_LIMITED", responseBody: body });
    expect(getFieldErrors(err)).toEqual({ amount: "Keep the recorded amount." });
  });

  it("does not refresh, sign out, retry or invalidate cached records after rejection", async () => {
    const paths = ["/dashboard/summary", "/records/search", "/records/receipts/history"];
    for (const businessProfileId of [11, 22]) {
      for (const path of paths) await fetchServerState({
        path, query: { businessProfileId }, fetcher: async () => ({ businessProfileId, synthetic: true }),
      });
    }
    response.body = { code: "RATE_LIMITED", retryAfterSeconds: 9 };
    await rejectRequest(transport);
    expect(ended).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(transport === "fetch" ? vi.mocked(globalThis.fetch).mock.calls.length : FakeXhr.sent.length).toBe(1);
    for (const businessProfileId of [11, 22]) {
      for (const path of paths) expect(peekServerState(path, { businessProfileId })).not.toBeNull();
    }
  });

  it("does not apply retry headers to a non-429 validation response", async () => {
    response.status = 400;
    response.header = "19";
    response.body = { error: guidance, code: "INVALID_REQUEST", retryAfterSeconds: 19 };
    const err = await rejectRequest(transport);
    expect(errorMessage(err)).toBe(guidance);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", responseBody: response.body });
  });
});
