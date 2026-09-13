import type { ReceiptWarning } from "../../lib/receiptWarnings";
import type { ReconciliationMode } from "../../lib/allocation";
import type { ParsedLineItem, ParsedReceiptFields } from "../ocr.service";
import type { VisionRejectReason } from "../visionOcr.service";
import type { VeryfiRejectReason } from "../veryfiOcr.service";
import { RECEIPT_UPLOAD_MAX_LOGICAL_PAGES } from "../../lib/receiptUploadContract";

/** One photographed page of a receipt, as it arrives from the upload. */
export interface UploadPage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  /** Optional derived scanner/crop output. `buffer` always remains evidence. */
  processed?: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
  };
  metadata?: ReceiptCaptureMetadata;
}

export interface ReceiptCaptureMetadata {
  captureMode?: "standard" | "long";
  source?: "manual-camera" | "native-document-scanner" | "gallery";
  processingMode?: "original" | "manual-crop" | "native-selected" | "clear-colour" | "grayscale" | "black-white";
  originalWidth?: number;
  originalHeight?: number;
  processedWidth?: number;
  processedHeight?: number;
  corners?: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
  };
  transformVersion?: string;
  documentConfidence?: number;
  ownerOverrodeLikelihood?: boolean;
}

/**
 * A receipt too long for one photograph is now several pages of ONE scan.
 * `pages` is always non-empty; a single photo is simply a one-element array
 * — there is no separate "one page" shape to keep in sync with this one.
 */
export interface UploadInput {
  businessProfileId: number;
  pages: UploadPage[];
  /** Reuse for retries of one selected receipt; use a new token after edits. */
  idempotencyKey?: string;
}

export interface BufferedReceiptUploadFile {
  source?: "buffer";
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface TemporaryReceiptUploadFile {
  source: "temporary-file";
  temporaryPath: string;
  sizeBytes: number;
  mimetype: string;
  originalname: string;
}

export type ReceiptUploadFile = BufferedReceiptUploadFile | TemporaryReceiptUploadFile;

export type ReceiptUploadPage = ReceiptUploadFile & {
  processed?: ReceiptUploadFile;
  metadata?: ReceiptCaptureMetadata;
};

export interface ReceiptUploadSubmission {
  businessProfileId: number;
  pages: ReceiptUploadPage[];
  idempotencyKey?: string;
  receiptBatchId?: number;
  receiptOrdinal?: number;
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
  expectedScanRevision?: number;
  duplicateDecision?: {
    action: "SAVE_ANYWAY";
    candidateSetHash: string;
  };
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
   * Stored as real ReceiptScanItem rows (flagged `addedByOwner`) inside the
   * confirmation transaction, before the grouping runs, so a hand-added line
   * is grouped, linked to its record and shown on the record afterwards
   * exactly like an extracted one — while still being distinguishable from
   * something FinSight claims to have read, and never left behind by a
   * confirmation that was refused.
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
export const MAX_PAGES = RECEIPT_UPLOAD_MAX_LOGICAL_PAGES;

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
  /** Which local signal requested provider rescue, or null for a clean local draft. */
  visionTrigger: string | null;
  /** Wall-clock ms of the vision call. Null when no call was made. */
  visionLatencyMs: number | null;
  /**
   * The single provider submitted through the dispatch gate; null when local
   * processing completed without a provider call.
   */
  visionProvider: "gemini" | "veryfi" | null;
  /** The model that answered, parsed from the endpoint actually called. Null when visionProvider is null. */
  visionModel: string | null;
  /** Why an answered rescue was thrown away at the validation boundary, or null. */
  visionRejectReason: VisionRejectReason | VeryfiRejectReason | null;
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
