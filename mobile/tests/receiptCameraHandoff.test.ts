import { describe, expect, it } from "vitest";
import {
  applyReceiptCameraHandoff,
  assertReceiptBatchLimit,
  maxReceiptsForCamera,
} from "../src/screens/records/scanReceipt/cameraHandoff";
import type { CapturedPage } from "../src/screens/records/scanReceipt/types";

const page = (key: string, receiptGroupId: string): CapturedPage => ({
  key,
  uri: `file:///${key}.jpg`,
  fileName: `${key}.jpg`,
  mimeType: "image/jpeg",
  quality: null,
  checkingQuality: false,
  width: 600,
  height: 1000,
  receiptGroupId,
});

const receipts = (count: number): CapturedPage[] => Array.from(
  { length: count },
  (_, index) => page(`page-${index + 1}`, `receipt-${index + 1}`),
);

describe("receipt camera handoff", () => {
  it("reports the remaining capacity for every camera intent", () => {
    const existing = receipts(7);
    expect(maxReceiptsForCamera(existing, { kind: "replace-all" })).toBe(8);
    expect(maxReceiptsForCamera(existing, { kind: "append-receipt", groupId: "receipt-8" })).toBe(1);
    expect(maxReceiptsForCamera(existing, {
      kind: "replace-group",
      groupKey: "receipt-3",
      groupId: "receipt-3",
    })).toBe(2);
  });

  it("rejects a 7 plus 2 append without changing or truncating either list", () => {
    const existing = receipts(7);
    const captured = [page("new-a", "new-a"), page("new-b", "new-b")];

    expect(() => applyReceiptCameraHandoff(
      existing,
      captured,
      { kind: "append-receipt", groupId: "reserved-new" },
    )).toThrow(/up to 8 receipts/i);
    expect(existing.map((entry) => entry.key)).toEqual([
      "page-1", "page-2", "page-3", "page-4", "page-5", "page-6", "page-7",
    ]);
    expect(captured.map((entry) => entry.key)).toEqual(["new-a", "new-b"]);
  });

  it("rejects over-capacity replace-all and replace-one handoffs", () => {
    expect(() => applyReceiptCameraHandoff(
      [],
      receipts(9),
      { kind: "replace-all" },
    )).toThrow(/up to 8 receipts/i);

    const existing = receipts(8);
    expect(() => applyReceiptCameraHandoff(
      existing,
      [page("replacement-a", "replacement-a"), page("replacement-b", "replacement-b")],
      { kind: "replace-group", groupKey: "receipt-4", groupId: "receipt-4" },
    )).toThrow(/up to 8 receipts/i);
  });

  it("keeps stable group IDs while replacing one receipt with two", () => {
    const existing = receipts(7);
    const result = applyReceiptCameraHandoff(
      existing,
      [page("replacement", "camera-first"), page("extra", "camera-extra")],
      { kind: "replace-group", groupKey: "receipt-4", groupId: "receipt-4" },
    );

    expect(result.pages.map((entry) => entry.receiptGroupId)).toEqual([
      "receipt-1",
      "receipt-2",
      "receipt-3",
      "receipt-4",
      "camera-extra",
      "receipt-5",
      "receipt-6",
      "receipt-7",
    ]);
    expect(result.replacedPages.map((entry) => entry.key)).toEqual(["page-4"]);
    expect(result.acceptedPages.map((entry) => entry.key)).toEqual(["replacement", "extra"]);
  });

  it("provides the final submission guard even if an earlier boundary is bypassed", () => {
    expect(() => assertReceiptBatchLimit(receipts(9))).toThrow(/up to 8 receipts/i);
    expect(assertReceiptBatchLimit(receipts(8))).toHaveLength(8);
  });
});
