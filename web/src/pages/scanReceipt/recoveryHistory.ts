import type { ReceiptScanHistoryPage, ReceiptScanSummary, ScanResult } from "./types";

/**
 * Every server page merged so far, plus scans abandoned locally before a
 * refresh confirmed them. `nextCursor` is the server's opaque keyset cursor
 * for the oldest loaded row; it is passed back as-is and never inspected.
 */
export interface RecoveryHistoryState {
  scans: ReceiptScanSummary[];
  nextCursor: string | null;
  /** Server pages merged in. Zero until the first fetch settles. */
  pagesLoaded: number;
}

export const EMPTY_RECOVERY_HISTORY: RecoveryHistoryState = { scans: [], nextCursor: null, pagesLoaded: 0 };

/** Server order: createdAt descending, then id descending. */
function isOlderThan(candidate: ReceiptScanSummary, boundary: ReceiptScanSummary): boolean {
  const candidateTime = Date.parse(candidate.createdAt);
  const boundaryTime = Date.parse(boundary.createdAt);
  if (candidateTime !== boundaryTime) return candidateTime < boundaryTime;
  return candidate.id < boundary.id;
}

/**
 * Applies a fresh first page over what is loaded. The page is authoritative
 * for the window it covers, so rows inside that window it no longer returns
 * are dropped. Rows older than its last row keep their deeper cursor.
 */
export function reconcileFirstPage(state: RecoveryHistoryState, page: ReceiptScanHistoryPage): RecoveryHistoryState {
  const pagesLoaded = Math.max(1, state.pagesLoaded);
  if (page.nextCursor === null || page.items.length === 0) {
    return { scans: page.items, nextCursor: page.nextCursor, pagesLoaded };
  }
  const boundary = page.items[page.items.length - 1]!;
  const seen = new Set(page.items.map((row) => row.id));
  const keptOlder = state.scans.filter((row) => !seen.has(row.id) && isOlderThan(row, boundary));
  return {
    scans: [...page.items, ...keptOlder],
    nextCursor: keptOlder.length > 0 ? state.nextCursor : page.nextCursor,
    pagesLoaded,
  };
}

/** Appends an older page fetched with `state.nextCursor`, skipping rows already shown. */
export function appendOlderPage(state: RecoveryHistoryState, page: ReceiptScanHistoryPage): RecoveryHistoryState {
  const seen = new Set(state.scans.map((row) => row.id));
  return {
    scans: [...state.scans, ...page.items.filter((row) => !seen.has(row.id))],
    nextCursor: page.nextCursor,
    pagesLoaded: state.pagesLoaded + 1,
  };
}

export function withoutScan(state: RecoveryHistoryState, scanId: number): RecoveryHistoryState {
  return { ...state, scans: state.scans.filter((row) => row.id !== scanId) };
}

/**
 * Shows just-abandoned scans before the server confirms them, so a pending or
 * failed refresh never hides them. A known row keeps its server `createdAt`.
 */
export function seedLocalScans(state: RecoveryHistoryState, local: ReceiptScanSummary[]): RecoveryHistoryState {
  if (local.length === 0) return state;
  const byId = new Map(state.scans.map((row) => [row.id, row]));
  const fresh: ReceiptScanSummary[] = [];
  for (const row of local) {
    const existing = byId.get(row.id);
    if (existing) byId.set(row.id, { ...row, createdAt: existing.createdAt });
    else fresh.push(row);
  }
  return { ...state, scans: [...fresh, ...state.scans.map((row) => byId.get(row.id)!)] };
}

/** Shapes a scan the review screen holds into the row history would show for it. */
export function summaryFromScan(scan: ScanResult, businessProfileId: number, createdAt: string): ReceiptScanSummary {
  const processingStatus = scan.processingStatus ?? "Complete";
  return {
    id: scan.id,
    businessProfileId,
    receiptBatchId: scan.receiptBatchId ?? null,
    receiptOrdinal: scan.receiptOrdinal ?? null,
    scanRevision: scan.scanRevision,
    processingStatus,
    confirmationStatus: scan.confirmationStatus ?? "Pending",
    processingError: scan.processingError ?? null,
    processingErrorCode: scan.processingErrorCode ?? null,
    extractedDate: scan.extractedDate,
    extractedVendor: scan.extractedVendor,
    extractedDescription: scan.extractedDescription,
    extractedAmount: scan.extractedAmount,
    createdAt,
    pageCount: scan.pageEvidence?.length ?? 0,
    allowedActions: {
      retryProcessing: processingStatus === "Failed",
      reviewResult: processingStatus === "Complete",
    },
  };
}

export function recoveryRowTitle(row: Pick<ReceiptScanSummary, "id" | "extractedVendor" | "extractedDescription">): string {
  return row.extractedVendor ?? row.extractedDescription ?? `Receipt scan ${row.id}`;
}

/**
 * Per-row accessible name from what the row already shows (title, receipt
 * number). Rows that still read the same get the scan id the fallback uses.
 */
export function recoveryRowNames(scans: ReceiptScanSummary[]): Map<number, string> {
  const base = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const row of scans) {
    const name = row.receiptOrdinal ? `${recoveryRowTitle(row)}, receipt ${row.receiptOrdinal}` : recoveryRowTitle(row);
    base.set(row.id, name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = new Map<number, string>();
  for (const [id, name] of base) {
    names.set(id, (counts.get(name) ?? 0) > 1 ? `${name}, scan ${id}` : name);
  }
  return names;
}
