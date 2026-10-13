import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

/**
 * Owners were being signed out while actively using the app. A 401 ended the
 * session on the spot, and a stored session whose refresh hit a network blip
 * — the usual state right after the app comes back from the background — was
 * sent with NO token, which earned exactly that 401 and deleted a refresh
 * token that was still good.
 *
 * Pinned here: a 401 gets one refresh and one retry; only a refresh Supabase
 * REFUSES ends the session; a refresh that could not reach Supabase leaves the
 * owner signed in and reports a connection problem. Mirrors web's
 * api.sessionRecovery.test.ts.
 */

type SessionResult = { data: { session: { access_token: string } | null }; error: unknown };

const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionResult>>(),
  refreshSession: vi.fn<() => Promise<SessionResult>>(),
}));

vi.mock("../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession, refreshSession } },
}));

const { api, ApiError, setSessionEndedHandler } = await import("../src/lib/api");

function session(token: string): SessionResult {
  return { data: { session: { access_token: token } }, error: null };
}

/** Tokens the fake server refuses with a 401. */
let rejected: Set<string>;
let sent: (string | undefined)[];
let reasons: string[];

function tokenOf(authorization: string | undefined) {
  return authorization?.replace(/^Bearer /, "");
}

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;

beforeEach(() => {
  rejected = new Set();
  sent = [];
  reasons = [];
  getSession.mockReset();
  refreshSession.mockReset();
  setSessionEndedHandler((reason) => reasons.push(reason));
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    sent.push(authorization);
    const token = tokenOf(authorization);
    const status = !token || rejected.has(token) ? 401 : 200;
    const body = status === 401 ? { error: "Invalid or expired session" } : { ok: true };
    return {
      ok: status === 200,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
  setSessionEndedHandler(null);
});

describe("a 401 on a session-backed request", () => {
  it("refreshes once and retries with the new token instead of signing out", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue(session("new"));

    await expect(api.get("/dashboard")).resolves.toEqual({ ok: true });
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
    expect(reasons).toEqual([]);
  });

  it("signs out when Supabase refuses the refresh token", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found"),
    });

    await expect(api.get("/dashboard")).rejects.toMatchObject({ status: 401 });
    expect(reasons).toEqual(["expired"]);
  });

  it("stays signed in and reports a connection problem when the refresh cannot reach Supabase", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) });

    const err = await api.get("/dashboard").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(0);
    expect(reasons).toEqual([]);
  });

  it("retries at most once — a second 401 ends the session", async () => {
    rejected.add("old").add("new");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue(session("new"));

    await expect(api.get("/dashboard")).rejects.toMatchObject({ status: 401 });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
    expect(reasons).toEqual(["expired"]);
  });

  it("spends the refresh token once for several requests that fail together", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockImplementation(async () => session("new"));

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(reasons).toEqual([]);
  });

  it("does not refresh for a link token", async () => {
    rejected.add("link-token");

    await expect(api.postWithToken("/auth/confirm-email", "link-token")).rejects.toMatchObject({ status: 401 });
    expect(getSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("a stored session whose refresh could not reach Supabase", () => {
  it("is not sent as a request with no token", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) });

    const err = await api.get("/dashboard").catch((e: unknown) => e);
    expect(sent).toEqual([]);
    expect((err as InstanceType<typeof ApiError>).status).toBe(0);
    expect(reasons).toEqual([]);
  });
});

describe("an upload that gets a 401", () => {
  it("refreshes once and resends the same form", async () => {
    const xhrSent: (string | undefined)[] = [];
    class FakeXhr {
      status = 0;
      responseText = "";
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      open() {}
      abort() {}
      setRequestHeader(key: string, value: string) {
        this.headers[key] = value;
      }
      send() {
        const authorization = this.headers.Authorization;
        xhrSent.push(authorization);
        const token = tokenOf(authorization);
        this.status = !token || rejected.has(token) ? 401 : 200;
        this.responseText = JSON.stringify(this.status === 401 ? { error: "Invalid or expired session" } : { ok: true });
        queueMicrotask(() => this.onload?.());
      }
    }
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue(session("new"));

    await expect(api.upload("/records/receipts", {} as FormData)).resolves.toEqual({ ok: true });
    expect(xhrSent).toEqual(["Bearer old", "Bearer new"]);
    expect(reasons).toEqual([]);
  });
});
