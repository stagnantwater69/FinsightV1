import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { requestContext, securityEvent } from "../lib/securityLog";

/**
 * A burst guard for the endpoints that spend real money.
 *
 * WHY THIS EXISTS. Uploading a receipt runs OCR and can call a vision model
 * and the categoriser; asking FinSight a question calls Gemini or OpenRouter.
 * Every one of those is billed per request, and before this there was nothing
 * server-side stopping the same call repeating forever. The realistic failure
 * is not an attacker — it is a retry loop in a client, or a `useEffect` with a
 * wrong dependency array firing an upload on every render. Either can spend a
 * lot of money in the minutes before anyone notices.
 *
 * WHAT IT IS AND IS NOT. This is a burst guard, deliberately, not a quota. The
 * limits are set so that no human working normally can reach them, and a loop
 * reaches them within seconds. It is NOT a defence against a determined
 * attacker with a valid account — that needs a sustained-usage budget and
 * alerting, which is a different piece of work. Saying so here so nobody reads
 * this file and assumes the cost problem is fully solved.
 *
 * KEYED PER USER, not per IP. These routes all sit behind requireAuth, and
 * several owners sharing one shop's connection is a normal case in this market
 * — an IP-keyed limiter would have them throttling each other. The IP fallback
 * only matters if this is ever mounted before auth.
 *
 * IN-MEMORY, single process. That is honest for how FinSight is deployed today
 * (one backend container). Behind more than one instance each would keep its
 * own counts and the effective limit would multiply by the instance count; at
 * that point this needs to move to Redis or the database.
 */

interface Bucket {
  count: number;
  /** Epoch ms at which this bucket resets. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Drops buckets that have already expired.
 *
 * Without this the Map grows once per user per limiter and never shrinks —
 * small, but it is a leak, and a leak in a process meant to run for weeks.
 * `unref()` so this timer never by itself keeps the process (or a test runner)
 * alive.
 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

export interface RateLimitOptions {
  /** Distinguishes limiters so two on one route do not share a bucket. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /**
   * What to count per, when "the signed-in user, else their IP" is wrong.
   *
   * The unauthenticated auth routes are exactly that case. Keyed on IP alone
   * they are either useless or dangerous: a whole market town behind one
   * cellular NAT shares a bucket, while an attacker with a phone tether has as
   * many buckets as they care to reconnect for. Keyed additionally on the
   * address being attacked, one account cannot be sprayed no matter where the
   * requests come from, and one person's typos cannot lock out their
   * neighbours.
   *
   * Returning `undefined` skips the limiter for that request — used when the
   * field this keys on is absent, which means the body is malformed and Zod is
   * about to reject it anyway.
   */
  identify?: (req: Request) => string | undefined;
}

/** Keys a limiter on the request's email field, so one account cannot be sprayed. */
export function byEmail(req: Request): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.trim() ? `e${email.trim().toLowerCase()}` : undefined;
}

/** Exported for tests, so a suite can start from a known state. */
export function resetRateLimits() {
  buckets.clear();
}

export async function cleanUpExpiredRateLimits(): Promise<number> {
  const deleted = await prisma.apiRateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return deleted.count;
}

/**
 * Who this request counts against.
 *
 * The IP branch is only as good as `app.set("trust proxy", …)` in app.ts. With
 * that unset behind a reverse proxy, `req.ip` is the proxy's own address for
 * every caller on earth and this returns one identity for all of them — which
 * is why env.ts refuses to boot a production process that has not stated its
 * proxy depth.
 */
function identityFor(req: Request, identify?: RateLimitOptions["identify"]): string | undefined {
  if (identify) return identify(req);
  return req.user?.id !== undefined ? `u${req.user.id}` : `ip${req.ip ?? "unknown"}`;
}

export function rateLimit({ name, limit, windowMs, identify }: RateLimitOptions) {
  // Unit tests deliberately exercise the deterministic clock-based backend.
  // Deployed processes use Postgres below, making the same limit survive
  // restarts and apply once across every replica.
  if (process.env.NODE_ENV !== "test") {
    return async function durableRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
      const identity = identityFor(req, identify);
      if (identity === undefined) return next();
      const key = `${name}:${identity}`;
      try {
        const rows = await prisma.$queryRaw<Array<{ count: number; expiresAt: Date }>>`
          INSERT INTO "ApiRateLimit" (
            "ApiRateLimit_Key", "ApiRateLimit_WindowStart", "ApiRateLimit_Count", "ApiRateLimit_ExpiresAt"
          ) VALUES (
            ${key}, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP + (${windowMs} * INTERVAL '1 millisecond')
          )
          ON CONFLICT ("ApiRateLimit_Key") DO UPDATE SET
            "ApiRateLimit_WindowStart" = CASE
              WHEN "ApiRateLimit"."ApiRateLimit_ExpiresAt" <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP
              ELSE "ApiRateLimit"."ApiRateLimit_WindowStart" END,
            "ApiRateLimit_Count" = CASE
              WHEN "ApiRateLimit"."ApiRateLimit_ExpiresAt" <= CURRENT_TIMESTAMP THEN 1
              ELSE "ApiRateLimit"."ApiRateLimit_Count" + 1 END,
            "ApiRateLimit_ExpiresAt" = CASE
              WHEN "ApiRateLimit"."ApiRateLimit_ExpiresAt" <= CURRENT_TIMESTAMP
                THEN CURRENT_TIMESTAMP + (${windowMs} * INTERVAL '1 millisecond')
              ELSE "ApiRateLimit"."ApiRateLimit_ExpiresAt" END
          RETURNING "ApiRateLimit_Count" AS count, "ApiRateLimit_ExpiresAt" AS "expiresAt"
        `;
        const bucket = rows[0]!;
        const resetSeconds = Math.max(1, Math.ceil((bucket.expiresAt.getTime() - Date.now()) / 1000));
        res.setHeader("RateLimit-Limit", String(limit));
        res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
        res.setHeader("RateLimit-Reset", String(resetSeconds));
        if (bucket.count > limit) {
          res.setHeader("Retry-After", String(resetSeconds));
          securityEvent("ratelimit.exhausted", { ...requestContext(req), limiter: name });
          return res.status(429).json({
            error: `Too many requests in a short time. Please wait about ${resetSeconds} second${resetSeconds === 1 ? "" : "s"} and try again.`,
          });
        }
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const identity = identityFor(req, identify);
    if (identity === undefined) return next();
    const key = `${name}:${identity}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (bucket.count > limit) {
      res.setHeader("Retry-After", String(resetSeconds));
      /*
       * Answered here rather than by throwing ApiError, so the response can
       * carry Retry-After — and worded for the owner, not the developer. They
       * did nothing wrong and there is nothing for them to fix; the honest
       * message is "wait a moment and it will work".
       */
      return res.status(429).json({
        error: `Too many requests in a short time. Please wait about ${resetSeconds} second${
          resetSeconds === 1 ? "" : "s"
        } and try again.`,
      });
    }

    return next();
  };
}

/**
 * The limits themselves, in one place so they can be read together.
 *
 * Each is set from what a person can physically do, not from a cost target:
 *
 *   - SCAN_RECEIPT: every scan needs a photograph, a look at the review screen
 *     and a confirm. Fifteen of those inside one minute is not a person.
 *   - ASK: a question has to be typed and its answer read. Twenty a minute is
 *     not a person either.
 *   - SUGGEST_CATEGORY: the exception, and the reason the limits are not all
 *     the same — this one fires from a 500 ms debounce while an owner types a
 *     description, so it is legitimately the chattiest AI call in the product.
 *     Sized well above what continuous typing produces.
 *
 * Hourly caps sit alongside the per-minute ones on the two costliest routes.
 * A minute window alone would let a loop that is slow enough to stay under it
 * run all day; the hour window bounds that without punishing a genuine burst,
 * because someone entering a month of receipts in one sitting still fits.
 */
export const LIMITS = {
  SCAN_RECEIPT_BURST: { name: "scan-receipt-burst", limit: 15, windowMs: 60_000 },
  SCAN_RECEIPT_HOURLY: { name: "scan-receipt-hourly", limit: 200, windowMs: 60 * 60_000 },
  // Generous relative to SCAN_RECEIPT_BURST: this fires once per SHUTTER
  // PRESS during a multi-page capture session (up to MAX_PAGES photos, plus
  // retakes), not once per submitted receipt — a real session can call this
  // several times before a single scan-receipt call ever happens.
  QUALITY_CHECK_BURST: { name: "quality-check-burst", limit: 40, windowMs: 60_000 },
  // Its own bucket rather than sharing QUALITY_CHECK_BURST, even though the
  // two fire on the same shutter press: they are called CONCURRENTLY, so one
  // shared 40/minute limit would be reached in twenty presses instead of
  // forty, and the first thing to break would be the blur warning rather than
  // the edge detection nobody depends on. Same size, same reasoning — one
  // pass over an image already in memory, no OCR, no write.
  EDGE_DETECT_BURST: { name: "edge-detect-burst", limit: 40, windowMs: 60_000 },
  ASK_BURST: { name: "ai-ask-burst", limit: 20, windowMs: 60_000 },
  ASK_HOURLY: { name: "ai-ask-hourly", limit: 200, windowMs: 60 * 60_000 },
  SUGGEST_CATEGORY: { name: "ai-suggest-category", limit: 60, windowMs: 60_000 },
  /*
   * THE AUTH LIMITS COME IN PAIRS, and the pairing is the point.
   *
   * The IP half bounds how much one origin can attempt. The EMAIL half bounds
   * how much one account can be attacked, from anywhere. Neither works alone:
   * IP-only lets a rotating tether spray a single owner's account, and
   * email-only lets one origin walk a list of addresses trying "password123"
   * against each. Both are mounted on the same route; whichever runs out first
   * answers 429.
   *
   * The email buckets are deliberately tighter than the IP ones. Ten failures
   * against ONE address is already unlike a person who has forgotten their
   * password — they try their two or three usual passwords and then use the
   * reset link.
   */
  AUTH_LOGIN: { name: "auth-login", limit: 10, windowMs: 15 * 60_000 },
  AUTH_LOGIN_EMAIL: { name: "auth-login-email", limit: 6, windowMs: 15 * 60_000, identify: byEmail },
  AUTH_REGISTER: { name: "auth-register", limit: 5, windowMs: 60 * 60_000 },
  AUTH_REGISTER_EMAIL: { name: "auth-register-email", limit: 3, windowMs: 60 * 60_000, identify: byEmail },
  AUTH_RECOVERY: { name: "auth-recovery", limit: 5, windowMs: 60 * 60_000 },
  AUTH_RECOVERY_EMAIL: { name: "auth-recovery-email", limit: 3, windowMs: 60 * 60_000, identify: byEmail },
  /*
   * Re-authentication: changing a password, deleting an account, and resending
   * a verification email.
   *
   * The first two verify the CURRENT password server-side, which makes each an
   * oracle — a stolen access token could otherwise guess a password at network
   * speed, and the prize for guessing right is deleting the owner's records.
   * Keyed per user, because that is who is being attacked. Five in fifteen
   * minutes is far more than someone changing their own password needs.
   */
  AUTH_REAUTH: { name: "auth-reauth", limit: 5, windowMs: 15 * 60_000 },
  AUTH_RESEND_VERIFICATION: { name: "auth-resend-verification", limit: 3, windowMs: 60 * 60_000, identify: byEmail },
} as const;
