/**
 * The scan verifier, kept out of the screen so it can be exercised directly.
 *
 * Every response the review flow trusts passes through here first: a
 * mismatched id, a batch binding belonging to another child, or a malformed
 * item list has to become a sentence the owner can read, never a TypeError
 * thrown inside a setState.
 */

import { RECEIPT_UPLOAD_MAX_LOGICAL_PAGES } from "../../../lib/receiptUploadContract";
import type { ReceiptScanResult } from "./types";

/** The batch child a response is expected to belong to. */
export interface ExpectedBatchChild {
  batchId: number;
  ordinal: number;
}

const RECEIPT_PROCESSING_MODES = new Set([
  "original",
  "manual-crop",
  "native-selected",
  "clear-colour",
  "grayscale",
  "black-white",
]);

function validEvidenceVariant(value: unknown, variant: "source" | "derived") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const dimension = (candidate: unknown) => candidate === null
    || (Number.isInteger(candidate) && Number(candidate) > 0 && Number(candidate) <= 40000);
  return data.variant === variant
    && typeof data.label === "string" && data.label.length > 0 && data.label.length <= 80
    && dimension(data.width) && dimension(data.height);
}

/** Rejects a mismatched scan or evidence map before it can drive review UI. */
export function verifiedReceiptScan(
  value: unknown,
  expectedId?: number,
  expectedBusinessProfileId?: number,
  expectedBatchChild?: ExpectedBatchChild | null,
): ReceiptScanResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FinSight returned a receipt result that could not be verified.");
  }
  const result = value as ReceiptScanResult;
  if (!Number.isInteger(result.id) || result.id <= 0
    || (expectedId !== undefined && result.id !== expectedId)
    || !Number.isInteger(result.businessProfileId) || result.businessProfileId <= 0
    || (expectedBusinessProfileId !== undefined && result.businessProfileId !== expectedBusinessProfileId)
    || (result.receiptBatchId !== null && (!Number.isInteger(result.receiptBatchId) || result.receiptBatchId <= 0))
    || (result.receiptOrdinal !== null && (!Number.isInteger(result.receiptOrdinal) || result.receiptOrdinal <= 0))
    || ((result.receiptBatchId === null) !== (result.receiptOrdinal === null))
    || (expectedBatchChild === null && (result.receiptBatchId !== null || result.receiptOrdinal !== null))
    || (expectedBatchChild !== undefined && expectedBatchChild !== null && (
      result.receiptBatchId !== expectedBatchChild.batchId
      || result.receiptOrdinal !== expectedBatchChild.ordinal
    ))
    || !Number.isInteger(result.scanRevision) || result.scanRevision < 0
    || (result.confirmationStatus !== "Pending"
      && result.confirmationStatus !== "Confirmed"
      && result.confirmationStatus !== "Deletion Pending")) {
    throw new Error("FinSight returned a receipt result that could not be verified.");
  }
  /*
   * Items are checked here rather than left to the screen because
   * showReceiptResult maps over them inside a setState: a response without an
   * items array surfaced as an uncaught TypeError mid-render, while every
   * other malformed field produced a sentence the owner could act on. Ids are
   * required distinct because itemCategories is keyed by them, and two lines
   * sharing an id would silently share one category.
   */
  if (!Array.isArray(result.items)) {
    throw new Error("FinSight returned a receipt result that could not be verified.");
  }
  const itemIds = new Set<number>();
  for (const item of result.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !Number.isInteger(item.id) || item.id <= 0 || itemIds.has(item.id)
      || typeof item.name !== "string"
      || typeof item.amount !== "number" || !Number.isFinite(item.amount)
      || (item.categoryId !== undefined && item.categoryId !== null
        && (!Number.isInteger(item.categoryId) || item.categoryId <= 0))) {
      throw new Error("FinSight returned a receipt result that could not be verified.");
    }
    itemIds.add(item.id);
  }
  if (result.pageEvidence !== undefined) {
    if (!Array.isArray(result.pageEvidence) || result.pageEvidence.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
      throw new Error("FinSight returned receipt image evidence that could not be verified.");
    }
    for (const [index, page] of result.pageEvidence.entries()) {
      if (!page || page.pageNumber !== index + 1
        || (page.captureMode !== null && page.captureMode !== "standard" && page.captureMode !== "long")
        || !RECEIPT_PROCESSING_MODES.has(page.processingMode)
        || (page.ocrInput !== "source" && page.ocrInput !== "derived")
        || !validEvidenceVariant(page.source, "source")
        || (page.derived !== null && !validEvidenceVariant(page.derived, "derived"))
        || (page.ocrInput === "derived" && page.derived === null)) {
        throw new Error("FinSight returned receipt image evidence that could not be verified.");
      }
    }
  }
  return result;
}
