import { Router } from "express";
import * as insightsController from "../controllers/insights.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";
import { assertRecurringSchedulesEnabled } from "../services/recurringSchedule.service";

export const insightsRouter = Router();

insightsRouter.use(requireAuth);

/*
 * Recurring schedules are dark until ANOMALY_RECURRING_ENABLED is on.
 *
 * The authoritative gate is `assertRecurringSchedulesEnabled` in the service —
 * every exported function calls it, so a future endpoint cannot miss it. This
 * mount calls that same function EARLIER, before the controller parses the body:
 * without it, a probe POSTing an invalid body to a dark endpoint would be
 * answered `400 Validation failed` and learn the endpoint exists. One rule, two
 * places it is enforced, no second copy of the rule.
 *
 * Sync throw — Express 4 catches those from a synchronous handler, so no
 * asyncHandler wrapper. The `.use` form covers every /recurring-schedules path,
 * including ones not yet written.
 *
 * NOT applied to GET/PATCH /recurring-patterns: those predate this work and only
 * read or annotate detector output, which is inert when the detector is off.
 */
insightsRouter.use("/recurring-schedules", (_req, _res, next) => {
  assertRecurringSchedulesEnabled();
  next();
});

/*
 * The only read endpoint here with a limiter, because it is the only one whose
 * cost scales with the account's own history: it loads the selected window
 * (up to 366 days) plus a bounded per-category baseline and runs the
 * leave-one-out outlier scan over both, synchronously. That scan is no longer
 * quadratic, but "cheaper" is not "free" and the Dashboard calls this on every
 * mount — a client stuck in a remount loop could otherwise pin a core for as
 * long as it liked, on a route that was previously mounted with `requireAuth`
 * and nothing else.
 *
 * Sized so a person cannot reach it: 60 a minute is one every second, where
 * the page issues one per mount and one per period change. Keyed per user by
 * the default identity, and durable (Postgres-backed) like every other limiter
 * in the product.
 *
 * NOTE FOR backend-api: the options live here rather than in `LIMITS` only
 * because this change was scoped not to touch rateLimit.middleware.ts. Moving
 * this constant next to its siblings is a welcome follow-up; the name is
 * already namespaced so the bucket will not move when it does.
 */
insightsRouter.get(
  "/expense-behavior",
  rateLimit({ name: "insights-expense-behavior", limit: 60, windowMs: 60_000 }),
  asyncHandler(insightsController.expenseBehavior),
);
insightsRouter.get("/reduction-opportunities", asyncHandler(insightsController.reductionOpportunities));
insightsRouter.post("/reduction-simulation", asyncHandler(insightsController.reductionSimulation));
insightsRouter.post("/reduction-opportunities/feedback", asyncHandler(insightsController.reductionOpportunityFeedback));
insightsRouter.post("/recovery-scenario", asyncHandler(insightsController.recoveryScenario));
insightsRouter.get("/recovery", asyncHandler(insightsController.recoveryInsight));
insightsRouter.get("/recovery/month-end-review", asyncHandler(insightsController.monthEndReview));
insightsRouter.get("/spending-impact", asyncHandler(insightsController.spendingImpact));
insightsRouter.get("/findings", asyncHandler(insightsController.findings));
insightsRouter.get("/findings/summary", asyncHandler(insightsController.findingsSummary));
insightsRouter.get("/findings/metrics", asyncHandler(insightsController.findingsMetrics));
insightsRouter.patch("/findings/:id/review", asyncHandler(insightsController.reviewFinding));
insightsRouter.get("/recurring-patterns", asyncHandler(insightsController.recurringPatterns));
insightsRouter.patch("/recurring-patterns/:id", asyncHandler(insightsController.reviewRecurringPattern));
// Confirming is "create the owner's schedule AND mark the pattern CONFIRMED",
// which is why it is its own verb rather than another PATCH status value.
// Confirm creates a schedule, so it is gated with the schedules, not with the
// patterns it reads from.
insightsRouter.post(
  "/recurring-patterns/:id/confirm",
  (_req, _res, next) => {
    assertRecurringSchedulesEnabled();
    next();
  },
  asyncHandler(insightsController.confirmRecurringPattern),
);
insightsRouter.get("/recurring-schedules", asyncHandler(insightsController.recurringSchedules));
insightsRouter.post("/recurring-schedules", asyncHandler(insightsController.createRecurringSchedule));
insightsRouter.patch("/recurring-schedules/:id", asyncHandler(insightsController.updateRecurringSchedule));
insightsRouter.delete("/recurring-schedules/:id", asyncHandler(insightsController.deleteRecurringSchedule));
