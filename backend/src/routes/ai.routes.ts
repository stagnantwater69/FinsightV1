import { Router } from "express";
import * as aiController from "../controllers/ai.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { LIMITS, limitAuthenticatedWrites, rateLimit } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const aiRouter = Router();

aiRouter.use(requireAuth);
aiRouter.use(limitAuthenticatedWrites);

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
  rateLimit(LIMITS.SUGGEST_CATEGORY_HOURLY),
  asyncHandler(aiController.suggestCategory),
);

/*
 * AI Chat — named conversations.
 *
 * Declared after the fixed paths above so `/conversations/:id` cannot shadow
 * any of them, and the two send routes carry the SAME limit pair as `/ask`:
 * they call the same billed model through the same code path, so a second,
 * looser budget for the chat page would just be the way around the first.
 * Thread metadata writes use the shared authenticated-write guard; reads do not.
 */
aiRouter.get("/conversations", asyncHandler(aiController.listConversations));
aiRouter.post(
  "/conversations",
  rateLimit(LIMITS.ASK_BURST),
  rateLimit(LIMITS.ASK_HOURLY),
  asyncHandler(aiController.createConversation),
);
aiRouter.get("/conversations/:id", asyncHandler(aiController.getConversation));
aiRouter.patch("/conversations/:id", asyncHandler(aiController.renameConversation));
aiRouter.delete("/conversations/:id", asyncHandler(aiController.deleteConversation));
// Feedback shares the metadata write guard rather than spending a billed-model allowance.
aiRouter.put(
  "/conversations/:id/messages/:messageId/feedback",
  asyncHandler(aiController.setMessageFeedback),
);
aiRouter.post(
  "/conversations/:id/messages",
  rateLimit(LIMITS.ASK_BURST),
  rateLimit(LIMITS.ASK_HOURLY),
  asyncHandler(aiController.sendConversationMessage),
);
