// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearReceiptReviewDrafts,
  readReceiptReviewDraft,
  removeReceiptReviewDraft,
  saveReceiptReviewDraft,
  type ReceiptReviewDraftEdits,
} from "./receiptReviewDraft";

let owner: string | null = "owner-a";
vi.mock("./serverStateCache", () => ({ captureServerStateAccount: () => owner ? { userId: owner, generation: 1 } : null }));

function edits(overrides: Partial<ReceiptReviewDraftEdits> = {}): ReceiptReviewDraftEdits {
  return {
    date: "2026-09-01",
    description: "Printer paper",
    vendor: "Paper shop Manila",
    amount: 520,
    splits: [{ categoryId: 2, amount: "" }],
    itemCategories: { 41: 2, 42: "" },
    addedItems: [{ key: "added-1", name: "Ink", amount: 20, categoryId: 2 }],
    gapPlan: "proportional",
    gapCategoryId: "",
    keptRepeatItemIds: [41],
    editingItem: null,
    ...overrides,
  };
}

beforeEach(() => {
  owner = "owner-a";
  sessionStorage.clear();
});

describe("receipt review draft storage", () => {
  it("restores only for the same account, business profile and scan", () => {
    saveReceiptReviewDraft(1, 10, edits());
    expect(readReceiptReviewDraft(1, 10)?.vendor).toBe("Paper shop Manila");
    expect(readReceiptReviewDraft(1, 11)).toBeNull();
    expect(readReceiptReviewDraft(2, 10)).toBeNull();
    owner = "owner-b";
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
    owner = null;
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
    owner = "owner-a";
    expect(readReceiptReviewDraft(1, 10)?.addedItems).toHaveLength(1);
  });

  it("stores nothing without a signed-in account", () => {
    owner = null;
    saveReceiptReviewDraft(1, 10, edits());
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it("rejects a stored draft whose embedded scope does not match its key", () => {
    saveReceiptReviewDraft(1, 10, edits());
    const key = "finsight.receiptReviewDraft.owner-a.1.10";
    const stored = JSON.parse(sessionStorage.getItem(key)!) as Record<string, unknown>;
    sessionStorage.setItem(key, JSON.stringify({ ...stored, ownerId: "owner-b" }));
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
    sessionStorage.setItem(key, JSON.stringify({ ...stored, businessProfileId: 2 }));
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
    sessionStorage.setItem(key, JSON.stringify({ ...stored, scanId: 11 }));
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
  });

  it.each([
    ["not json", "not json"],
    ["an empty object", "{}"],
    ["a wrong version", { version: 2 }],
    ["a non-numeric amount", { edits: { amount: "500" } }],
    ["no splits", { edits: { splits: [] } }],
    ["a bad item category", { edits: { itemCategories: { 41: -1 } } }],
    ["an unknown gap plan", { edits: { gapPlan: "guess" } }],
    ["a malformed item edit", { edits: { editingItem: { id: "41", name: "Ink", amount: 1 } } }],
  ])("ignores a draft with %s", (_case, change) => {
    const key = "finsight.receiptReviewDraft.owner-a.1.10";
    if (typeof change === "string") {
      sessionStorage.setItem(key, change);
    } else {
      const base = { version: 1, ownerId: "owner-a", businessProfileId: 1, scanId: 10, edits: edits() };
      const { edits: editChange, ...rest } = change as { edits?: Partial<ReceiptReviewDraftEdits> };
      sessionStorage.setItem(key, JSON.stringify({ ...base, ...rest, edits: { ...base.edits, ...editChange } }));
    }
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
  });

  it("removes one scan's draft and clears every draft on logout without touching other settings", () => {
    saveReceiptReviewDraft(1, 10, edits());
    saveReceiptReviewDraft(1, 11, edits());
    sessionStorage.setItem("unrelated-setting", "keep");
    removeReceiptReviewDraft(1, 10);
    expect(readReceiptReviewDraft(1, 10)).toBeNull();
    expect(readReceiptReviewDraft(1, 11)).not.toBeNull();
    clearReceiptReviewDrafts();
    expect(readReceiptReviewDraft(1, 11)).toBeNull();
    expect(sessionStorage.getItem("unrelated-setting")).toBe("keep");
  });
});
