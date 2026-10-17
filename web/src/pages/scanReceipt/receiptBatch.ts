import { isAxiosError } from "axios";
import type { ReceiptCaptureBatch } from "./types";

export interface BatchReceiptBinding {
  batchId: number;
  receiptOrdinal: number;
}

/**
 * A receipt batch response controls which private uploads are attached to a
 * selection. Do not trust its TypeScript annotation at the HTTP boundary.
 */
export function isCollectingReceiptBatch(
  value: unknown,
  businessProfileId: number,
  expectedReceiptCount: number,
): value is ReceiptCaptureBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const batch = value as Record<string, unknown>;
  return Number.isInteger(batch.id)
    && Number(batch.id) > 0
    && batch.businessProfileId === businessProfileId
    && batch.expectedReceiptCount === expectedReceiptCount
    && batch.status === "COLLECTING"
    && batch.uploadedReceiptCount === 0
    && Array.isArray(batch.receipts)
    && batch.receipts.length === 0;
}

export function isCancelledReceiptBatch(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { status?: unknown }).status === "CANCELLED");
}

/**
 * DELETE /records/receipts/:id answers 409 for more than one reason. Only the
 * "purge already running" one means the row is gone; a scan that already has
 * financial records, or a reused idempotency key, still needs the owner to read
 * the message.
 */
export function isDeletionAlreadyUnderway(error: unknown): boolean {
  if (!isAxiosError(error) || error.response?.status !== 409) return false;
  const body = error.response.data as { error?: unknown; code?: unknown } | undefined;
  // The stable code is the contract; the message match keeps older servers working.
  return body?.code === "PURGE_IN_PROGRESS" || (typeof body?.error === "string" && /already being deleted/i.test(body.error));
}

/** The server binds an upload key to one batch slot or to a single receipt. */
export function uploadBindingKey(batch?: BatchReceiptBinding): string {
  return batch ? `batch:${batch.batchId}:${batch.receiptOrdinal}` : "single";
}
