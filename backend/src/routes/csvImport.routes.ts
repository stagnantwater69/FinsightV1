import { Router } from "express";
import * as csvImportController from "../controllers/csvImport.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { uploadCsv } from "../middleware/upload.middleware";
import { asyncHandler } from "../lib/asyncHandler";

export const csvImportRouter = Router();

csvImportRouter.use(requireAuth);

csvImportRouter.post("/preview", uploadCsv.single("file"), asyncHandler(csvImportController.preview));
csvImportRouter.post("/confirm", uploadCsv.single("file"), asyncHandler(csvImportController.confirm));
csvImportRouter.get("/batches", asyncHandler(csvImportController.listBatches));
csvImportRouter.get("/batches/:batchId/preview", asyncHandler(csvImportController.previewBatch));
