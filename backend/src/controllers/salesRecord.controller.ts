import type { Request, Response } from "express";
import { z } from "zod";
import * as salesRecordService from "../services/salesRecord.service";
import { ApiError } from "../middleware/error.middleware";

const createSchema = z.object({
  businessProfileId: z.number().int().positive(),
  date: z.string().date(),
  description: z.string().min(1).max(255),
  amount: z.number().positive(),
});

const updateSchema = z.object({
  date: z.string().date().optional(),
  description: z.string().min(1).max(255).optional(),
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
  const record = await salesRecordService.createSalesRecord(req.user!.id, input);
  res.status(201).json(record);
}

export async function getOne(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const record = await salesRecordService.getSalesRecord(req.user!.id, id);
  res.status(200).json(record);
}

export async function update(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const input = updateSchema.parse(req.body);
  const record = await salesRecordService.updateSalesRecord(req.user!.id, id, input);
  res.status(200).json(record);
}

export async function remove(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  await salesRecordService.deleteSalesRecord(req.user!.id, id);
  res.status(204).send();
}
