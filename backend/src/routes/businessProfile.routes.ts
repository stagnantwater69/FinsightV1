import { Router } from "express";
import * as businessProfileController from "../controllers/businessProfile.controller";
import * as scheduleController from "../controllers/businessOperatingSchedule.controller";
import * as recoveryNotificationPreferenceController from "../controllers/recoveryNotificationPreference.controller";
import * as recoveryPlanController from "../controllers/recoveryPlan.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { uploadPhoto } from "../middleware/upload.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const businessProfileRouter = Router();

businessProfileRouter.use(requireAuth);

businessProfileRouter.post("/", asyncHandler(businessProfileController.create));
businessProfileRouter.get("/", asyncHandler(businessProfileController.list));
businessProfileRouter.get("/:id", asyncHandler(businessProfileController.getOne));
businessProfileRouter.patch("/:id", asyncHandler(businessProfileController.update));
businessProfileRouter.post("/:id/logo", uploadPhoto.single("file"), asyncHandler(businessProfileController.uploadLogo));
// Soft delete only — there is deliberately no DELETE route. See
// archiveBusinessProfile for why.
businessProfileRouter.post("/:id/archive", asyncHandler(businessProfileController.archive));
businessProfileRouter.post("/:id/restore", asyncHandler(businessProfileController.restore));

// Weekly operating schedule + date overrides — docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md
// §7.2-§7.4 / §11 Phase 2. Write/CRUD surface only: the calendar-resolution
// logic that reads these tables belongs to a different service owned
// elsewhere in the codebase.
businessProfileRouter.get("/:id/operating-schedule", asyncHandler(scheduleController.getSchedule));
businessProfileRouter.put("/:id/operating-schedule", asyncHandler(scheduleController.putSchedule));
businessProfileRouter.get("/:id/operating-overrides", asyncHandler(scheduleController.listOverrides));
businessProfileRouter.post("/:id/operating-overrides", asyncHandler(scheduleController.createOverride));
businessProfileRouter.delete("/:id/operating-overrides/:overrideId", asyncHandler(scheduleController.deleteOverride));

// Recovery notification preferences + saved recovery plans —
// docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.5/§10.7/§10.8/§11 Phase 6.
// Write/CRUD surface only: nothing here is read by the live recovery-target
// calculation (analysis.service.ts / insights.service.ts) — see
// recoveryPlan.service.ts's header comment.
businessProfileRouter.get(
  "/:id/recovery-notification-preferences",
  asyncHandler(recoveryNotificationPreferenceController.getPreference),
);
businessProfileRouter.put(
  "/:id/recovery-notification-preferences",
  asyncHandler(recoveryNotificationPreferenceController.putPreference),
);
businessProfileRouter.get("/:id/recovery-plans", asyncHandler(recoveryPlanController.listPlans));
businessProfileRouter.put("/:id/recovery-plans/:month", asyncHandler(recoveryPlanController.putPlan));
businessProfileRouter.delete("/:id/recovery-plans/:month", asyncHandler(recoveryPlanController.deletePlan));
