import { Router } from "express";
import * as csvImportController from "../controllers/csvImport.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { uploadCsv } from "../middleware/upload.middleware";
import { LIMITS, rateLimit } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const csvImportRouter = Router();

csvImportRouter.use(requireAuth);

/*
 * Limited BEFORE multer, the same ordering the receipt routes use: a rejected
 * burst should not pay to parse a 5MB upload off the wire first.
 */
csvImportRouter.post(
  "/preview",
  rateLimit(LIMITS.CSV_PREVIEW_BURST),
  uploadCsv.single("file"),
  asyncHandler(csvImportController.preview),
);
csvImportRouter.post(
  "/confirm",
  rateLimit(LIMITS.CSV_CONFIRM_BURST),
  rateLimit(LIMITS.CSV_CONFIRM_HOURLY),
  uploadCsv.single("file"),
  asyncHandler(csvImportController.confirm),
);
csvImportRouter.get("/batches", asyncHandler(csvImportController.listBatches));
csvImportRouter.get("/batches/:batchId/preview", asyncHandler(csvImportController.previewBatch));
/*
 * Polled by both clients while a large import runs, so deliberately NOT rate
 * limited — same reasoning as the receipt scan's GET: two indexed reads, no
 * parsing, no writes, and a limit sized for confirms would start rejecting the
 * very polling that the async import depends on.
 */
csvImportRouter.get("/batches/:batchId/status", asyncHandler(csvImportController.batchStatus));
