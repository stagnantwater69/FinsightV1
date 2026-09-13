import type { Request, Response } from "express";
import { z } from "zod";
import {
  createReceiptCaptureBatch,
  getReceiptCaptureBatch,
  RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS,
  RECEIPT_CAPTURE_BATCH_MIN_RECEIPTS,
} from "../services/receiptCaptureBatch.service";
import { ApiError } from "../middleware/error.middleware";

const createBatchSchema = z.object({
  businessProfileId: z.number().int().positive(),
  clientBatchKey: z.string().trim().min(8).max(100),
  expectedReceiptCount: z.number().int()
    .min(RECEIPT_CAPTURE_BATCH_MIN_RECEIPTS)
    .max(RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS),
}).strict();

function parseBatchId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Invalid receipt batch id");
  return id;
}

export async function create(req: Request, res: Response) {
  const input = createBatchSchema.parse(req.body);
  const result = await createReceiptCaptureBatch(req.user!.id, input);
  res.status(result.replayed ? 200 : 201).json(result.batch);
}

export async function show(req: Request, res: Response) {
  const batch = await getReceiptCaptureBatch(req.user!.id, parseBatchId(req.params.id!));
  res.json(batch);
}
