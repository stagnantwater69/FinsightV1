import type { Request, Response } from "express";
import { z } from "zod";
import * as categoryService from "../services/expenseCategory.service";
import { ApiError } from "../middleware/error.middleware";

/*
 * EXPORTED for the contract tests, the same reason auth.controller.ts exports
 * its schemas: the clients' `maxLength` attributes are checked against the REAL
 * rule here rather than against a copy of it, so a widened column cannot leave
 * a form quietly truncating what the API would have accepted.
 */
export const createSchema = z.object({
  businessProfileId: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
});

export async function create(req: Request, res: Response) {
  const input = createSchema.parse(req.body);
  const category = await categoryService.createCategory(req.user!.id, input);
  res.status(201).json(category);
}

export async function list(req: Request, res: Response) {
  const businessProfileId = Number(req.query.businessProfileId);
  if (!Number.isInteger(businessProfileId) || businessProfileId <= 0) {
    throw new ApiError(400, "businessProfileId query parameter is required");
  }
  const categories = await categoryService.listCategories(req.user!.id, businessProfileId);
  res.status(200).json(categories);
}
