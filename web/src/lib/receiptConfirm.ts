/**
 * The body sent to POST /records/receipts/:id/confirm.
 *
 * Pulled out of ScanReceipt.tsx so it can be tested — and, more importantly,
 * so the backend's contract tests can check the REAL builder against the REAL
 * schema rather than a hand-written mirror of it. Mobile's equivalent already
 * works that way; this closes the same gap for web.
 *
 * The endpoint takes two shapes and the choice between them is the thing
 * worth pinning:
 *
 *   - ITEMISED, when FinSight read more than one line. The owner's per-item
 *     choices are sent and the SERVER groups them, so the amounts written and
 *     the item -> record links written come from one grouping and cannot
 *     disagree. Splits are never also sent.
 *   - SPLITS, for a receipt with one line or none. A single category is just
 *     a split of one.
 */

export type ReconciliationMode =
  | { mode: "none" }
  | { mode: "proportional" }
  | { mode: "category"; categoryId: number };

/** How the owner accounts for a gap between the items and the total. */
export type GapPlan = "proportional" | "category" | "shrink" | null;

export interface ReceiptConfirmPayload {
  date: string;
  description: string;
  vendor?: string;
  amount: number;
  itemAssignments?: { itemId: number; categoryId: number }[];
  additionalItems?: { name: string; amount: number; categoryId: number }[];
  reconciliation?: ReconciliationMode;
  splits?: { categoryId: number; amount: number }[];
}

export interface ReceiptConfirmInput {
  date: string;
  description: string;
  vendor: string;
  /** The receipt total the owner confirmed, in pesos. */
  amount: number;
  /** True when FinSight read more than one line and the owner reviewed them. */
  isItemised: boolean;
  /** Itemised path: the owner's per-item choices. */
  itemAssignments: { itemId: number; categoryId: number }[];
  /** Itemised path: lines the owner typed in because OCR missed them. */
  additionalItems: { name: string; amount: number; categoryId: number }[];
  /** Itemised path: what the items themselves come to, in pesos. */
  itemsTotal: number;
  /** Itemised path: how to account for any gap. */
  gapPlan: GapPlan;
  gapCategoryId: number | null;
  /** Manual path: one entry per category, summing to `amount`. */
  splits: { categoryId: number; amount: number }[];
}

/** Whole centavos — 1200.10 + 800.20 is not 2000.30 in binary floating point. */
export function gapCentavos(amount: number, itemsTotal: number): number {
  return Math.round(amount * 100) - Math.round(itemsTotal * 100);
}

export function buildReceiptConfirmPayload(input: ReceiptConfirmInput): ReceiptConfirmPayload {
  const vendor = input.vendor.trim();
  const base = {
    date: input.date,
    description: input.description,
    // Omitted rather than sent empty: the field is optional server-side, and
    // "" would store a vendor the receipt never had.
    ...(vendor ? { vendor } : {}),
  };

  if (!input.isItemised) {
    return { ...base, amount: input.amount, splits: input.splits };
  }

  const gap = gapCentavos(input.amount, input.itemsTotal);
  const shrinking = input.gapPlan === "shrink" && gap !== 0;

  return {
    ...base,
    /*
     * The total the owner confirmed against the photo is the anchor and is
     * never altered to make the arithmetic work — it is what left their
     * pocket. "shrink" is the single exception, for the different case where
     * OCR misread the TOTAL rather than missing an item, and it only ever
     * moves the total DOWN to figures read off the receipt.
     */
    amount: shrinking ? input.itemsTotal : input.amount,
    itemAssignments: input.itemAssignments,
    ...(input.additionalItems.length > 0 ? { additionalItems: input.additionalItems } : {}),
    reconciliation:
      gap === 0 || shrinking
        ? { mode: "none" }
        : input.gapPlan === "category" && input.gapCategoryId !== null
          ? { mode: "category", categoryId: input.gapCategoryId }
          : { mode: "proportional" },
  };
}
