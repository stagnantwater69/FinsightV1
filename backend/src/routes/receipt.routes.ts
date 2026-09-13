import { Router } from "express";
import * as receiptScanController from "../controllers/receiptScan.controller";
import { requireAuth } from "../middleware/auth.middleware";
import {
  prepareReceiptUploadTemporaryFiles,
  uploadReceiptEvidence,
  uploadReceiptImage,
} from "../middleware/upload.middleware";
import { LIMITS, rateLimit } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../lib/asyncHandler";
import { RECEIPT_UPLOAD_MAX_LOGICAL_PAGES } from "../lib/receiptUploadContract";
import * as receiptProviderConsentController from "../controllers/receiptProviderConsent.controller";

export const receiptRouter = Router();

receiptRouter.use(requireAuth);
receiptRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

receiptRouter.get(
  "/provider-consent/:businessProfileId",
  asyncHandler(receiptProviderConsentController.show),
);
receiptRouter.put(
  "/provider-consent/:businessProfileId",
  rateLimit(LIMITS.PROVIDER_CONSENT_WRITE),
  asyncHandler(receiptProviderConsentController.grant),
);
receiptRouter.delete(
  "/provider-consent/:businessProfileId",
  rateLimit(LIMITS.PROVIDER_CONSENT_WRITE),
  asyncHandler(receiptProviderConsentController.revoke),
);

/*
 * The most expensive request in the product: OCR per page, then possibly a
 * vision model re-read, then the categoriser. Limited BEFORE multer so a
 * rejected burst does not even pay to parse the uploaded images off the wire.
 *
 * The full upload uses request-owned temporary files. Capture-only helpers
 * below keep their existing single-image memory path.
 */
receiptRouter.post(
  "/",
  rateLimit(LIMITS.SCAN_RECEIPT_BURST),
  rateLimit(LIMITS.SCAN_RECEIPT_HOURLY),
  prepareReceiptUploadTemporaryFiles,
  uploadReceiptEvidence.fields([
    { name: "files", maxCount: RECEIPT_UPLOAD_MAX_LOGICAL_PAGES },
    { name: "originalFiles", maxCount: RECEIPT_UPLOAD_MAX_LOGICAL_PAGES },
  ]),
  asyncHandler(receiptScanController.upload),
);
receiptRouter.get("/", asyncHandler(receiptScanController.index));
/*
 * One photo's own readability, checked the moment it is taken — see the
 * controller for why this is separate from the full upload.
 */
receiptRouter.post(
  "/quality-check",
  rateLimit(LIMITS.QUALITY_CHECK_BURST),
  uploadReceiptImage.single("file"),
  asyncHandler(receiptScanController.checkQuality),
);
/*
 * Where the receipt sits in a photograph — the crop editor's starting handles.
 *
 * Sits beside quality-check rather than inside the upload because it answers
 * the same kind of question at the same moment (right after the shutter, with
 * nothing written anywhere), and because the answer is only ever a proposal
 * the owner adjusts. See the controller for why detection is server-side.
 */
receiptRouter.post(
  "/detect-edges",
  rateLimit(LIMITS.EDGE_DETECT_BURST),
  uploadReceiptImage.single("file"),
  asyncHandler(receiptScanController.detectEdges),
);
/*
 * Applies the corners the owner settled on. Its own limiter rather than
 * edge-detect's — see LIMITS.TRANSFORM_BURST.
 */
receiptRouter.post(
  "/transform",
  rateLimit(LIMITS.TRANSFORM_BURST),
  uploadReceiptImage.single("file"),
  asyncHandler(receiptScanController.transform),
);
/*
 * Polled by both clients after an upload until the read finishes.
 *
 * Deliberately NOT rate-limited alongside the expensive endpoints above: this
 * one runs two indexed queries and no OCR, no model call and no Storage
 * write, and it is called REPEATEDLY by design — a burst limit sized for
 * scans would start rejecting the very polling that scanning now depends on.
 */
receiptRouter.get(
  "/:id/pages/:pageNumber/image/:variant",
  asyncHandler(receiptScanController.showPageImage),
);
receiptRouter.get("/:id/duplicate-candidates", asyncHandler(receiptScanController.duplicateCandidates));
receiptRouter.get("/:id", asyncHandler(receiptScanController.show));
receiptRouter.post("/:id/retry", rateLimit(LIMITS.SCAN_RECEIPT_BURST), asyncHandler(receiptScanController.retry));
receiptRouter.patch("/:id/items/:itemId", asyncHandler(receiptScanController.updateItem));
receiptRouter.delete("/:id/items/:itemId", asyncHandler(receiptScanController.deleteItem));
receiptRouter.post("/:id/confirm", asyncHandler(receiptScanController.confirm));
receiptRouter.delete(
  "/:id/images",
  rateLimit(LIMITS.RECEIPT_DELETE_WRITE),
  asyncHandler(receiptScanController.removeImages),
);
receiptRouter.delete(
  "/:id",
  rateLimit(LIMITS.RECEIPT_DELETE_WRITE),
  asyncHandler(receiptScanController.remove),
);
