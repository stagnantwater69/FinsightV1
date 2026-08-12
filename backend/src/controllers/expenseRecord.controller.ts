import type { Request, Response } from "express";
import { z } from "zod";
import * as expenseRecordService from "../services/expenseRecord.service";
import { ApiError } from "../middleware/error.middleware";

/*
 * EXPORTED for the contract tests, the same reason auth.controller.ts exports
 * its schemas: the clients' `maxLength` attributes are checked against the REAL
 * rule here rather than against a copy of it, so a widened column cannot leave
 * a form quietly truncating what the API would have accepted.
 */
export const createSchema = z.object({
  businessProfileId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  date: z.string().date(),
  description: z.string().min(1).max(255),
  vendor: z.string().max(150).optional(),
  amount: z.number().positive(),
});

const updateSchema = z.object({
  categoryId: z.number().int().positive().optional(),
  date: z.string().date().optional(),
  description: z.string().min(1).max(255).optional(),
  vendor: z.string().max(150).nullable().optional(),
  amount: z.number().positive().optional(),
  reviewStatus: z.enum(["Reviewed", "Needs Review"]).optional(),
  duplicateStatus: z.enum(["Not a Duplicate", "Flagged"]).optional(),
});

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid record id");
  }
  return id;
}

export async function create(req: Request, res: Response) {
  const input = createSchema.parse(req.body);
  const record = await expenseRecordService.createExpenseRecord(req.user!.id, input);
  res.status(201).json(record);
}

export async function getOne(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const record = await expenseRecordService.getExpenseRecord(req.user!.id, id);
  res.status(200).json(record);
}

export async function update(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const input = updateSchema.parse(req.body);
  const record = await expenseRecordService.updateExpenseRecord(req.user!.id, id, input);
  res.status(200).json(record);
}

export async function remove(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  await expenseRecordService.deleteExpenseRecord(req.user!.id, id);
  res.status(204).send();
}
