/**
 * The receipt-scan warning vocabulary, as the client consumes it.
 *
 * DELIBERATELY CODES AND TONES ONLY — NO PROSE. The sentence an owner reads
 * for each code is `warning.guidance`, which the SERVER owns
 * (backend/src/lib/receiptWarnings.ts). That is the whole point of the
 * contract: web and mobile each used to hardcode their own wording for the
 * same signals, and the two had already drifted apart. A client that writes
 * its own sentence here re-creates the bug.
 *
 * What stays client-side is presentation: which tone the callout takes, and
 * which extracted field (if any) a warning points at.
 */

export const RECEIPT_WARNING_CODES = [
  "BLURRY_PAGE",
  "TOO_SMALL",
  "DUPLICATE_PAGE",
  "OVERLAPPING_PAGES",
  "MULTI_RECEIPT",
  "UNEXPLAINED_GAP",
  "LOW_CONFIDENCE",
  "VISION_INTERPRETED",
  "AMBIGUOUS_DATE",
  "UNREADABLE_FIELD",
] as const;

export type ReceiptWarningCode = (typeof RECEIPT_WARNING_CODES)[number];

export interface ReceiptWarning {
  code: ReceiptWarningCode;
  /**
   * The server's one actionable sentence for this code. Rendered verbatim.
   * Null only for a code this server build has no guidance for, in which case
   * the warning is shown with its evidence and no instruction — better than
   * an invented one.
   */
  guidance: string | null;
  /** Which extracted field the warning is about ("date", "vendor", "amount"). */
  field?: string;
  pageNumber?: number;
  /** Free-text evidence — the visible source text, the size of a gap. */
  detail?: string;
}

/** Where one extracted value came from. Never invented; nulls where unknown. */
export interface FieldEvidence {
  pageNumber: number | null;
  sourceText: string | null;
  source: "ocr" | "vision" | string | null;
}

/**
 * `OVERLAPPING_PAGES` is the odd one out: it describes the capture overlap the
 * multi-page guide ASKS for. It is reported so the owner can check nothing was
 * counted twice, not because anything went wrong — an amber warning for
 * following the instructions is how a warning system loses its meaning.
 */
const INFORMATIONAL: ReadonlySet<string> = new Set<ReceiptWarningCode>(["OVERLAPPING_PAGES"]);

export function warningTone(code: string): "info" | "warn" {
  return INFORMATIONAL.has(code) ? "info" : "warn";
}

/** A short heading for the warning, so the callout isn't guidance alone. */
const WARNING_HEADLINE: Record<ReceiptWarningCode, string> = {
  BLURRY_PAGE: "This photo came out blurry",
  TOO_SMALL: "The receipt is small in the frame",
  DUPLICATE_PAGE: "Two photos look like the same page",
  OVERLAPPING_PAGES: "These pages overlap",
  MULTI_RECEIPT: "This photo may hold more than one receipt",
  UNEXPLAINED_GAP: "The items don't add up to the total",
  LOW_CONFIDENCE: "This receipt was hard to read",
  VISION_INTERPRETED: "Some values were interpreted from the photo",
  AMBIGUOUS_DATE: "The printed date could be read two ways",
  UNREADABLE_FIELD: "Part of this receipt couldn't be read",
};

export function warningHeadline(code: string): string {
  return WARNING_HEADLINE[code as ReceiptWarningCode] ?? "FinSight flagged something on this receipt";
}

/**
 * A page number the warning names, formatted for the headline.
 * Kept out of the headline table so the table stays one string per code.
 */
export function warningPageSuffix(warning: ReceiptWarning): string {
  return typeof warning.pageNumber === "number" ? ` (page ${warning.pageNumber})` : "";
}

/**
 * The extracted fields a scan's warnings point at, normalised to the review
 * screen's own field names.
 *
 * This is what turns "Check a few fields" into something actionable — the
 * screen focuses the first of these rather than asking the owner to re-read
 * all four.
 */
export type ReceiptField = "date" | "vendor" | "description" | "amount";

const FIELD_ALIASES: Record<string, ReceiptField> = {
  date: "date",
  extracteddate: "date",
  vendor: "vendor",
  extractedvendor: "vendor",
  merchant: "vendor",
  description: "description",
  extracteddescription: "description",
  amount: "amount",
  extractedamount: "amount",
  total: "amount",
};

export function normaliseField(field: string | undefined): ReceiptField | null {
  if (!field) return null;
  return FIELD_ALIASES[field.trim().toLowerCase()] ?? null;
}

/** Every field a warning names, in the order the review form presents them. */
export function fieldsNeedingAttention(warnings: ReceiptWarning[]): ReceiptField[] {
  const order: ReceiptField[] = ["date", "description", "vendor", "amount"];
  const named = new Set<ReceiptField>();
  for (const w of warnings) {
    const field = normaliseField(w.field);
    if (field) named.add(field);
  }
  return order.filter((f) => named.has(f));
}
