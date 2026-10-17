import { useEffect } from "react";
import { removeReceiptReviewDraft, saveReceiptReviewDraft, type ReceiptReviewDraftEdits } from "../../lib/receiptReviewDraft";

type DraftSource = Omit<ReceiptReviewDraftEdits, "keptRepeatItemIds"> & { keptRepeatItemIds: ReadonlySet<number> };

/**
 * Mirrors unsaved review edits into the scan's draft, and drops the draft once
 * nothing is unsaved. `scanId` is undefined unless a completed scan is on screen.
 */
export function useReceiptReviewDraftPersistence(
  businessProfileId: number | undefined,
  scanId: number | undefined,
  unsaved: boolean,
  source: DraftSource,
) {
  const {
    date, description, vendor, amount, splits, itemCategories, addedItems, gapPlan, gapCategoryId,
    keptRepeatItemIds, editingItem,
  } = source;
  useEffect(() => {
    if (scanId === undefined || businessProfileId === undefined) return;
    if (!unsaved) {
      removeReceiptReviewDraft(businessProfileId, scanId);
      return;
    }
    saveReceiptReviewDraft(businessProfileId, scanId, {
      date, description, vendor, amount, splits, itemCategories, addedItems, gapPlan, gapCategoryId,
      keptRepeatItemIds: [...keptRepeatItemIds],
      editingItem,
    });
  }, [addedItems, amount, businessProfileId, date, description, editingItem, gapCategoryId, gapPlan, itemCategories,
    keptRepeatItemIds, scanId, splits, unsaved, vendor]);
}
