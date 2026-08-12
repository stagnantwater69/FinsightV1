import { Router } from "express";
import * as insightsController from "../controllers/insights.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const insightsRouter = Router();

insightsRouter.use(requireAuth);

insightsRouter.get("/expense-behavior", asyncHandler(insightsController.expenseBehavior));
insightsRouter.get("/recovery", asyncHandler(insightsController.recoveryInsight));
insightsRouter.get("/spending-impact", asyncHandler(insightsController.spendingImpact));
insightsRouter.get("/findings", asyncHandler(insightsController.findings));
insightsRouter.get("/findings/summary", asyncHandler(insightsController.findingsSummary));
insightsRouter.get("/findings/metrics", asyncHandler(insightsController.findingsMetrics));
insightsRouter.patch("/findings/:id/review", asyncHandler(insightsController.reviewFinding));
insightsRouter.get("/recurring-patterns", asyncHandler(insightsController.recurringPatterns));
insightsRouter.patch("/recurring-patterns/:id", asyncHandler(insightsController.reviewRecurringPattern));
