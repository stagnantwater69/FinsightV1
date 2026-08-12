import { Router } from "express";
import * as recordsController from "../controllers/records.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const recordsRouter = Router();

recordsRouter.use(requireAuth);

recordsRouter.get("/search", asyncHandler(recordsController.search));
recordsRouter.get("/flagged", asyncHandler(recordsController.flagged));
recordsRouter.post("/duplicates/resolve", asyncHandler(recordsController.resolveDuplicates));
