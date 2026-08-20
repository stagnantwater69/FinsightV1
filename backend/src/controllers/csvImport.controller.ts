import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import * as csvImportService from "../services/csvImport.service";
import { ApiError } from "../middleware/error.middleware";
import { logger } from "../config/logger";

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
  /**
   * The client's replay token for this confirm. Optional in the SCHEMA but
   * effectively required in practice — see the shim in `confirm` below.
   */
  idempotencyKey: z.string().min(8).max(100).optional(),
  /**
   * The owner's answer to "are these dates day-first or month-first?", sent
   * only when the preview reported the file ambiguous. Absent means "the file
   * speaks for itself", and confirm refuses a file that does not.
   */
  dateFormat: z.enum(["iso", "dmy", "mdy"]).optional(),
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

  /*
   * IDEMPOTENCY KEY — required in spirit, shimmed in practice.
   *
   * A confirm that is retried without a key (a refresh, a proxy retry, an
   * impatient second click) imports the file twice, and doubling a month of
   * books is the worst outcome this endpoint has. So the key is what makes a
   * retry safe, and every client should send one.
   *
   * It is not yet REJECTED when missing, because the web client does not send
   * one until the Phase 4 UI work lands, and a 400 here would break importing
   * altogether in between. A generated key still produces a well-formed batch;
   * it simply cannot recognise a replay, which is exactly the old behaviour.
   *
   * PHASE 4 FOLLOW-UP: once both clients send a key, drop the `??` below and
   * make the schema field required.
   */
  if (!input.idempotencyKey) {
    logger.warn(
      { businessProfileId: input.businessProfileId },
      "csv confirm without an idempotency key — retries of this import cannot be deduplicated",
    );
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
    idempotencyKey: input.idempotencyKey ?? `http-${randomUUID()}`,
    dateFormat: input.dateFormat,
  });

  /*
   * 202 when the file was too large to import inside the request: the batch
   * exists and the worker has it, but no records are written yet. The client
   * polls the status route below. 201 keeps its old meaning — the import is
   * finished and the counts in the body are final.
   */
  const accepted = result.processingStatus === "PENDING" || result.processingStatus === "PROCESSING";
  res.status(accepted ? 202 : 201).json(result);
}

export async function batchStatus(req: Request, res: Response) {
  const params = batchParamsSchema.parse(req.params);
  const status = await csvImportService.getImportBatchStatus(req.user!.id, params.batchId);
  res.status(200).json(status);
}
