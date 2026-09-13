import { createHash } from "node:crypto";
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
 * DURABLE, in Postgres, for every deployed process: the `ApiRateLimit` table
 * (one upsert per request, see the `durableRateLimitMiddleware` branch below)
 * so a limit survives restarts and applies once across every replica — the
 * repo's "never in-memory" non-negotiable. The in-memory `buckets` Map further
 * down is the NODE_ENV=test stub only, kept so the ordinary unit suites need
 * no database; tests/integration/rateLimitDurability.test.ts pins the deployed
 * branch explicitly.
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

/**
 * Keys a limiter on the request's email field, so one account cannot be sprayed.
 *
 * HASHED, NOT RAW, for two reasons. The identity becomes the primary key of a
 * varchar(255) row in ApiRateLimit, and this limiter runs BEFORE Zod — so an
 * attacker could post a kilobyte-long "address" and turn a rate-limit check
 * into a database error, which is a 500 on the login route from an unvalidated
 * body. A digest is fixed-length, so no input can overflow the column. It also
 * keeps the address itself out of that table: the limiter only ever needs to
 * know that two requests name the SAME account, never which one.
 *
 * Normalisation (trim + lowercase) happens before hashing, so "Owner@Shop.PH"
 * and "owner@shop.ph" still land in one bucket — otherwise the limit is
 * bypassed by holding down shift. The `e` prefix is kept so an email-keyed
 * identity can never collide with the `u`/`ip` ones.
 */
export function byEmail(req: Request): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string" || !email.trim()) return undefined;
  // 128 bits of a SHA-256 is far past any collision concern for a bucket key,
  // and keeps the stored key short enough to read in a query result.
  return `e${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32)}`;
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

/**
 * How long to wait, in words a shop owner reads rather than a number they have
 * to divide.
 *
 * The 429 body used to interpolate raw seconds, which on the hour-long auth
 * buckets produced "Please wait about 2275 seconds and try again." Nobody
 * converts that in their head; it reads as a system fault rather than as a
 * wait, and the honest answer — "about 38 minutes" — is the same fact stated
 * usefully. Rounded UP, so the message never expires later than it promises.
 *
 * `Retry-After` keeps carrying the exact seconds: that header is for machines,
 * and this string is for people.
 */
export function humanRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.round(minutes / 60);
  // 90+ minutes reads better as "about an hour and a half" than "2 hours", but
  // the buckets here top out at an hour, so a plain hour count is enough and
  // an extra branch would be dead code.
  return `${hours} hour${hours === 1 ? "" : "s"}`;
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
            error: `Too many requests in a short time. Please wait about ${humanRetryAfter(
              resetSeconds,
            )} and try again.`,
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
        error: `Too many requests in a short time. Please wait about ${humanRetryAfter(
          resetSeconds,
        )} and try again.`,
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
  /*
   * Perspective correction. Its own bucket for the reason given just above —
   * it fires in the SAME capture session as edge detection, so sharing that
   * bucket would spend one allowance twice and the first thing to break would
   * be the crop the owner just confirmed. Smaller than either neighbour
   * because it is the only one of the three that resamples every pixel of the
   * image on a worker thread rather than one downscaled pass: a session
   * corrects a page once (plus a retake or two), it does not fire per shutter
   * press.
   */
  TRANSFORM_BURST: { name: "receipt-transform-burst", limit: 20, windowMs: 60_000 },
  /*
   * CSV import. Both endpoints parse an up-to-5MB file in memory, and confirm
   * additionally writes to Storage and can enqueue tens of thousands of rows —
   * the second-most expensive request in the product after a receipt scan, and
   * previously the only expensive one with no limit at all.
   *
   * Preview is the looser of the two because it is genuinely iterative: an
   * owner re-uploads while sorting out which column is which, and that is the
   * flow working as intended. Confirm is the one that writes, and nobody
   * legitimately confirms ten imports a minute.
   */
  CSV_PREVIEW_BURST: { name: "csv-preview-burst", limit: 20, windowMs: 60_000 },
  CSV_CONFIRM_BURST: { name: "csv-confirm-burst", limit: 10, windowMs: 60_000 },
  CSV_CONFIRM_HOURLY: { name: "csv-confirm-hourly", limit: 60, windowMs: 60 * 60_000 },
  ASK_BURST: { name: "ai-ask-burst", limit: 20, windowMs: 60_000 },
  ASK_HOURLY: { name: "ai-ask-hourly", limit: 200, windowMs: 60 * 60_000 },
  SUGGEST_CATEGORY: { name: "ai-suggest-category", limit: 60, windowMs: 60_000 },
  /*
   * PURCHASE_REVIEW: Spending Impact's "what is this thing, and what should I
   * be asking about it" call. Pressed deliberately, one item at a time, and
   * read before the next one — so it is nowhere near as chatty as
   * SUGGEST_CATEGORY, which fires from a typing debounce. Sized for someone
   * comparing a handful of options in one sitting, with an hourly cap because
   * it is a billed model call and the button is easy to hold down.
   */
  PURCHASE_REVIEW_BURST: { name: "ai-purchase-review-burst", limit: 12, windowMs: 60_000 },
  PURCHASE_REVIEW_HOURLY: { name: "ai-purchase-review-hourly", limit: 120, windowMs: 60 * 60_000 },
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
  /*
   * PASSWORD RECOVERY — and the shape here matters more than the numbers.
   *
   * WHY THE IP HALF IS NOT TIGHT. It was 5 an hour, which reads prudent and is
   * wrong for this market. Carrier-grade NAT puts thousands of mobile
   * subscribers behind one address, and a mall or co-working connection does
   * the same for everyone in the building — so a per-IP recovery budget of 5 is
   * not "five attempts by one person", it is five attempts by an entire
   * carrier's customers, after which the sixth real owner who forgot their
   * password is refused for reasons that have nothing to do with them. The
   * precise control against a single account is the EMAIL half below; this one
   * exists to stop a spray across many addresses, and 20 an hour still does
   * that while leaving a shared address usable.
   *
   * WHY THE EMAIL HALF KEEPS ITS COUNT BUT LOSES ITS WINDOW. Three per HOUR
   * meant one bad run cost the rest of the hour — and the person paying that
   * price is almost never an attacker. It is someone whose first email went to
   * spam or was slow, who pressed "send again" twice, and who is now locked out
   * of account recovery for fifty-five minutes at the exact moment they are
   * already stuck. Three per fifteen minutes is the same burst protection: an
   * attacker still cannot hammer one address, and a mistake costs a quarter of
   * an hour instead of an afternoon. It also puts this in step with
   * AUTH_LOGIN_EMAIL, which was four times more forgiving than recovery —
   * backwards, given recovery is where people arrive when already locked out.
   */
  AUTH_RECOVERY: { name: "auth-recovery", limit: 20, windowMs: 60 * 60_000 },
  AUTH_RECOVERY_EMAIL: { name: "auth-recovery-email", limit: 3, windowMs: 15 * 60_000, identify: byEmail },
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
  /*
   * The same reasoning as AUTH_RECOVERY_EMAIL, for the same reason: this is the
   * button someone presses when the confirmation email has not arrived, so the
   * person hitting the limit is by definition someone the system has already
   * failed once. An hour-long penalty for that is the wrong trade.
   */
  AUTH_RESEND_VERIFICATION: { name: "auth-resend-verification", limit: 3, windowMs: 15 * 60_000, identify: byEmail },
  /*
   * The web → mobile session handoff.
   *
   * Issuing is already behind a valid access token, so this bounds a
   * compromised token rather than an anonymous caller; a handful per quarter
   * hour covers "I pressed it, nothing happened, I pressed it again" and
   * nothing beyond that.
   *
   * EXCHANGING IS THE ONE THAT MATTERS. It is unauthenticated by construction —
   * the code IS the credential — so it is the only endpoint in this file where
   * an attacker can pick their own input and try again. The code is 256 bits,
   * which makes guessing hopeless on arithmetic alone; the limit is here so
   * that a bug which ever shortens it does not silently become brute-forceable.
   */
  AUTH_HANDOFF_ISSUE: { name: "auth-handoff-issue", limit: 10, windowMs: 15 * 60_000 },
  AUTH_HANDOFF_EXCHANGE: { name: "auth-handoff-exchange", limit: 10, windowMs: 15 * 60_000 },
} as const;
