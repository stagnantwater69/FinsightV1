import { Router } from "express";
import * as businessProfileController from "../controllers/businessProfile.controller";
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
