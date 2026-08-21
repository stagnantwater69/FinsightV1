import type { ReceiptWarning } from "../../lib/receiptWarnings";
import type { ReconciliationMode } from "../../lib/allocation";
import type { ParsedLineItem, ParsedReceiptFields } from "../ocr.service";
import type { VisionRejectReason } from "../visionOcr.service";

/** One photographed page of a receipt, as it arrives from the upload. */
export interface UploadPage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/**
 * A receipt too long for one photograph is now several pages of ONE scan.
 * `pages` is always non-empty; a single photo is simply a one-element array
 * — there is no separate "one page" shape to keep in sync with this one.
 */
export interface UploadInput {
  businessProfileId: number;
  pages: UploadPage[];
}

export interface ReceiptSplit {
  categoryId: number;
  amount: number;
  /** The extracted lines that composed this split, on the itemised path. */
  itemIds?: number[];
  /**
   * Overrides the receipt-level description for this line. Unused by the
   * confirm screen today — it exists for line-item extraction, which needs
   * to say "12 items: chicken, buns, …" on the Inventory split and something
   * different on the Equipment one.
   */
  description?: string;
  /**
   * The part of `amount` that is this split's share of receipt-level tax,
   * service charge or discount rather than the price of its own items.
   * Signed. Absent when the receipt reconciled exactly.
   */
  allocatedCharges?: number;
}

export interface ConfirmInput {
  date: string;
  description: string;
  vendor?: string;
  /** The receipt's total, as read and confirmed by the owner. */
  amount: number;
  /**
   * One entry per category this receipt covers. Must sum to `amount`.
   * Used by the single-total flow and by a hand-made split.
   */
  splits?: ReceiptSplit[];
  /**
   * The itemised path: the owner's final say on which category each extracted
   * line belongs to. When present it takes precedence over `splits` — the
   * server groups the items itself rather than trusting a client-computed
   * split, so the item -> record links it writes cannot disagree with the
   * amounts it posts.
   */
  itemAssignments?: { itemId: number; categoryId: number }[];
  /**
   * Lines the owner typed in on the confirm screen because OCR missed them.
   * Stored as real ReceiptScanItem rows (flagged `addedByOwner`) before the
   * grouping runs, so a hand-added line is grouped, linked to its record and
   * shown on the record afterwards exactly like an extracted one — while
   * still being distinguishable from something FinSight claims to have read.
   */
  additionalItems?: { name: string; amount: number; categoryId: number }[];
  /**
   * How to account for any difference between the items and the confirmed
   * total. Only meaningful on the itemised path. Defaults to `none`, which
   * requires the items to already reconcile.
   */
  reconciliation?: ReconciliationMode;
}

/** Description given to the standalone record that carries a receipt's tax. */
export const CHARGES_DESCRIPTION = "Tax and charges";

/**
 * A receipt too long for one photograph, and not a receipt any more.
 *
 * Exported so the upload route's multer limit and this function's own check
 * are the same number rather than two copies that could quietly disagree —
 * the same discipline duplicateKeyOf documents for its own shared constant.
 */
export const MAX_PAGES = 8;

/**
 * What the scan ended up with, whether a model had a hand in it — and the
 * audit trail of the attempt, so the persisted extractorVersions record can
 * say WHAT was tried, HOW LONG it took and WHY it was or wasn't used instead
 * of that story living only in a console line.
 */
export interface RescuedFields extends ParsedReceiptFields {
  items: ParsedLineItem[];
  /** True when the vision model supplied any of the above. */
  visionAssisted: boolean;
  /** True when the ITEMS specifically came from the model rather than OCR text. */
  itemsFromVision: boolean;
  /** Which trigger sent the scan to the model, or null when the deterministic read stood on its own. */
  visionTrigger: string | null;
  /** Wall-clock ms of the vision call. Null when no call was made. */
  visionLatencyMs: number | null;
  /** "gemini" when the provider actually answered (accepted OR rejected); null when it was never usefully reached. */
  visionProvider: "gemini" | null;
  /** The model that answered, parsed from the endpoint actually called. Null when visionProvider is null. */
  visionModel: string | null;
  /** Why an answered rescue was thrown away at the validation boundary, or null. */
  visionRejectReason: VisionRejectReason | null;
  /** Verifier outcome on a high-risk result: "accepted" | "rejected:<fields>" | null when it never ran. */
  verifier: string | null;
  /** Warnings raised by the model or the verifier, already in the shared vocabulary. */
  visionWarnings: ReceiptWarning[];
  /**
   * Per-item evidence for MODEL-supplied items (the model's own reported page
   * and source text), aligned with `items`. Null on the deterministic path —
   * the caller locates OCR items in the page text itself.
   */
  itemEvidence: ({ pageNumber: number | null; sourceText: string | null } | null)[] | null;
}

/** One field's provenance, as persisted in ReceiptScan.fieldEvidence. */
export interface FieldEvidenceEntry {
  pageNumber: number | null;
  sourceText: string | null;
  source: "ocr" | "vision";
}
