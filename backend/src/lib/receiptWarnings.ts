/**
 * Machine-readable receipt-scan warnings — ONE vocabulary, defined once.
 *
 * The defect this prevents: the pipeline already computed most of these
 * signals (a blurred page, a duplicate page, an unexplained arithmetic gap,
 * a vision-interpreted read) but exposed them as scattered booleans, and the
 * two clients each hardcoded their own prose for them — which had already
 * drifted apart. A warning is now a CODE the server emits and the clients
 * render from, so "what is wrong with this scan" has exactly one source.
 *
 * Codes, not sentences, in the database: prose changes with copywriting and
 * localisation, and a stored sentence would freeze whichever draft was
 * current on the day the scan happened.
 */

export const WARNING_CODES = [
  /** A photographed page too blurred for its reading to be trusted. */
  "BLURRY_PAGE",
  /** The image carries too few pixels for OCR to have a fair chance. */
  "TOO_SMALL",
  /** An adjacent page that reads as the same page photographed twice. */
  "DUPLICATE_PAGE",
  /** A page whose first lines repeat the previous page's last ones — the capture overlap, expected on a long receipt. */
  "OVERLAPPING_PAGES",
  /** The photograph appears to hold more than one receipt. */
  "MULTI_RECEIPT",
  /** The items do not account for the printed total and no line on the receipt explains the gap. */
  "UNEXPLAINED_GAP",
  /** The OCR engine's own confidence on the worst page fell below the calibrated floor. */
  "LOW_CONFIDENCE",
  /** A vision model interpreted the photograph; values were guessed from an image, not read off text. */
  "VISION_INTERPRETED",
  /** A numeric date both of whose components could be the month — resolved DD/MM by convention, not by reading. */
  "AMBIGUOUS_DATE",
  /** A field that could not be read from the document, or that a verifier pass rejected as unsupported. */
  "UNREADABLE_FIELD",
  /** Line items an external provider read that do not add up to the total; prefilled for review, never validated. */
  "UNVERIFIED_ITEMS",
] as const;

export type ReceiptWarningCode = (typeof WARNING_CODES)[number];

/** One warning, as persisted on ReceiptScan.warnings. */
export interface ReceiptWarning {
  code: ReceiptWarningCode;
  /** Which extracted field the warning is about, where it is about one ("date", "amount", ...). */
  field?: string;
  /** Which 1-indexed page, where the warning is about one. */
  pageNumber?: number;
  /** Free-text evidence — the visible source text, the size of a gap. Never required to act on the code. */
  detail?: string;
}

export function isReceiptWarningCode(value: unknown): value is ReceiptWarningCode {
  return typeof value === "string" && (WARNING_CODES as readonly string[]).includes(value);
}

/**
 * What the owner can actually DO about each warning.
 *
 * One table on the server rather than a copy per client, for the same drift
 * reason as the codes themselves. These are capture guidance in en-PH product
 * voice; clients localise later, but the MEANING of each code is fixed here.
 */
export const WARNING_GUIDANCE: Record<ReceiptWarningCode, string> = {
  BLURRY_PAGE: "Hold the phone steady and retake this page.",
  TOO_SMALL: "Move closer and retake this page.",
  DUPLICATE_PAGE: "This page may be repeated. Remove it if it is a duplicate.",
  OVERLAPPING_PAGES: "Pages overlap. Check that each item appears once.",
  MULTI_RECEIPT: "Scan each receipt separately.",
  UNEXPLAINED_GAP: "The items and total differ. Check the amounts.",
  LOW_CONFIDENCE: "Check the amounts before saving.",
  VISION_INTERPRETED: "AI helped read this receipt. Review the details.",
  AMBIGUOUS_DATE: "Check the day and month.",
  UNREADABLE_FIELD: "Fill in the missing value from the receipt.",
  UNVERIFIED_ITEMS: "AI read these items but they don't add up to the total. Check each line against the receipt.",
};
