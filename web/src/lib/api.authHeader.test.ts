import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";

/**
 * A CALLER-SET Authorization HEADER WINS OVER THE BROWSER SESSION.
 *
 * Two flows act on a one-off token that arrived in an emailed link rather
 * than on the signed-in session: password recovery (pages/ResetPassword.tsx)
 * and email confirmation (pages/ConfirmEmail.tsx). Both pass that token as a
 * per-request `Authorization` header.
 *
 * The request interceptor used to overwrite it unconditionally with whatever
 * `supabase.auth.getSession()` returned — so for anyone who still had a live
 * session in that browser, the link token was silently discarded and the
 * request acted on (or was refused for) the wrong identity. Nothing on screen
 * said so.
 *
 * The ordinary case still has to keep working, which is why the third test is
 * here: the fix must be "don't clobber", not "stop attaching".
 */

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: { access_token: "session-token" } } })),
}));

vi.mock("./supabaseClient", () => ({
  supabase: { auth: { getSession } },
}));

const { api } = await import("./api");

/** Short-circuits the network and hands the fully-built config back. */
api.defaults.adapter = async (config: InternalAxiosRequestConfig) =>
  ({
    data: {},
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  }) as AxiosResponse;

function sentAuthorization(response: AxiosResponse): unknown {
  const headers = response.config.headers as unknown as { get: (name: string) => unknown };
  return headers.get("Authorization");
}

beforeEach(() => {
  getSession.mockClear();
});

describe("the request interceptor's Authorization header", () => {
  it("keeps a one-off link token the caller set for this request", async () => {
    const response = await api.post(
      "/auth/reset-password",
      { password: "x" },
      { headers: { Authorization: "Bearer recovery-link-token" } },
    );

    expect(sentAuthorization(response)).toBe("Bearer recovery-link-token");
  });

  it("does not even ask for the session when the caller brought a token", async () => {
    await api.post("/auth/confirm-email", {}, { headers: { Authorization: "Bearer link-token" } });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("still attaches the session token to an ordinary request", async () => {
    const response = await api.get("/business-profiles");
    expect(sentAuthorization(response)).toBe("Bearer session-token");
  });
});
