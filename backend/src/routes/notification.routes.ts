import { Router } from "express";
import * as notificationController from "../controllers/notification.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const notificationRouter = Router();

notificationRouter.use(requireAuth);

notificationRouter.get("/", asyncHandler(notificationController.list));
// Declared before "/:id/read" so Express doesn't try to parse "read-all" as
// an :id and answer 400 for it.
notificationRouter.patch("/read-all", asyncHandler(notificationController.markAllRead));
notificationRouter.patch("/:id/read", asyncHandler(notificationController.markRead));
