import type { SectionQuality } from "../../../lib/receiptCapture";
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
  extractedDate: string | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: number | null;
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
  /** Why the read failed. Present only when processingStatus is "Failed". */
  processingError?: string | null;
  /**
   * The individual lines the server read, each with the category it assigned.
   * A receipt with more than one is reviewed line by line below; anything
   * less keeps the single-category flow.
   */
  items?: {
    id: number;
    name: string;
    quantity: number | null;
    amount: number;
    /** What FinSight assigned. Null when nothing on the list fitted. */
    categoryId: number | null;
    /** True for a line a vision model produced rather than OCR text. */
    extractedByVision?: boolean;
    /** A category FinSight thinks is missing. Only ever an offer. */
    suggestedCategoryName?: string | null;
    /** How sure OCR was about THIS amount, 0-100, or null if not measured. */
    amountConfidence?: number | null;
    /** Which page and printed line this item came from, and by what. Null
     *  where nothing could be located, including every older scan. */
    evidence?: FieldEvidence | null;
  }[];
}

/** One photograph in a capture session, before it has been scanned. */
export interface CapturedPage {
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
}

/** One thing the owner should look at before saving. */
export interface ReviewNotice {
  tone: "warn" | "info";
  text: string;
}
