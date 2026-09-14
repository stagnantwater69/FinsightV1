import { Router } from "express";
import * as controller from "../controllers/receiptCaptureBatch.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../lib/asyncHandler";
import { LIMITS, rateLimit } from "../middleware/rateLimit.middleware";

export const receiptCaptureBatchRouter = Router();

receiptCaptureBatchRouter.use(requireAuth);
receiptCaptureBatchRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

receiptCaptureBatchRouter.post(
  "/",
  rateLimit(LIMITS.SCAN_RECEIPT_BURST),
  rateLimit(LIMITS.SCAN_RECEIPT_HOURLY),
  asyncHandler(controller.create),
);
receiptCaptureBatchRouter.get("/:id", asyncHandler(controller.show));
