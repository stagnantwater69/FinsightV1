import { useCallback, useState } from "react";
import type { ReconciliationPlan } from "../../../lib/receiptConfirm";
import type { ReceiptReviewAddedItem, ReceiptReviewEdits } from "../../../lib/receiptReviewDraft";

const EMPTY: ReceiptReviewEdits = {
  date: "",
  description: "",
  vendor: "",
  amount: "",
  categoryId: null,
  itemCategories: {},
  addedItems: [],
  plan: null,
  gapCategoryId: null,
  editingItem: null,
};

/**
 * Every answer the owner gives on the review form before Confirm.
 *
 * `edits` is the same shape a stored draft holds, and `apply` writes one back
 * in a single pass, so seeding from a reading, restoring a draft and clearing
 * the form all go through one path.
 */
export function useReceiptReviewForm(initialDate: () => string) {
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(initialDate);
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  /**
   * The owner's category for each extracted line, keyed by item id.
   *
   * Seeded from what the server assigned automatically, then owned by the
   * owner — every row is editable and nothing is written until Confirm.
   */
  const [itemCategories, setItemCategories] = useState<Record<number, number | null>>({});
  /** How they want to account for any difference between items and total. */
  const [plan, setPlan] = useState<ReconciliationPlan>(null);
  /** The category for the "file it on its own" plan. */
  const [gapCategoryId, setGapCategoryId] = useState<number | null>(null);
  /**
   * Lines the owner is adding because OCR missed them.
   *
   * Held here until Confirm, like every other answer on this screen — nothing
   * is written until they accept the whole receipt.
   */
  const [addedItems, setAddedItems] = useState<ReceiptReviewAddedItem[]>([]);
  const [editingItem, setEditingItem] = useState<{ id: number; name: string; amount: string } | null>(null);
  const [editingItemErrors, setEditingItemErrors] = useState<{ name?: string; amount?: string }>({});

  const apply = useCallback((next: ReceiptReviewEdits) => {
    setDate(next.date);
    setDescription(next.description);
    setVendor(next.vendor);
    setAmount(next.amount);
    setCategoryId(next.categoryId);
    setItemCategories(next.itemCategories);
    setAddedItems(next.addedItems);
    setPlan(next.plan);
    setGapCategoryId(next.gapCategoryId);
    setEditingItem(next.editingItem);
    setEditingItemErrors({});
  }, []);
  const clear = useCallback(() => apply(EMPTY), [apply]);

  const edits: ReceiptReviewEdits = { date, description, vendor, amount, categoryId, itemCategories, addedItems, plan, gapCategoryId, editingItem };
  return {
    edits,
    apply,
    clear,
    categoryId, setCategoryId,
    date, setDate,
    description, setDescription,
    vendor, setVendor,
    amount, setAmount,
    itemCategories, setItemCategories,
    plan, setPlan,
    gapCategoryId, setGapCategoryId,
    addedItems, setAddedItems,
    editingItem, setEditingItem,
    editingItemErrors, setEditingItemErrors,
  };
}
