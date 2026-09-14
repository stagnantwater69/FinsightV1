import type { ReceiptHistoryItem, ReceiptScanResult } from "./types";

/** The row the active list would show for a scan this screen holds; mirrors web's summaryFromScan. */
export function summaryFromScan(scan: ReceiptScanResult, seededAtMs: number, localPageCount = 0): ReceiptHistoryItem {
  const processingStatus = scan.processingStatus ?? "Complete";
  // The scan result carries no createdAt; the refresh replaces this stamp with the server's.
  const createdAt = new Date(seededAtMs).toISOString();
  return {
    id: scan.id,
    businessProfileId: scan.businessProfileId,
    receiptBatchId: scan.receiptBatchId ?? null,
    receiptOrdinal: scan.receiptOrdinal ?? null,
    scanRevision: scan.scanRevision,
    processingStatus,
    confirmationStatus: scan.confirmationStatus === "Confirmed" ? "Confirmed" : "Pending",
    processingError: scan.processingError ?? null,
    processingErrorCode: scan.processingErrorCode ?? null,
    extractedDate: scan.extractedDate,
    extractedVendor: scan.extractedVendor,
    extractedDescription: scan.extractedDescription,
    extractedAmount: scan.extractedAmount,
    createdAt,
    pageCount: scan.pageEvidence?.length || localPageCount,
    allowedActions: {
      retryProcessing: processingStatus === "Failed",
      reviewResult: processingStatus === "Complete",
    },
  };
}

/** Puts just-abandoned scans first. A row already listed keeps its server createdAt and is not repeated. */
export function seedLocalReceipts(current: ReceiptHistoryItem[], local: ReceiptHistoryItem[]): ReceiptHistoryItem[] {
  if (local.length === 0) return current;
  const byId = new Map(current.map((row) => [row.id, row]));
  const fresh: ReceiptHistoryItem[] = [];
  for (const row of local) {
    const existing = byId.get(row.id);
    if (existing) byId.set(row.id, { ...row, createdAt: existing.createdAt });
    else fresh.push(row);
  }
  return [...fresh, ...current.map((row) => byId.get(row.id)!)];
}
