import type { CaptureSource, Corners, ReceiptProcessingMode, SectionQuality } from "../../../lib/receiptCapture";
import type { FieldEvidence, ReceiptWarning } from "../../../lib/receiptWarnings";

/**
 * What POST /records/receipts returns.
 *
 * Typed rather than `any` because `any` is precisely how this screen drifted
 * off the API contract: the confirm call below sent a field the server had
 * stopped accepting, and nothing anywhere could tell. Naming the shape is the
 * cheapest guard against the next round of that.
 */
export interface ReceiptScanResult {
  id: number;
  businessProfileId: number;
  receiptBatchId: number | null;
  receiptOrdinal: number | null;
  /** Optimistic guard for edits to OCR-derived values. */
  scanRevision: number;
  extractedDate: string | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: number | null;
  requiresManualCurrencyConversion?: boolean;
  receiptDetails?: {
    currency: string | null;
    transactionTime: string | null;
    subtotal: number | null;
    tax: number | null;
    tip: number | null;
    discount: number | null;
    paymentMethod: string | null;
    receiptNumber: string | null;
  } | null;
  /**
   * True when the server could not read the receipt's TEXT and had a vision
   * model interpret the photograph instead. These values are a machine's
   * reading of a picture, and the screen has to say so.
   */
  visionAssisted?: boolean;
  /**
   * How readable the photograph itself was. Only present on the upload
   * response — it answers "should you take another one?", which is only worth
   * asking while the owner still has the receipt in front of them. On a phone
   * that is the whole point: the camera is right there.
   */
  captureQuality?: { sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null;
  /** How sure OCR was about this page, 0-100. Null when not measured. */
  ocrConfidence?: number | null;
  /** The line most likely misread, when the items don't add up to the total. */
  suspectItemId?: number | null;
  /**
   * True when the photograph appears to hold more than one receipt.
   *
   * Advisory only, and one-directional: false means "no evidence of a second
   * receipt", not "definitely one". The server cannot tell which items belong
   * to which receipt, so it says what it noticed and the owner — who is
   * holding the paper — decides.
   */
  looksLikeMultipleReceipts?: boolean;
  receiptLikelihood?: {
    version: string;
    score: number;
    outcome: "likely-receipt" | "uncertain" | "obvious-non-receipt";
  } | null;
  /**
   * Which stored variant OCR used for each page, in capture order.
   *
   * Kept separate from pageEvidence so an adjusted image is never presented as
   * though it replaced the owner's original photograph.
   */
  pageProcessing?: ReceiptPageProcessing[];
  /** Stored evidence variants available for each page, in printed order. */
  pageEvidence?: ReceiptPageEvidence[];
  /**
   * Every page's own quality reading, in the order they were photographed.
   * Present only on the upload response, for the same reason captureQuality
   * is — it stops mattering once the scan is confirmed or abandoned.
   */
  pageQualities?: ({ sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null)[];
  /**
   * 1-indexed page numbers that read as the same page photographed twice.
   * Empty on a single-page scan.
   */
  duplicatePages?: number[];
  /**
   * 1-indexed sections whose first lines repeat the previous section's last
   * ones — the overlap the capture guide asks for on a long receipt.
   *
   * Expected rather than wrong, which is why it is worded and toned
   * differently from duplicatePages above. Empty on a single-section scan.
   */
  overlappingPages?: number[];
  /**
   * Machine-readable warnings the pipeline recorded, each carrying the
   * SERVER's own actionable sentence in `guidance`.
   *
   * Rendered verbatim. Both clients used to hardcode their own prose for these
   * same signals and the two copies had already drifted apart —
   * backend/src/lib/receiptWarnings.ts is now the single source. Empty for
   * scans read before warnings existed, which is why the derived notices
   * further down still exist as a fallback.
   */
  warnings?: ReceiptWarning[];
  /**
   * Where each extracted value was read from: page, the visible source line,
   * and which engine read it. Null for scans read before evidence was
   * recorded; a null INSIDE an entry means that part could not be located and
   * is shown as absent rather than invented.
   */
  fieldEvidence?: Record<string, FieldEvidence> | null;
  /**
   * How far the server has got READING this scan: "Processing" | "Complete" |
   * "Failed". Distinct from confirmationStatus, which is the owner's own
   * decision afterwards. The upload responds before the read finishes, so
   * this is what pollUntilRead waits on.
   */
  processingStatus?: "Processing" | "Complete" | "Failed";
  confirmationStatus: "Pending" | "Confirmed" | "Deletion Pending";
  /** Why the read failed. Present only when processingStatus is "Failed". */
  processingError?: string | null;
  /** Stable failure code used for recovery choices without exposing provider details. */
  processingErrorCode?: string | null;
  /**
   * The individual lines the server read, each with the category it assigned.
   * A receipt with more than one is reviewed line by line below; anything
   * less keeps the single-category flow. Always present — the server sends
   * an empty array when no item lines parsed.
   */
  items: ScannedItem[];
}

/** One entry of ReceiptScanResult.pageProcessing. */
export interface ReceiptPageProcessing {
  pageNumber?: number;
  source: "original" | "processed";
  hasProcessedVariant: boolean;
  captureMetadata: unknown;
}

/**
 * One line the server read off the receipt, as returned in
 * ReceiptScanResult.items. Field set matches backend/src/services/receiptScan/dto.ts
 * and web's ScannedItem; mobile reads only a subset today.
 */
export interface ScannedItem {
  id: number;
  lineNumber: number;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  /** What FinSight assigned. Null when nothing on the list fitted. */
  categoryId: number | null;
  /** True for a line the owner typed in, false for one OCR read. */
  addedByOwner?: boolean;
  /** True for a line a vision model produced rather than OCR text. */
  extractedByVision?: boolean;
  /** A category FinSight thinks is missing. Only ever an offer. */
  suggestedCategoryName?: string | null;
  /** How sure OCR was about THIS amount, 0-100, or null if not measured. */
  amountConfidence?: number | null;
  /** Which page and printed line this item came from, and by what. Null
   *  where nothing could be located, including every older scan. */
  evidence?: FieldEvidence | null;
  /** Values the owner has corrected after OCR completed. */
  ownerEditedFields?: ("name" | "amount")[];
}

export type ReceiptCaptureBatchStatus =
  | "COLLECTING"
  | "PROCESSING"
  | "READY_FOR_REVIEW"
  | "PARTIAL_FAILURE"
  | "FAILED"
  | "COMPLETE"
  | "CANCELLED";

/**
 * What POST /records/receipt-batches returns.
 *
 * Each child's confirmationStatus is the same set the server writes on any
 * scan: an unreviewed child can be moved to "Deletion Pending" by a purge.
 */
export interface ReceiptCaptureBatch {
  id: number;
  businessProfileId: number;
  expectedReceiptCount: number;
  status: ReceiptCaptureBatchStatus;
  uploadedReceiptCount: number;
  createdAt: string;
  finishedAt: string | null;
  receipts: {
    receiptOrdinal: number;
    id: number;
    processingStatus: "Processing" | "Complete" | "Failed";
    confirmationStatus: "Pending" | "Confirmed" | "Deletion Pending";
    processingError: string | null;
    processingErrorCode: string | null;
    extractedDate: string | null;
    extractedVendor: string | null;
    extractedAmount: number | null;
    allowedActions: { retryProcessing: boolean; reviewResult: boolean };
  }[];
}

/**
 * Labels are the fixed set backend/src/services/receiptScan/pageEvidence.ts
 * emits; web's ReceiptPageEvidenceVariant lists the same seven.
 */
export interface ReceiptPageEvidenceVariant {
  variant: "source" | "derived";
  label: "Source" | "Composite source" | "Rectified" | "Enhanced color" | "Enhanced grayscale" | "Enhanced black and white" | "Processed";
  width: number | null;
  height: number | null;
}

export interface ReceiptPageEvidence {
  pageNumber: number;
  captureMode: "standard" | "long" | null;
  processingMode: ReceiptProcessingMode;
  ocrInput: "source" | "derived";
  source: ReceiptPageEvidenceVariant;
  derived: ReceiptPageEvidenceVariant | null;
}

export interface ReceiptPageImage extends ReceiptPageEvidenceVariant {
  pageNumber: number;
  url: string;
  expiresInSeconds: number;
}

export interface ReceiptHistoryItem {
  id: number;
  businessProfileId: number;
  receiptBatchId: number | null;
  receiptOrdinal: number | null;
  scanRevision: number;
  processingStatus: "Processing" | "Complete" | "Failed";
  confirmationStatus: "Pending" | "Confirmed" | "Deletion Pending";
  processingError: string | null;
  processingErrorCode: string | null;
  extractedDate: string | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: number | null;
  createdAt: string;
  pageCount: number;
  allowedActions: { retryProcessing: boolean; reviewResult: boolean };
}

export interface ReceiptHistoryPage {
  items: ReceiptHistoryItem[];
  nextCursor: string | null;
}

export interface ReceiptPurgeJob {
  id: number;
  receiptScanId: number;
  reason: string;
  status: string;
  stage: string;
  storageObjectsExpected: number;
  storageObjectsDeleted: number;
  requestedAt: string;
  completedAt: string | null;
  lastErrorCode: string | null;
}

/** One photograph in a capture session, before it has been scanned. */
export interface CapturedPage {
  captureMode?: "standard" | "long";
  sourceAssetUri?: string;
  /** Local only, for list keys and edits — the server assigns nothing yet. */
  key: string;
  uri: string;
  fileName: string;
  mimeType: string;
  /** Null while checkingQuality is true, or if the check failed silently. */
  quality: SectionQuality | null;
  checkingQuality: boolean;
  /**
   * The photograph's own pixels.
   *
   * Carried so a page can be handed BACK to the camera when the owner reopens
   * it to add another section — the crop editor cannot map a handle to a file
   * whose dimensions it does not know. Zero for pages captured before this
   * existed, which the camera reads as "not croppable" rather than crashing.
   */
  width: number;
  height: number;
  /** The uncropped original, when one is still around. */
  originalUri?: string;
  originalMimeType?: string;
  originalWidth?: number;
  originalHeight?: number;
  captureSource?: CaptureSource;
  processingMode?: ReceiptProcessingMode;
  transformVersion?: string;
  cropCorners?: Corners;
  documentConfidence?: number;
  ownerOverrodeLikelihood?: boolean;
  receiptGroupId?: string;
}

/** One thing the owner should look at before saving. */
export interface ReviewNotice {
  tone: "warn" | "info";
  text: string;
  detail?: string;
}
