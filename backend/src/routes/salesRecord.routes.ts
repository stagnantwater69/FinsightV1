import { Router } from "express";
import * as salesRecordController from "../controllers/salesRecord.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const salesRecordRouter = Router();

salesRecordRouter.use(requireAuth);

salesRecordRouter.post("/", asyncHandler(salesRecordController.create));
salesRecordRouter.get("/:id", asyncHandler(salesRecordController.getOne));
salesRecordRouter.patch("/:id", asyncHandler(salesRecordController.update));
salesRecordRouter.delete("/:id", asyncHandler(salesRecordController.remove));
