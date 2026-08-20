import { Router } from "express";
import * as aiController from "../controllers/ai.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { LIMITS, rateLimit } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const aiRouter = Router();

aiRouter.use(requireAuth);

/*
 * Rate limits on the routes that call a billed model. `history` is a plain
 * database read and is deliberately left alone — limiting it would only make
 * the app feel broken while saving nothing.
 */
aiRouter.post(
  "/ask",
  rateLimit(LIMITS.ASK_BURST),
  rateLimit(LIMITS.ASK_HOURLY),
  asyncHandler(aiController.ask),
);
aiRouter.get("/history", asyncHandler(aiController.history));
/*
 * Spending Impact's "what am I actually buying" card. Billed like the other
 * two, but pressed deliberately rather than fired from a typing debounce —
 * hence its own pair of limits rather than sharing SUGGEST_CATEGORY's.
 */
aiRouter.post(
  "/purchase-review",
  rateLimit(LIMITS.PURCHASE_REVIEW_BURST),
  rateLimit(LIMITS.PURCHASE_REVIEW_HOURLY),
  asyncHandler(aiController.purchaseReview),
);
aiRouter.post(
  "/suggest-category",
  rateLimit(LIMITS.SUGGEST_CATEGORY),
  asyncHandler(aiController.suggestCategory),
);
