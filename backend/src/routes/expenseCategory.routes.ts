import { Router } from "express";
import * as categoryController from "../controllers/expenseCategory.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { limitAuthenticatedWrites } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const expenseCategoryRouter = Router();

expenseCategoryRouter.use(requireAuth);
expenseCategoryRouter.use(limitAuthenticatedWrites);

expenseCategoryRouter.post("/", asyncHandler(categoryController.create));
expenseCategoryRouter.get("/", asyncHandler(categoryController.list));
expenseCategoryRouter.patch("/:id", asyncHandler(categoryController.update));
