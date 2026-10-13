import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

const getUser = vi.fn();
const findUnique = vi.fn();

vi.mock("../../src/config/supabase", () => ({
  supabaseAdmin: { auth: { getUser: (t: string) => getUser(t) } },
  SUPABASE_REQUEST_TIMEOUT_MS: 60_000,
}));
vi.mock("../../src/config/prisma", () => ({ prisma: { user: { findUnique: (a: unknown) => findUnique(a) } } }));

const { requireAuth } = await import("../../src/middleware/auth.middleware");
const { clearVerifiedTokenCache, evictTokenOwner } = await import("../../src/lib/verifiedTokenCache");

function fakeReq(): Request {
  return { headers: { authorization: "Bearer token" } } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & typeof res;
}

/**
 * `requireAuth` guards every authenticated route, and Express 4 does not
 * forward a rejected promise from middleware — Node treats it as an unhandled
 * rejection and exits the process. So a momentary loss of the database here
 * does not fail one request, it takes the server down for everyone. That is a
 * real outage this suite watched happen, which is why it is pinned.
 */
describe("requireAuth error propagation", () => {
  beforeEach(() => {
    getUser.mockReset();
    findUnique.mockReset();
  });

  it("hands a database outage to the error handler instead of rejecting", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "auth-1" } }, error: null });
    findUnique.mockRejectedValue(new Error("Can't reach database server"));

    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;

    // Must not reject: the wrapper has to absorb it before Node ever sees it.
    await expect(Promise.resolve(requireAuth(fakeReq(), res, next))).resolves.toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));

    const calls = (next as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBeInstanceOf(Error);
    // The request itself is unresolved here, not answered with a misleading 401.
    expect(res.statusCode).toBe(0);
  });

  it("still refuses an invalid session without involving the error handler", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new Error("bad token") });

    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await Promise.resolve(requireAuth(fakeReq(), res, next));
    await new Promise(resolve => setImmediate(resolve));

    expect(res.statusCode).toBe(401);
    expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

/**
 * Both clients delete the stored session on a 401, so a 401 here must mean
 * Supabase actually refused the token. When Auth could not be reached the
 * request is still refused — but with a 503 that leaves the owner signed in.
 */
describe("requireAuth when Supabase Auth is unreachable", () => {
  beforeEach(() => {
    getUser.mockReset();
    findUnique.mockReset();
    clearVerifiedTokenCache();
  });

  function authError(name: string, status: number) {
    return Object.assign(new Error(`${name} ${status}`), { name, status });
  }

  it.each([
    ["a connection that could not be made", authError("AuthRetryableFetchError", 0)],
    ["a 5xx from Auth", authError("AuthRetryableFetchError", 502)],
    ["an unknown error carrying a 5xx status", authError("AuthUnknownError", 500)],
  ])("answers 503, not 401, for %s", async (_label, error) => {
    getUser.mockResolvedValue({ data: { user: null }, error });

    const { res, next } = await run("token");
    expect(res.statusCode).toBe(503);
    expect((res.body as { code?: string }).code).toBe("AUTH_UNAVAILABLE");
    expect(next).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not cache anything from an unreachable check", async () => {
    const token = jwt({ sub: "auth-7", exp: Math.floor(Date.now() / 1000) + 3600 });
    getUser.mockResolvedValue({ data: { user: null }, error: authError("AuthRetryableFetchError", 0) });
    await run(token);
    getUser.mockResolvedValue({ data: { user: null }, error: authError("AuthApiError", 403) });

    const { res } = await run(token);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(401);
  });

  it("still answers 401 when Auth refuses the token", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: authError("AuthApiError", 403) });

    const { res, next } = await run("token");
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function reqWith(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

async function run(token: string) {
  const res = fakeRes();
  const next = vi.fn() as unknown as NextFunction;
  await Promise.resolve(requireAuth(reqWith(token), res, next));
  await new Promise(resolve => setImmediate(resolve));
  return { res, next: next as unknown as ReturnType<typeof vi.fn> };
}

/**
 * The verified-token cache removes the Supabase round-trip from repeat
 * requests. What must NOT change: the user row (and so the status gate) is
 * read every time, and a revocation through this process takes effect at once.
 */
describe("requireAuth verified-token cache", () => {
  const activeUser = { id: 7, authId: "auth-7", email: "owner@example.com", status: "ACTIVE" };

  beforeEach(() => {
    getUser.mockReset();
    findUnique.mockReset();
    clearVerifiedTokenCache();
    getUser.mockResolvedValue({ data: { user: { id: "auth-7" } }, error: null });
    findUnique.mockResolvedValue(activeUser);
  });

  it("verifies a token with Supabase once, then serves repeats from the cache", async () => {
    const token = jwt({ sub: "auth-7", exp: Math.floor(Date.now() / 1000) + 3600 });
    expect((await run(token)).next).toHaveBeenCalledTimes(1);
    expect((await run(token)).next).toHaveBeenCalledTimes(1);

    expect(getUser).toHaveBeenCalledTimes(1);
    // The user row is still read on every request.
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("still applies the status gate to a cached token", async () => {
    const token = jwt({ sub: "auth-7", exp: Math.floor(Date.now() / 1000) + 3600 });
    await run(token);
    findUnique.mockResolvedValue({ ...activeUser, status: "SUSPENDED" });

    const { res, next } = await run(token);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("re-verifies with Supabase after the owner's sessions are revoked here", async () => {
    const token = jwt({ sub: "auth-7", exp: Math.floor(Date.now() / 1000) + 3600 });
    await run(token);
    evictTokenOwner(token);
    getUser.mockResolvedValue({ data: { user: null }, error: new Error("session revoked") });

    const { res } = await run(token);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(401);
  });

  it("never caches an expired token or one without a readable expiry", async () => {
    const expired = jwt({ sub: "auth-7", exp: Math.floor(Date.now() / 1000) - 10 });
    await run(expired);
    await run(expired);
    await run("opaque-token");
    await run("opaque-token");
    expect(getUser).toHaveBeenCalledTimes(4);
  });
});
