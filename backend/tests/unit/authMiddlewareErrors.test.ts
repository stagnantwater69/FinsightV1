import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

const getUser = vi.fn();
const findUnique = vi.fn();

vi.mock("../../src/config/supabase", () => ({ supabaseAdmin: { auth: { getUser: (t: string) => getUser(t) } } }));
vi.mock("../../src/config/prisma", () => ({ prisma: { user: { findUnique: (a: unknown) => findUnique(a) } } }));

const { requireAuth } = await import("../../src/middleware/auth.middleware");

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
