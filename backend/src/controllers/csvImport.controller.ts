import type { Request, Response } from "express";
import { z } from "zod";
import * as csvImportService from "../services/csvImport.service";
import { ApiError } from "../middleware/error.middleware";

const columnMappingSchema = z.object({
  date: z.string().min(1).max(255),
  description: z.string().min(1).max(255),
  amount: z.string().min(1).max(255),
  // Capped like every other string in a request body. These are COLUMN NAMES
  // matched against the uploaded file's header row, not content — an over-long
  // one would simply fail to match rather than reach a column — but an
  // unbounded string in a body is an unbounded string, and the neighbouring
  // corrections schema already caps every one of its fields.
  category: z.string().min(1).max(255).optional(),
  vendor: z.string().min(1).max(255).optional(),
  /** The sale/expense column, for a mixed import using the column strategy. */
  recordType: z.string().min(1).max(255).optional(),
});

/**
 * Fixes the owner typed into the "rows that need fixing" panel, keyed by the
 * spreadsheet row number the skip report uses.
 *
 * Deliberately a patch over the uploaded file rather than a replacement for
 * it: the file itself is still what gets stored as the batch's
 * fileReference, the server still parses and validates it, and a correction
 * can only supply the same kind of raw cell text the CSV would have held. So
 * this cannot be used to smuggle past a validation rule — a corrected row is
 * checked exactly as an original one is, and stays skipped if it is still
 * wrong.
 */
const correctionsSchema = z.record(
  z.string().regex(/^\d+$/, "Correction keys are row numbers"),
  z.object({
    date: z.string().max(100).optional(),
    description: z.string().max(255).optional(),
    amount: z.string().max(50).optional(),
    category: z.string().max(100).optional(),
  }),
);

function jsonField<T extends z.ZodTypeAny>(name: string, shape: T) {
  return z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: `${name} must be valid JSON` });
        return z.NEVER;
      }
    })
    .pipe(shape);
}

/*
 * EXPORTED for the contract tests, the same reason auth.controller.ts exports
 * its schemas: the clients' `maxLength` attributes are checked against the REAL
 * rule here rather than against a copy of it.
 */
export const confirmSchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  recordType: z.enum(["expense", "sales", "mixed"]),
  /** How a "mixed" file says which row is which. See lib/recordTypeDetection.ts. */
  mixedStrategy: z.enum(["column", "sign"]).optional(),
  title: z.string().min(1).max(150),
  columnMapping: jsonField("columnMapping", columnMappingSchema),
  corrections: jsonField("corrections", correctionsSchema).optional(),
});

export async function preview(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "CSV file is required");
  }
  const result = csvImportService.previewCsv(req.file.buffer);
  res.status(200).json(result);
}

const listBatchesQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
});

export async function listBatches(req: Request, res: Response) {
  const query = listBatchesQuerySchema.parse(req.query);
  const batches = await csvImportService.listImportBatches(req.user!.id, query.businessProfileId);
  res.status(200).json(batches);
}

const batchParamsSchema = z.object({
  batchId: z.coerce.number().int().positive(),
});

export async function previewBatch(req: Request, res: Response) {
  const params = batchParamsSchema.parse(req.params);
  const result = await csvImportService.previewImportBatch(req.user!.id, params.batchId);
  // Null covers "not this owner's batch" too (previewImportBatch never
  // distinguishes the two, matching requireOwnedBusinessProfile's rule), so
  // this 404 carries the same non-disclosure guarantee as everywhere else.
  if (!result) {
    throw new ApiError(404, "No preview available for this import");
  }
  res.status(200).json(result);
}

export async function confirm(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "CSV file is required");
  }
  const input = confirmSchema.parse(req.body);
  if (input.recordType === "expense" && !input.columnMapping.category) {
    throw new ApiError(400, "columnMapping.category is required for expense imports");
  }

  /*
   * A mixed file has to say HOW it is mixed, and the two strategies need
   * different things. Refused here rather than defaulted: guessing a strategy
   * is guessing which rows are money in and which are money out, and getting
   * that silently wrong is the one outcome this whole feature must not produce.
   */
  if (input.recordType === "mixed") {
    if (!input.mixedStrategy) {
      throw new ApiError(400, "mixedStrategy is required when recordType is mixed");
    }
    if (input.mixedStrategy === "column" && !input.columnMapping.recordType) {
      throw new ApiError(400, "columnMapping.recordType is required for the column strategy");
    }
  }

  const result = await csvImportService.confirmImport(req.user!.id, {
    businessProfileId: input.businessProfileId,
    recordType: input.recordType,
    mixedStrategy: input.mixedStrategy,
    title: input.title,
    buffer: req.file.buffer,
    originalname: req.file.originalname,
    columnMapping: input.columnMapping,
    corrections: input.corrections,
  });

  res.status(201).json(result);
}
