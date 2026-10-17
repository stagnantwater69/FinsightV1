import type { ReceiptReviewEdits } from "../../../lib/receiptReviewDraft";
import type { ReceiptScanResult } from "./types";

type ReviewItem = Pick<ReceiptScanResult["items"][number], "id" | "name" | "amount" | "categoryId">;

/** The form exactly as a fresh reading seeds it, before the owner touches anything. */
export function reviewEditsFromScan(result: ReceiptScanResult): ReceiptReviewEdits {
  return {
    date: result.extractedDate ? String(result.extractedDate).slice(0, 10) : "",
    vendor: result.extractedVendor ?? "",
    description: result.extractedDescription ?? "",
    categoryId: result.items.length === 1 ? result.items[0]!.categoryId : null,
    amount: result.extractedAmount != null ? result.extractedAmount.toFixed(2) : "",
    itemCategories: Object.fromEntries(result.items.map((item) => [item.id, item.categoryId ?? null])),
    addedItems: [],
    plan: null,
    gapCategoryId: null,
    editingItem: null,
  };
}

/**
 * Whether the owner has changed anything that Confirm would send.
 *
 * Item categories are compared only for lines still on the scan; a line the
 * server added after the reading falls back to its own assigned category. An
 * empty added row and an item editor opened without a change do not count.
 */
export function hasUnsavedReviewEdits(edits: ReceiptReviewEdits, baseline: ReceiptReviewEdits, items: readonly ReviewItem[]): boolean {
  if (edits.date !== baseline.date || edits.description !== baseline.description || edits.vendor !== baseline.vendor || edits.amount !== baseline.amount) return true;
  if (edits.categoryId !== baseline.categoryId || edits.plan !== baseline.plan || edits.gapCategoryId !== baseline.gapCategoryId) return true;
  if (items.some((item) => (edits.itemCategories[item.id] ?? null) !== (baseline.itemCategories[item.id] ?? item.categoryId ?? null))) return true;
  if (edits.addedItems.some((row) => row.name.trim() !== "" || row.amount.trim() !== "" || row.categoryId !== null)) return true;
  const editing = edits.editingItem;
  if (editing) {
    const item = items.find((candidate) => candidate.id === editing.id);
    if (item && (editing.name !== item.name || editing.amount !== item.amount.toFixed(2))) return true;
  }
  return false;
}

/** A stored draft narrowed to the lines the current reading still has. */
export function restorableReviewEdits(stored: ReceiptReviewEdits, seeded: ReceiptReviewEdits, items: readonly ReviewItem[]): ReceiptReviewEdits {
  const ids = new Set(items.map((item) => item.id));
  return {
    ...stored,
    itemCategories: Object.fromEntries(items.map((item) => [
      item.id,
      Object.prototype.hasOwnProperty.call(stored.itemCategories, item.id) ? stored.itemCategories[item.id]! : seeded.itemCategories[item.id] ?? null,
    ])),
    editingItem: stored.editingItem && ids.has(stored.editingItem.id) ? stored.editingItem : null,
  };
}
