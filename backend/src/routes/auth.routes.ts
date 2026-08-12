import { Router } from "express";
import * as authController from "../controllers/auth.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { uploadPhoto } from "../middleware/upload.middleware";
import { asyncHandler } from "../lib/asyncHandler";
import { LIMITS, rateLimit } from "../middleware/rateLimit.middleware";

export const authRouter = Router();

/*
 * THE AUTH LIMITERS COME IN PAIRS on every unauthenticated route — one keyed on
 * the caller's IP, one on the address they are asking about. See LIMITS in
 * rateLimit.middleware.ts for why neither is sufficient alone.
 *
 * Both halves depend on `app.set("trust proxy", …)` being right. Behind a proxy
 * with that unset, `req.ip` is the proxy's own address for every request on
 * earth and the IP half becomes a single global bucket — which is why env.ts
 * will not start a production process that has not declared its proxy depth.
 */
authRouter.post(
  "/register",
  rateLimit(LIMITS.AUTH_REGISTER),
  rateLimit(LIMITS.AUTH_REGISTER_EMAIL),
  asyncHandler(authController.register),
);
authRouter.post(
  "/resend-verification",
  rateLimit(LIMITS.AUTH_RECOVERY),
  rateLimit(LIMITS.AUTH_RESEND_VERIFICATION),
  asyncHandler(authController.resendVerification),
);
// Authenticated by the token in the confirmation link itself, which is why
// there is no requireAuth here: the account is not usable yet, so it could not
// pass one. The service verifies the token against Supabase before trusting it.
authRouter.post("/confirm-email", rateLimit(LIMITS.AUTH_LOGIN), asyncHandler(authController.confirmEmail));

authRouter.post(
  "/login",
  rateLimit(LIMITS.AUTH_LOGIN),
  rateLimit(LIMITS.AUTH_LOGIN_EMAIL),
  asyncHandler(authController.login),
);
authRouter.post("/logout", asyncHandler(authController.logout));
authRouter.post("/logout-all", requireAuth, asyncHandler(authController.logoutEverywhere));

authRouter.post(
  "/recover-password",
  rateLimit(LIMITS.AUTH_RECOVERY),
  rateLimit(LIMITS.AUTH_RECOVERY_EMAIL),
  asyncHandler(authController.recoverPassword),
);
// Same reasoning as /confirm-email: the recovery token is the credential.
authRouter.post("/reset-password/complete", rateLimit(LIMITS.AUTH_LOGIN), asyncHandler(authController.completePasswordReset));

/*
 * These two verify the CURRENT password server-side, which makes each of them a
 * password oracle for anyone holding a stolen access token — at network speed,
 * with account deletion as the prize. requireAuth alone does not bound that;
 * the limiter does.
 */
authRouter.post(
  "/change-password",
  requireAuth,
  rateLimit(LIMITS.AUTH_REAUTH),
  asyncHandler(authController.changePassword),
);
authRouter.delete("/me", requireAuth, rateLimit(LIMITS.AUTH_REAUTH), asyncHandler(authController.deleteAccount));

authRouter.get("/me", requireAuth, asyncHandler(authController.getMe));
authRouter.patch("/me", requireAuth, asyncHandler(authController.updateMe));
authRouter.post("/me/avatar", requireAuth, uploadPhoto.single("file"), asyncHandler(authController.uploadAvatar));
