import type { CapturedPage, ReceiptScanResult } from "./types";

/**
 * DELETE /records/receipts/:id answers 409 PURGE_IN_PROGRESS when a purge for
 * that scan is already running. The code is the contract; the sentence is a
 * fallback for a server build that predates it.
 */
export function purgeAlreadyUnderway(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { status, code, responseBody, message } = err as {
    status?: unknown; code?: unknown; responseBody?: unknown; message?: unknown;
  };
  if (status !== 409) return false;
  const bodyCode = (responseBody as { code?: unknown } | null | undefined)?.code;
  if (code === "PURGE_IN_PROGRESS" || bodyCode === "PURGE_IN_PROGRESS") return true;
  return typeof message === "string" && /already being deleted/i.test(message);
}

export interface ReceiptBatchChild {
  batchId: number;
  ordinal: number;
  /** Present for a newly created batch; history summaries expose only this child's binding. */
  expectedReceiptCount?: number;
}

export interface QueuedReceipt {
  pages: CapturedPage[];
  batchChild: ReceiptBatchChild;
  /** Present only after the server has accepted this child and owns its images. */
  accepted: ReceiptScanResult | null;
}

export type ScanRecoveryAction = "review" | "retry" | null;
export type ScanRunMode = "upload" | "review" | "retry";
export function storedReceiptPages(result: ReceiptScanResult, pageCount: number): CapturedPage[] {
  const evidence = [...(result.pageEvidence ?? [])].sort((left, right) => left.pageNumber - right.pageNumber);
  const count = Math.max(1, pageCount, evidence.length);
  return Array.from({ length: count }, (_, index) => {
    const page = evidence.find((candidate) => candidate.pageNumber === index + 1);
    return {
      key: `stored-${result.id}-${index + 1}`,
      uri: "",
      fileName: `stored-receipt-${result.id}-page-${index + 1}.jpg`,
      mimeType: "image/jpeg",
      originalMimeType: "image/jpeg",
      quality: null,
      checkingQuality: false,
      width: page?.derived?.width ?? page?.source.width ?? 0,
      height: page?.derived?.height ?? page?.source.height ?? 0,
      originalWidth: page?.source.width ?? 0,
      originalHeight: page?.source.height ?? 0,
      captureMode: page?.captureMode ?? undefined,
      processingMode: page?.processingMode,
    };
  });
}

/**
 * Phases where cancelling stops bytes leaving the phone. Every other phase
 * is a wait on a receipt the server already holds, so "Cancel upload" would
 * promise an undo that is not on offer.
 */
export function cancelsAnUpload(phase: string): boolean {
  return phase.startsWith("Uploading")
    || phase === "Checking receipt size…"
    || phase === "Creating receipt batch…"
    || phase === "Replacing cancelled receipt batch…";
}

/** What stopping leaves the owner with, by what this phone actually holds. */
export function stoppedWaitingMessage(accepted: boolean, hasLocalImages: boolean): string {
  if (accepted) {
    return hasLocalImages
      ? "Your uploaded images are kept. Review the result when you're ready."
      : "The stored receipt is kept. Review the result when you're ready.";
  }
  return hasLocalImages
    ? "Your selected images are kept. Start the upload again when you're ready."
    : "Nothing changed. The receipt is still listed under Receipts to finish.";
}
