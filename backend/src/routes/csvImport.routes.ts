import { Router, type RequestHandler } from "express";
import * as csvImportController from "../controllers/csvImport.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { uploadCsv } from "../middleware/upload.middleware";
import { LIMITS, rateLimit } from "../middleware/rateLimit.middleware";
import { handleCsvHttpWork, limitCsvHttpWork } from "../middleware/csvHttpWorkLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const csvImportRouter = Router();
const initialStageUploadRateLimit = rateLimit(LIMITS.CSV_STAGE_UPLOAD_BURST);
const limitInitialStageUpload: RequestHandler = (req, res, next) => {
  if (req.is("multipart/form-data")) {
    return initialStageUploadRateLimit(req, res, next);
  }
  next();
};

csvImportRouter.use(requireAuth);
csvImportRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.locals.csvImportRequest = true;
  next();
});

/* Multipart uploads take the lower staging limit before multer allocates the
 * file buffer. JSON review requests keep the broader preview limit. */
csvImportRouter.post(
  "/preview",
  rateLimit(LIMITS.CSV_PREVIEW_BURST),
  limitInitialStageUpload,
  limitCsvHttpWork,
  uploadCsv.single("file"),
  handleCsvHttpWork(csvImportController.preview),
);
csvImportRouter.post(
  "/confirm",
  rateLimit(LIMITS.CSV_CONFIRM_BURST),
  rateLimit(LIMITS.CSV_CONFIRM_HOURLY),
  limitCsvHttpWork,
  uploadCsv.single("file"),
  handleCsvHttpWork(csvImportController.confirm),
);
csvImportRouter.delete(
  "/stages/:stageId",
  rateLimit(LIMITS.CSV_PREVIEW_BURST),
  asyncHandler(csvImportController.deleteStage),
);
csvImportRouter.get("/batches", asyncHandler(csvImportController.listBatches));
csvImportRouter.get(
  "/batches/:batchId/preview",
  rateLimit(LIMITS.CSV_PREVIEW_BURST),
  limitCsvHttpWork,
  handleCsvHttpWork(csvImportController.previewBatch),
);
/*
 * Polled by both clients while a large import runs, so deliberately NOT rate
 * limited — same reasoning as the receipt scan's GET: two indexed reads, no
 * parsing, no writes, and a limit sized for confirms would start rejecting the
 * very polling that the async import depends on.
 */
csvImportRouter.get("/batches/:batchId/status", asyncHandler(csvImportController.batchStatus));
