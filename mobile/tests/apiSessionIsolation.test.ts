import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRetryableFetchError } from "@supabase/supabase-js";

type SessionResult = { data: { session: { access_token: string } | null }; error: unknown };
const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionResult>>(),
  refreshSession: vi.fn<() => Promise<SessionResult>>(),
}));
vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession, refreshSession } },
}));

const transport = await import("../src/lib/api");
const { api, ApiError, setSessionEndedHandler } = transport;
const { beginServerStateSession, clearServerStateCache, fetchServerState, peekServerState } =
  await import("../src/lib/serverStateCache");

function session(token: string): SessionResult {
  return { data: { session: { access_token: token } }, error: null };
}

function replaceAccount(userId: string | null) {
  // The baseline lacks this hook. Running without it reproduces the original
  // late-request behavior instead of failing on a missing test-only export.
  const invalidate = (transport as unknown as { invalidateApiSessionRequests?: () => void }).invalidateApiSessionRequests;
  invalidate?.();
  clearServerStateCache();
  if (userId !== null) beginServerStateSession(userId);
  getSession.mockResolvedValue(userId === null ? { data: { session: null }, error: null } : session(userId));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function reply(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => status === 204 ? "" : JSON.stringify(body),
  } as Response;
}

function watch<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as unknown, rejected: false };
  const done = promise.then(
    (value) => { state.settled = true; state.value = value; },
    (value) => { state.settled = true; state.rejected = true; state.value = value; },
  );
  return { state, done };
}

async function flush() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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
  setRequestHeader(key: string, value: string) { this.headers[key] = value; }
  send() { FakeXhr.sent.push(this); }
  abort() { this.onabort?.(); }
  complete(status: number, body: unknown = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
let reasons: string[];

beforeEach(() => {
  reasons = [];
  getSession.mockReset();
  refreshSession.mockReset().mockResolvedValue(session("refreshed"));
  replaceAccount("account-a");
  setSessionEndedHandler((reason) => reasons.push(reason));
  FakeXhr.sent = [];
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  globalThis.fetch = vi.fn(async () => reply(200, { ok: true })) as typeof fetch;
});

afterEach(() => {
  replaceAccount(null);
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
  setSessionEndedHandler(null);
});

describe("requests retain the account that started them", () => {
  it.each(["account-b", null])("does not replay an old JSON mutation after replacement by %s", async (next) => {
    const response = deferred<Response>();
    vi.mocked(globalThis.fetch).mockReturnValueOnce(response.promise);
    const pending = watch(api.post("/records/expenses", { businessProfileId: 11, amount: 250 }));
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    replaceAccount(next);
    response.resolve(reply(401, { error: "Invalid or expired session" }));
    await pending.done;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(reasons).toEqual([]);
    expect(pending.state.rejected).toBe(true);
    expect(pending.state.value).toBeInstanceOf(ApiError);
  });

  it("does not sign out the new account when an old JSON request reports ACCOUNT_NOT_ACTIVE", async () => {
    const response = deferred<Response>();
    vi.mocked(globalThis.fetch).mockReturnValueOnce(response.promise);
    const pending = watch(api.get("/dashboard/summary"));
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    replaceAccount("account-b");
    response.resolve(reply(403, { code: "ACCOUNT_NOT_ACTIVE", error: "Account not active" }));
    await pending.done;
    expect(reasons).toEqual([]);
    expect(pending.state.rejected).toBe(true);
  });

  it.each([200, 204])("rejects an old successful mutation (%s) without invalidating the new account's cache", async (status) => {
    const response = deferred<Response>();
    vi.mocked(globalThis.fetch).mockReturnValueOnce(response.promise);
    const pending = watch(api.delete("/records/expenses/91"));
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    replaceAccount("account-b");
    await fetchServerState({ path: "/dashboard/summary", query: { businessProfileId: 22 }, fetcher: async () => ({ owner: "account-b" }) });
    response.resolve(reply(status, { id: 91 }));
    await pending.done;
    expect(peekServerState("/dashboard/summary", { businessProfileId: 22 })?.data).toEqual({ owner: "account-b" });
    expect(pending.state.rejected).toBe(true);
  });

  it("does not send a request whose token lookup finishes after account replacement", async () => {
    const token = deferred<SessionResult>();
    getSession.mockReturnValueOnce(token.promise);
    const pending = watch(api.post("/records/expenses", { businessProfileId: 11, amount: 250 }));
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    replaceAccount("account-b");
    token.resolve(session("account-a"));
    await pending.done;
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(pending.state.rejected).toBe(true);
  });

  it("rejects a JSON body that finishes after account replacement", async () => {
    const body = deferred<string>();
    const read = vi.fn(() => body.promise);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({ ...reply(200), text: read });
    const pending = watch(api.get("/dashboard/summary"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    replaceAccount("account-b");
    body.resolve(JSON.stringify({ owner: "account-a" }));
    await pending.done;
    expect(pending.state.rejected).toBe(true);
  });

  it.each([401, 403, 200])("settles an old XHR response (%s) without retry, signout, or new-account invalidation", async (status) => {
    const pending = watch(api.upload("/records/receipts/41/confirm", {} as FormData));
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    replaceAccount("account-b");
    await fetchServerState({ path: "/dashboard/summary", query: { businessProfileId: 22 }, fetcher: async () => ({ owner: "account-b" }) });
    FakeXhr.sent[0]!.complete(status, { code: "ACCOUNT_NOT_ACTIVE" });
    await flush();
    expect(FakeXhr.sent).toHaveLength(1);
    expect(reasons).toEqual([]);
    expect(peekServerState("/dashboard/summary", { businessProfileId: 22 })?.data).toEqual({ owner: "account-b" });
    expect(pending.state.settled).toBe(true);
    expect(pending.state.rejected).toBe(true);
  });
});

describe("session recovery settles and respects cancellation", () => {
  it("keeps a new account's single-flight refresh after an old account's refresh settles", async () => {
    const oldRefresh = deferred<SessionResult>();
    const newRefresh = deferred<SessionResult>();
    refreshSession.mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(newRefresh.promise);
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, options) => {
      const token = ((options?.headers ?? {}) as Record<string, string>).Authorization;
      return token === "Bearer account-a" || token === "Bearer account-b" ? reply(401) : reply(200, { ok: true });
    });
    const oldRequest = watch(api.get("/old-account"));
    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    replaceAccount("account-b");
    const firstNew = watch(api.get("/new-account-first"));
    await flush();
    try {
      expect(refreshSession).toHaveBeenCalledTimes(2);
      oldRefresh.resolve(session("account-a-refreshed"));
      await oldRequest.done;
      const secondNew = watch(api.get("/new-account-second"));
      await flush();
      expect(refreshSession).toHaveBeenCalledTimes(2);
      newRefresh.resolve(session("account-b-refreshed"));
      await Promise.all([firstNew.done, secondNew.done]);
      expect(firstNew.state.rejected).toBe(false);
      expect(secondNew.state.rejected).toBe(false);
      expect(oldRequest.state.rejected).toBe(true);
      expect(reasons).toEqual([]);
    } finally {
      oldRefresh.resolve(session("account-a-refreshed"));
      newRefresh.resolve(session("account-b-refreshed"));
      await Promise.all([oldRequest.done, firstNew.done]);
    }
  });

  it("rejects an upload when the recovery session lookup cannot reach storage", async () => {
    getSession.mockResolvedValueOnce(session("account-a"))
      .mockRejectedValueOnce(new AuthRetryableFetchError("Storage unavailable", 0));
    const pending = watch(api.upload("/records/receipts", {} as FormData));
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    FakeXhr.sent[0]!.complete(401);
    await flush();
    expect(pending.state.settled).toBe(true);
    expect(pending.state.rejected).toBe(true);
    expect(pending.state.value).toMatchObject({ status: 0 });
    expect(FakeXhr.sent).toHaveLength(1);
    expect(reasons).toEqual([]);
  });

  it("does not replay a JSON write cancelled while its session refresh was pending", async () => {
    const refresh = deferred<SessionResult>();
    refreshSession.mockReturnValueOnce(refresh.promise);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(reply(401));
    const controller = new AbortController();
    const pending = watch(api.post("/records/expenses", { businessProfileId: 11, amount: 250 }, controller.signal));
    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    controller.abort();
    refresh.resolve(session("account-a-new"));
    await pending.done;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(pending.state.rejected).toBe(true);
    expect(reasons).toEqual([]);
  });
});

describe("one-off auth-link tokens do not own the stored account", () => {
  it.each([401, 403])("keeps account A signed in when account B's link returns %s", async (status) => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(reply(status, { error: "This link is no longer valid", code: "ACCOUNT_NOT_ACTIVE" }));
    const result = watch(api.postWithToken("/auth/confirm-email", "account-b-link-token"));
    await result.done;
    expect(result.state.rejected).toBe(true);
    expect(result.state.value).toMatchObject({ status, message: "This link is no longer valid" });
    expect(reasons).toEqual([]);
    expect(getSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![1]?.headers).toMatchObject({ Authorization: "Bearer account-b-link-token" });
  });
});
