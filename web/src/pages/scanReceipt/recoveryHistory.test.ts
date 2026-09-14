import { describe, expect, it } from "vitest";
import {
  EMPTY_RECOVERY_HISTORY,
  appendOlderPage,
  reconcileFirstPage,
  recoveryRowNames,
  seedLocalScans,
  summaryFromScan,
  withoutScan,
} from "./recoveryHistory";
import type { ReceiptHistoryItem } from "./types";

function row(id: number, second = id, overrides: Partial<ReceiptHistoryItem> = {}): ReceiptHistoryItem {
  return {
    id,
    businessProfileId: 1,
    receiptBatchId: null,
    receiptOrdinal: null,
    scanRevision: 0,
    processingStatus: "Complete",
    confirmationStatus: "Pending",
    processingError: null,
    processingErrorCode: null,
    extractedDate: null,
    extractedVendor: `Shop ${id}`,
    extractedDescription: null,
    extractedAmount: null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString(),
    pageCount: 1,
    allowedActions: { retryProcessing: false, reviewResult: true },
    ...overrides,
  };
}
const ids = (state: { scans: ReceiptHistoryItem[] }) => state.scans.map((scan) => scan.id);

describe("reconcileFirstPage", () => {
  it("takes a page with no cursor as the complete list", () => {
    const state = { scans: [row(5), row(4), row(3)], nextCursor: "deep", pagesLoaded: 2 };
    const next = reconcileFirstPage(state, { items: [row(5), row(3)], nextCursor: null });
    expect(ids(next)).toEqual([5, 3]);
    expect(next.nextCursor).toBeNull();
  });

  it("keeps rows older than the page and the deeper cursor, and drops rows the page no longer returns", () => {
    const state = { scans: [row(6), row(5), row(4), row(3), row(2)], nextCursor: "after-2", pagesLoaded: 2 };
    const next = reconcileFirstPage(state, { items: [row(7), row(6), row(4)], nextCursor: "after-4" });
    expect(ids(next)).toEqual([7, 6, 4, 3, 2]);
    expect(next.nextCursor).toBe("after-2");
  });

  it("adopts the page cursor when nothing older was loaded", () => {
    const next = reconcileFirstPage(EMPTY_RECOVERY_HISTORY, { items: [row(2), row(1)], nextCursor: "after-1" });
    expect(ids(next)).toEqual([2, 1]);
    expect(next.nextCursor).toBe("after-1");
    expect(next.pagesLoaded).toBe(1);
  });

  it("breaks a createdAt tie by id, the server's own order", () => {
    const state = { scans: [row(3, 1), row(2, 1), row(1, 1)], nextCursor: "after-1", pagesLoaded: 1 };
    const next = reconcileFirstPage(state, { items: [row(3, 1), row(2, 1)], nextCursor: "after-2" });
    expect(ids(next)).toEqual([3, 2, 1]);
    expect(next.nextCursor).toBe("after-1");
  });
});

describe("appendOlderPage", () => {
  it("appends in order, skips rows already shown, and forwards the new cursor", () => {
    const state = { scans: [row(4), row(3)], nextCursor: "after-3", pagesLoaded: 1 };
    const next = appendOlderPage(state, { items: [row(3), row(2), row(1)], nextCursor: null });
    expect(ids(next)).toEqual([4, 3, 2, 1]);
    expect(next.nextCursor).toBeNull();
    expect(next.pagesLoaded).toBe(2);
  });
});

describe("seedLocalScans and withoutScan", () => {
  it("puts unseen scans first and refreshes a known scan without moving it", () => {
    const state = { scans: [row(4), row(3)], nextCursor: null, pagesLoaded: 1 };
    const next = seedLocalScans(state, [
      row(9, 9, { createdAt: "2026-09-14T00:00:00.000Z" }),
      row(3, 3, { createdAt: "2026-09-14T00:00:00.000Z", processingStatus: "Failed" }),
    ]);
    expect(ids(next)).toEqual([9, 4, 3]);
    expect(next.scans[2]).toMatchObject({ processingStatus: "Failed", createdAt: row(3).createdAt });
  });

  it("removes a deleted scan and leaves the cursor alone", () => {
    const next = withoutScan({ scans: [row(2), row(1)], nextCursor: "after-1", pagesLoaded: 1 }, 2);
    expect(ids(next)).toEqual([1]);
    expect(next.nextCursor).toBe("after-1");
  });
});

describe("summaryFromScan", () => {
  it("derives the allowed actions from the processing status", () => {
    const failed = summaryFromScan({
      id: 8, scanRevision: 2, processingStatus: "Failed", processingError: "Blurry", items: [],
      extractedDate: null, extractedVendor: null, extractedDescription: null, extractedAmount: null,
    }, 1, "2026-09-14T00:00:00.000Z");
    expect(failed).toMatchObject({
      id: 8, businessProfileId: 1, processingStatus: "Failed", processingError: "Blurry",
      allowedActions: { retryProcessing: true, reviewResult: false },
    });
    const complete = summaryFromScan({
      id: 9, scanRevision: 0, items: [], receiptBatchId: 3, receiptOrdinal: 2,
      extractedDate: null, extractedVendor: "Cafe", extractedDescription: null, extractedAmount: 40,
    }, 1, "2026-09-14T00:00:00.000Z");
    expect(complete).toMatchObject({
      receiptBatchId: 3, receiptOrdinal: 2, processingStatus: "Complete",
      allowedActions: { retryProcessing: false, reviewResult: true },
    });
  });
});

describe("recoveryRowNames", () => {
  it("uses only the row's own title and receipt number, adding the scan id on a clash", () => {
    const names = recoveryRowNames([
      row(5, 5, { extractedVendor: "Cafe", receiptOrdinal: 2 }),
      row(4, 4, { extractedVendor: "Cafe", receiptOrdinal: 1 }),
      row(3, 3, { extractedVendor: "Cafe" }),
      row(2, 2, { extractedVendor: "Cafe" }),
      row(1, 1, { extractedVendor: null }),
    ]);
    expect([...names.values()]).toEqual([
      "Cafe, receipt 2",
      "Cafe, receipt 1",
      "Cafe, scan 3",
      "Cafe, scan 2",
      "Receipt scan 1",
    ]);
  });
});
