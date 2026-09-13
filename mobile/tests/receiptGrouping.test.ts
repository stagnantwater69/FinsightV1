import { describe, expect, it } from "vitest";
import {
  canMoveWithinReceipt,
  groupReceiptMembers,
  makeReceiptGroupsExplicit,
} from "../src/lib/receiptGrouping";
import type { CapturedPage } from "../src/screens/records/scanReceipt/types";

const page = (key: string, receiptGroupId?: string): CapturedPage => ({
  key,
  uri: `file:///${key}.jpg`,
  fileName: `${key}.jpg`,
  mimeType: "image/jpeg",
  quality: null,
  checkingQuality: false,
  width: 100,
  height: 200,
  receiptGroupId,
});

describe("multiple-receipt capture grouping", () => {
  it("keeps ordinary long-receipt pages in one ordered group", () => {
    expect(groupReceiptMembers([page("top"), page("middle"), page("bottom")]).map((group) => group.map((p) => p.key)))
      .toEqual([["top", "middle", "bottom"]]);
  });

  it("separates detected receipts while preserving page order within each group", () => {
    expect(groupReceiptMembers([page("a1", "a"), page("b1", "b"), page("a2", "a")]).map((group) => group.map((p) => p.key)))
      .toEqual([["a1", "a2"], ["b1"]]);
  });

  it("turns an ordinary receipt into one explicit boundary before another is captured", () => {
    const explicit = makeReceiptGroupsExplicit([page("top"), page("bottom")]);
    expect(explicit[0]!.receiptGroupId).toBeTruthy();
    expect(explicit[1]!.receiptGroupId).toBe(explicit[0]!.receiptGroupId);
  });

  it("never reorders a page across separate receipt boundaries", () => {
    const pages = [page("a1", "a"), page("a2", "a"), page("b1", "b")];
    expect(canMoveWithinReceipt(pages, 1, -1)).toBe(true);
    expect(canMoveWithinReceipt(pages, 1, 1)).toBe(false);
    expect(canMoveWithinReceipt(pages, 2, -1)).toBe(false);
  });
});
