import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase";
import { prisma } from "../config/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { isUsable, statusRefusal } from "../services/accountLifecycle.service";
import { securityEvent } from "../lib/securityLog";
import { timeSpan } from "../lib/requestTiming";
import { isAuthUnreachable } from "../lib/authUnreachable";
import { getVerifiedTokenOwner, rememberVerifiedToken } from "../lib/verifiedTokenCache";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: number;
        authId: string;
        email: string;
      };
    }
  }
}

// Every authenticated route uses this. There is only one role in this
// system (Small Business Owner) — do not add a role check here.
//
// It MUST stay wrapped in `asyncHandler` (see the export below). Express 4
// does not forward a rejected promise from middleware, and Node then treats it
// as an unhandled rejection and exits — so before the wrapper, one unreachable
// database or Supabase call here did not fail a request, it killed the whole
// server for every user. This runs ahead of every authenticated route, which
// made it the single most damaging place in the app to leave unwrapped.
async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  // See verifiedTokenCache.ts for what this skips, and the bounded staleness
  // it accepts in exchange.
  let verifiedOwner = getVerifiedTokenOwner(token);
  if (!verifiedOwner) {
    const { data, error } = await timeSpan("auth", () => supabaseAdmin.auth.getUser(token));
    /*
     * 503, NOT 401, when Auth could not be reached. Both clients answer a 401
     * by deleting the stored session, so a few seconds of Supabase being
     * unreachable used to sign out everyone who made a request during them —
     * including owners in the middle of using the app. Access is refused
     * either way; only a real verdict on the token ends the session.
     */
    if (isAuthUnreachable(error)) {
      securityEvent("auth.verify_failed", { reason: error?.message ?? "unknown" });
      return res.status(503).json({
        error: "We couldn't confirm your sign-in just now. Please try again in a moment.",
        code: "AUTH_UNAVAILABLE",
      });
    }
    if (error || !data.user) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    verifiedOwner = data.user.id;
    rememberVerifiedToken(token, verifiedOwner);
  }
  const authUserId = verifiedOwner;

  // Never cached: the status gate below must see the current row.
  const user = await timeSpan("user", () => prisma.user.findUnique({ where: { authId: authUserId } }));
  if (!user) {
    return res.status(401).json({ error: "No FinSight profile for this account" });
  }

  /*
   * THE STATUS GATE. Its absence is what made `User_Status` decorative: the
   * column existed, the profile response returned it, and nothing anywhere
   * consulted it — so a suspended account kept working for as long as its
   * access token lived, and a pending one could have used the API before
   * proving its address.
   *
   * 403 rather than 401, and it matters to the clients: 401 means "your session
   * ended, sign in again", which both clients act on by clearing the session
   * and showing the login form. That is the wrong instruction here — signing in
   * again will not help, and for a suspended account it produces a loop between
   * the login screen and a refusal. 403 says "we know who you are and the
   * answer is still no".
   */
  if (!isUsable(user.status)) {
    securityEvent("login.refused_status", { userId: user.id, email: user.email, status: user.status });
    // The `code` is what lets a client tell this apart from an ordinary
    // permission refusal (which must NOT end the session) without matching on
    // prose that will be reworded.
    return res.status(403).json({ error: statusRefusal(user.status), code: "ACCOUNT_NOT_ACTIVE" });
  }

  req.user = { id: user.id, authId: user.authId, email: user.email };
  next();
}

export const requireAuth = asyncHandler(authenticate);
