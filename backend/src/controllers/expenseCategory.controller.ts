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
// [ADDED] costBehavior mirrors the Prisma enum `ExpenseCostBehavior` casing
// exactly (FIXED/VARIABLE/MIXED/UNCLASSIFIED) — plain owner-controlled field,
// optional everywhere, never defaulted/guessed by this layer (the column
// default of UNCLASSIFIED handles omission on create).
const costBehaviorSchema = z.enum(["FIXED", "VARIABLE", "MIXED", "UNCLASSIFIED"]);

export const createSchema = z.object({
  businessProfileId: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
  costBehavior: costBehaviorSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(255).nullable().optional(),
  costBehavior: costBehaviorSchema.optional(),
});

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid category id");
  }
  return id;
}

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

export async function update(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const input = updateSchema.parse(req.body);
  const category = await categoryService.updateCategory(req.user!.id, id, input);
  res.status(200).json(category);
}
