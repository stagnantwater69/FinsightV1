import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

/**
 * A 401 used to sign the owner out on the spot, and a stored session whose
 * refresh hit a network blip was sent as a request with NO token — which
 * earned exactly that 401. Owners who were actively using the app were being
 * logged out by a laptop waking up or a moment of lost signal.
 *
 * Pinned here: a 401 gets one refresh and one retry; only a refresh Supabase
 * REFUSES ends the session; a refresh that could not reach Supabase leaves the
 * owner signed in and reports a connection problem.
 */

type SessionResult = { data: { session: { access_token: string } | null }; error: unknown };

const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionResult>>(),
  refreshSession: vi.fn<() => Promise<SessionResult>>(),
}));

vi.mock("./supabaseClient", () => ({
  supabase: { auth: { getSession, refreshSession } },
}));

const { api, setSessionExpiredHandler } = await import("./api");
const { beginServerStateSession, captureServerStateAccount } = await import("./serverStateCache");

/** Tokens the fake server refuses with a 401. */
let rejected = new Set<string>();
let rejectionStatus = 401;
const sent: unknown[] = [];

api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const authorization = (config.headers as unknown as { get: (name: string) => unknown }).get("Authorization");
  sent.push(authorization);
  const token = typeof authorization === "string" ? authorization.replace(/^Bearer /, "") : "";
  if (!token || rejected.has(token)) {
    const response = {
      data: { error: "Invalid or expired session", ...(rejectionStatus === 403 ? { code: "ACCOUNT_NOT_ACTIVE" } : {}) },
      status: rejectionStatus,
      statusText: "Unauthorized",
      headers: {},
      config,
    } as AxiosResponse;
    throw new AxiosError("Request failed with status code 401", AxiosError.ERR_BAD_REQUEST, config, null, response);
  }
  return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
};

const sessionExpired = vi.fn();

function session(token: string): SessionResult {
  return { data: { session: { access_token: token } }, error: null };
}

beforeEach(() => {
  rejected = new Set();
  rejectionStatus = 401;
  sent.length = 0;
  getSession.mockReset();
  refreshSession.mockReset();
  sessionExpired.mockReset();
  setSessionExpiredHandler(sessionExpired);
});

describe("a 401 on a session-backed request", () => {
  it.each([
    ["/auth/google", 401], ["/auth/google", 403],
    ["/auth/confirm-email", 401], ["/auth/confirm-email", 403],
    ["/auth/reset-password/complete", 401], ["/auth/reset-password/complete", 403],
  ])("isolates a one-off credential rejection on %s (%s) from the ambient session", async (endpoint, status) => {
    rejectionStatus = Number(status);
    rejected.add("one-off-token");
    await expect(api.post(String(endpoint), null, { headers: { Authorization: "Bearer one-off-token" } }))
      .rejects.toMatchObject({ response: { status } });
    expect(getSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(sessionExpired).not.toHaveBeenCalled();
  });

  it("refreshes once and retries with the new token instead of signing out", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue(session("new"));

    const response = await api.get("/dashboard/summary");

    expect(response.data).toEqual({ ok: true });
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
    expect(sessionExpired).not.toHaveBeenCalled();
  });

  it("signs out when Supabase refuses the refresh token", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found"),
    });

    await expect(api.get("/dashboard/summary")).rejects.toMatchObject({ response: { status: 401 } });
    expect(sessionExpired).toHaveBeenCalledTimes(1);
  });

  it("stays signed in and reports a connection problem when the refresh cannot reach Supabase", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) });

    const err = await api.get("/dashboard/summary").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiosError);
    expect((err as AxiosError).response).toBeUndefined();
    expect(sessionExpired).not.toHaveBeenCalled();
  });

  it("retries at most once — a second 401 ends the session", async () => {
    rejected.add("old").add("new");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockResolvedValue(session("new"));

    await expect(api.get("/dashboard/summary")).rejects.toMatchObject({ response: { status: 401 } });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
    expect(sessionExpired).toHaveBeenCalledTimes(1);
  });

  it("spends the refresh token once for several requests that fail together", async () => {
    rejected.add("old");
    getSession.mockResolvedValue(session("old"));
    refreshSession.mockImplementation(async () => session("new"));

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sessionExpired).not.toHaveBeenCalled();
  });

  it("does not refresh for a caller-set link token", async () => {
    rejected.add("link-token");

    await expect(
      api.post("/auth/confirm-email", {}, { headers: { Authorization: "Bearer link-token" } }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("a stored session whose refresh could not reach Supabase", () => {
  it("is not sent as a request with no token", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) });

    const err = await api.get("/dashboard/summary").catch((e: unknown) => e);

    expect(sent).toEqual([]);
    expect((err as AxiosError).code).toBe(AxiosError.ERR_NETWORK);
    expect(sessionExpired).not.toHaveBeenCalled();
  });
});

describe("manual creates remain bound to their original account generation", () => {
  it.each([17, 18])("does not dispatch after delayed session lookup and reauthentication as owner %s", async (nextOwner) => {
    beginServerStateSession(17);
    const account = captureServerStateAccount();
    let finish!: (value: SessionResult) => void;
    getSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const attempt = api.post("/records/expenses", { businessProfileId: 1, idempotencyKey: "same-save-0001" }, { manualCreateAccount: account });
    const result = attempt.catch((error: unknown) => error);
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    beginServerStateSession(nextOwner); finish(session("new-owner-token"));
    expect(await result).toMatchObject({ code: AxiosError.ERR_CANCELED });
    expect(sent).toEqual([]); expect(sessionExpired).not.toHaveBeenCalled();
  });

  it("does not resend a create under another account after a delayed 401 refresh", async () => {
    beginServerStateSession(17);
    getSession.mockResolvedValue(session("old")); rejected.add("old");
    let finish!: (value: SessionResult) => void;
    refreshSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const attempt = api.post("/records/sales", { businessProfileId: 1, idempotencyKey: "same-save-0001" }, { manualCreateAccount: captureServerStateAccount() });
    const result = attempt.catch((error: unknown) => error);
    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    beginServerStateSession(18); finish(session("new-owner-token"));
    expect(await result).toMatchObject({ code: AxiosError.ERR_CANCELED });
    expect(sent).toEqual(["Bearer old"]); expect(sessionExpired).not.toHaveBeenCalled();
  });
});
