import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase";
import { prisma } from "../config/prisma";
import { isUsable, statusRefusal } from "../services/accountLifecycle.service";
import { securityEvent } from "../lib/securityLog";

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
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  const user = await prisma.user.findUnique({ where: { authId: data.user.id } });
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
