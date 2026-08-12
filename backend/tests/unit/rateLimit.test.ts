import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { byEmail, LIMITS, rateLimit, resetRateLimits } from "../../src/middleware/rateLimit.middleware";

/**
 * These endpoints spend money per request, so the thing worth proving is not
 * that a limiter exists but that it counts the RIGHT requests: per user, per
 * limiter, and released when the window passes.
 */

function fakeReq(userId?: number, ip = "10.0.0.1", body?: unknown): Request {
  return { user: userId === undefined ? undefined : { id: userId }, ip, body } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
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

/** Runs the middleware once and reports whether it passed the request on. */
function call(mw: ReturnType<typeof rateLimit>, req: Request) {
  const res = fakeRes();
  const next = vi.fn() as unknown as NextFunction;
  mw(req, res, next);
  return { res, allowed: (next as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1 };
}

describe("rateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useRealTimers();
  });

  it("allows requests up to the limit and blocks the next one", () => {
    const mw = rateLimit({ name: "t", limit: 3, windowMs: 60_000 });
    const req = fakeReq(1);

    expect(call(mw, req).allowed).toBe(true);
    expect(call(mw, req).allowed).toBe(true);
    expect(call(mw, req).allowed).toBe(true);

    const fourth = call(mw, req);
    expect(fourth.allowed).toBe(false);
    expect(fourth.res.statusCode).toBe(429);
  });

  /**
   * The reason this is keyed per user and not per IP: several shop owners
   * sharing one connection is normal here, and IP keying would have them
   * throttling each other.
   */
  it("counts each user separately", () => {
    const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000 });

    expect(call(mw, fakeReq(1)).allowed).toBe(true);
    expect(call(mw, fakeReq(1)).allowed).toBe(false);
    // A different owner is unaffected by the first one's burst.
    expect(call(mw, fakeReq(2)).allowed).toBe(true);
  });

  /** Two limiters on one route must not share a bucket, or the tighter one
   *  would consume the looser one's allowance. */
  it("keeps separate counts per limiter name", () => {
    const burst = rateLimit({ name: "burst", limit: 1, windowMs: 60_000 });
    const hourly = rateLimit({ name: "hourly", limit: 5, windowMs: 3_600_000 });
    const req = fakeReq(1);

    expect(call(burst, req).allowed).toBe(true);
    expect(call(hourly, req).allowed).toBe(true);
    expect(call(burst, req).allowed).toBe(false);
    // The hourly limiter still has room; only the burst window is spent.
    expect(call(hourly, req).allowed).toBe(true);
  });

  it("lets the caller through again once the window has passed", () => {
    vi.useFakeTimers();
    const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000 });
    const req = fakeReq(1);

    expect(call(mw, req).allowed).toBe(true);
    expect(call(mw, req).allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(call(mw, req).allowed).toBe(true);
  });

  it("tells the caller how long to wait", () => {
    const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000 });
    const req = fakeReq(1);
    call(mw, req);
    const blocked = call(mw, req);

    expect(blocked.res.headers["Retry-After"]).toBeDefined();
    // Worded for the owner: they did nothing wrong and there is nothing to fix.
    expect(String((blocked.res.body as { error: string }).error)).toMatch(/wait about \d+ seconds? and try again/);
  });

  it("falls back to the IP when there is no authenticated user", () => {
    const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000 });
    expect(call(mw, fakeReq()).allowed).toBe(true);
    expect(call(mw, fakeReq()).allowed).toBe(false);
  });

  /**
   * The limits are a burst guard, not a quota — set from what a person can
   * physically do. This pins the intent: if someone later tightens one to a
   * number a real owner could hit while working, this fails.
   */
  it("sets limits no working owner can reach by hand", () => {
    // A scan needs a photo, a review and a confirm. Not fifteen in a minute.
    expect(LIMITS.SCAN_RECEIPT_BURST.limit).toBeGreaterThanOrEqual(10);
    expect(LIMITS.SCAN_RECEIPT_BURST.windowMs).toBe(60_000);
    // Chattiest AI call — fires from a 500ms debounce while typing, so it has
    // to sit well above the others.
    expect(LIMITS.SUGGEST_CATEGORY.limit).toBeGreaterThan(LIMITS.ASK_BURST.limit);
  });

  /*
   * THE FAILURE THIS GUARDS AGAINST is not an attacker — it is one wrong
   * password locking out the entire product.
   *
   * The durable limiter keys on `req.ip`, and behind a reverse proxy with
   * `trust proxy` unset that is the PROXY's address for every caller on earth.
   * All auth traffic then shares a single bucket, and the real login limit
   * becomes ten attempts per fifteen minutes for all users combined. These two
   * tests state what has to hold either side of that: distinct clients get
   * distinct buckets, and a client cannot mint itself a fresh one.
   */
  it("gives separate IPs separate quotas", () => {
    const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000 });
    expect(call(mw, fakeReq(undefined, "203.0.113.7")).allowed).toBe(true);
    expect(call(mw, fakeReq(undefined, "203.0.113.7")).allowed).toBe(false);
    // A different shop, on a different connection, is unaffected.
    expect(call(mw, fakeReq(undefined, "198.51.100.4")).allowed).toBe(true);
  });

  /**
   * `req.ip` is Express's resolved address, and with a HOP COUNT for
   * `trust proxy` (see app.ts) it is the entry our own nginx appended — not the
   * left-most one, which is whatever the client wrote. So a spoofed header
   * cannot change the identity this limiter sees; the same resolved IP keeps
   * counting against the same bucket however many forged hops precede it.
   */
  it("counts against the resolved address, not a client-supplied one", () => {
    const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000 });
    const spoofing = () => {
      const req = fakeReq(undefined, "203.0.113.7");
      (req.headers as unknown) = { "x-forwarded-for": "1.2.3.4, 203.0.113.7" };
      return req;
    };
    expect(call(mw, spoofing()).allowed).toBe(true);
    expect(call(mw, spoofing()).allowed).toBe(false);
  });

  describe("keyed by email", () => {
    /*
     * WHY THE AUTH LIMITS COME IN PAIRS. IP-only lets a rotating phone tether
     * spray one owner's account; email-only lets one origin walk a list of
     * addresses trying the same password against each. Both are mounted, and
     * whichever runs out first answers 429.
     */
    it("counts one address separately from another", () => {
      const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000, identify: byEmail });
      expect(call(mw, fakeReq(undefined, "10.0.0.1", { email: "a@shop.ph" })).allowed).toBe(true);
      // Same IP, so an IP-keyed limiter would have blocked this. A different
      // account is being attempted, so this one must not.
      expect(call(mw, fakeReq(undefined, "10.0.0.1", { email: "b@shop.ph" })).allowed).toBe(true);
      expect(call(mw, fakeReq(undefined, "10.0.0.1", { email: "a@shop.ph" })).allowed).toBe(false);
    });

    it("treats one address as one address whatever its case or spacing", () => {
      const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000, identify: byEmail });
      expect(call(mw, fakeReq(undefined, "10.0.0.1", { email: "owner@shop.ph" })).allowed).toBe(true);
      // Otherwise the limit is bypassed by holding down shift.
      expect(call(mw, fakeReq(undefined, "10.0.0.2", { email: "  OWNER@Shop.PH " })).allowed).toBe(false);
    });

    /**
     * A body with no address means Zod is about to reject the request anyway.
     * Skipping is deliberate: keying every malformed body onto one shared
     * "unknown" bucket would let junk requests exhaust a real limiter.
     */
    it("skips the limiter when there is no address to key on", () => {
      const mw = rateLimit({ name: "t", limit: 1, windowMs: 60_000, identify: byEmail });
      expect(call(mw, fakeReq(undefined, "10.0.0.1", {})).allowed).toBe(true);
      expect(call(mw, fakeReq(undefined, "10.0.0.1", { email: "   " })).allowed).toBe(true);
      expect(call(mw, fakeReq(undefined, "10.0.0.1", undefined)).allowed).toBe(true);
    });
  });

  /**
   * The two endpoints that verify the CURRENT password server-side are password
   * oracles for anyone holding a stolen access token — at network speed, with
   * account deletion as the prize. requireAuth does not bound that.
   */
  it("bounds the re-authentication oracles tightly", () => {
    expect(LIMITS.AUTH_REAUTH.limit).toBeLessThanOrEqual(5);
    expect(LIMITS.AUTH_REAUTH.windowMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  /** Every unauthenticated auth route has both halves of its pair. */
  it("pairs every unauthenticated auth limiter with an email-keyed one", () => {
    for (const [ip, email] of [
      [LIMITS.AUTH_LOGIN, LIMITS.AUTH_LOGIN_EMAIL],
      [LIMITS.AUTH_REGISTER, LIMITS.AUTH_REGISTER_EMAIL],
      [LIMITS.AUTH_RECOVERY, LIMITS.AUTH_RECOVERY_EMAIL],
    ] as const) {
      expect(email.identify, email.name).toBe(byEmail);
      // Tighter than its IP partner: repeated failures against ONE address are
      // already unlike someone who has forgotten their own password.
      expect(email.limit, email.name).toBeLessThanOrEqual(ip.limit);
    }
  });
});
