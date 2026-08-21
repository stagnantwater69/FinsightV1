import type { FieldEvidence, ReceiptWarning } from "../../lib/receiptWarnings";

export interface ScanResult {
  id: number;
  extractedDate: string | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: number | null;
  /** The lines FinSight read off the receipt. Empty on a total-only receipt. */
  items: ScannedItem[];
  /**
   * True when FinSight could not read the receipt's text at all and had AI
   * interpret the photograph instead. These values are a machine's reading of
   * a picture rather than of text, and the screen says so — see the callout.
   */
  visionAssisted?: boolean;
  /**
   * How readable the photograph itself was. Present only on the upload
   * response — it answers "should you take another one?", which is only worth
   * answering while the owner is still holding the receipt.
   */
  captureQuality?: { sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null;
  /** How sure OCR was about this page, 0-100. Null when not measured. */
  ocrConfidence?: number | null;
  /** The line most likely misread, when the items don't add up. */
  suspectItemId?: number | null;
  /**
   * True when the photograph appears to hold more than one receipt.
   *
   * Advisory only. FinSight cannot tell which items belong to which receipt,
   * so it says what it noticed and leaves the decision with the owner.
   */
  looksLikeMultipleReceipts?: boolean;
  /**
   * Every page's own quality reading, in the order they were photographed.
   * Present only on the upload response, for the same reason captureQuality
   * is — it answers "should you retake one of these?", which stops mattering
   * once the scan is confirmed or abandoned.
   */
  pageQualities?: ({ sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null)[];
  /**
   * 1-indexed page numbers that read as the same page photographed twice.
   * Empty on a single-page scan — there is nothing adjacent to compare.
   */
  duplicatePages?: number[];
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
   * Machine-readable warnings the pipeline recorded, each carrying the
   * server's own actionable guidance sentence.
   *
   * These REPLACE the hardcoded prose this screen used to keep per boolean.
   * Web and mobile each wrote their own wording for the same signals and the
   * two had already drifted; the sentence is now the server's, and rendering
   * anything else here re-creates that bug. See lib/receiptWarnings.ts.
   */
  warnings?: ReceiptWarning[];
  /**
   * Where each extracted value was read from — page, the visible line, and
   * which engine read it. Null for scans read before evidence was recorded,
   * and nulls inside an entry where the origin could not be located. Never
   * invented.
   */
  fieldEvidence?: Record<string, FieldEvidence> | null;
}

export interface ScannedItem {
  id: number;
  lineNumber: number;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  /** FinSight's automatic assignment; the owner may change it. */
  categoryId: number | null;
  /** True for a line the owner typed in, false for one OCR read. */
  addedByOwner?: boolean;
  /**
   * True for a line AI read off the photograph because OCR found none.
   *
   * Kept distinct from an OCR-read line for the same reason addedByOwner is:
   * this screen tells the owner FinSight *read* these items, and that claim
   * must not quietly stretch to cover one a model inferred from a picture.
   */
  extractedByVision?: boolean;
  /**
   * A category FinSight thinks this item needs but the business doesn't have.
   *
   * Only ever an offer. Nothing is created until the owner accepts it — a
   * category appearing in their books that they never asked for is exactly
   * what the categoriser's grounding rules exist to prevent.
   */
  suggestedCategoryName?: string | null;
  /** How sure OCR was about THIS amount, 0-100, or null if not measured. */
  amountConfidence?: number | null;
  /** Which page and printed line this item was read from, and by what. */
  evidence?: FieldEvidence | null;
}

/**
 * A line the owner is adding because OCR missed it.
 *
 * Held client-side until Confirm, like every other answer on this screen —
 * nothing is written until the owner accepts the whole receipt.
 */
export interface AddedItem {
  /** Local only, for React keys and edits. Server ids don't exist yet. */
  key: string;
  name: string;
  amount: number | "";
  categoryId: number | "";
}

/** One category's share of a receipt. `""` is the not-yet-entered state. */
export interface Split {
  categoryId: number | "";
  amount: number | "";
}

/**
 * Where a field's current value came from.
 *
 * This is the mechanism behind UAT item 29 ("it was clear I could correct the
 * scanned details before saving"). Previously every field was an ordinary
 * input: a vendor OCR failed to read looked exactly like a vendor the owner had
 * deliberately cleared, and nothing on screen distinguished a value FinSight
 * guessed from one the owner typed. The only signal was a single 12px line
 * above the whole form.
 */
export type Origin = "read" | "derived" | "missing" | "edited";

/**
 * The stages of a read, in the order they happen.
 *
 * Each one corresponds to something the client can actually OBSERVE:
 *
 *   uploading    — the multipart POST is in flight.
 *   reading      — the server accepted the photos and is running OCR; this is
 *                  what `processingStatus: "Processing"` means, and it is what
 *                  the poll is waiting on.
 *   checking     — the read came back Complete. The arithmetic reconciliation
 *                  and warnings are already in that response, so this stage is
 *                  the client resolving them against the owner's categories.
 *   categorising — the category list is being refreshed so every item's
 *                  assigned category has an option to render into.
 *
 * There is no fifth "checking duplicates" stage because duplicate detection
 * happens after the record is SAVED, not during the read — showing it here
 * would be describing work that is not being done.
 */
export const SCAN_STAGES = ["uploading", "reading", "checking", "categorising"] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];
