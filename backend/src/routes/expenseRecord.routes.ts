import { Router } from "express";
import * as expenseRecordController from "../controllers/expenseRecord.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const expenseRecordRouter = Router();

expenseRecordRouter.use(requireAuth);

expenseRecordRouter.post("/", asyncHandler(expenseRecordController.create));
expenseRecordRouter.get("/:id", asyncHandler(expenseRecordController.getOne));
expenseRecordRouter.patch("/:id", asyncHandler(expenseRecordController.update));
expenseRecordRouter.delete("/:id", asyncHandler(expenseRecordController.remove));
