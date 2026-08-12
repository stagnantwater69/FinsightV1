/**
 * The body sent to POST /records/receipts/:id/confirm.
 *
 * Pulled out of the screen as a pure function for one reason: it is the shape
 * that silently broke. The screen used to post `categoryId`, which the server
 * had stopped accepting when receipts gained multi-category splitting. Zod
 * strips unknown keys instead of rejecting them, so the field disappeared
 * without a word, `splits` arrived empty, and every receipt confirmation on
 * mobile failed with "Assign the receipt to at least one category".
 *
 * Nothing could catch that: the response was typed `any` here, the two apps
 * share no contract, and a backend test cannot observe what a client sends.
 * A function can at least be tested.
 */

export interface ReceiptConfirmPayload {
  date: string;
  description: string;
  vendor?: string;
  amount: number;
  /**
   * One entry per category the receipt covers, summing to `amount` exactly.
   *
   * The server compares in centavos, so the arithmetic has to be right rather
   * than close. A receipt filed under a single category is a split of one —
   * there is no separate single-category shape, and assuming there was is
   * what caused the outage this function documents.
   */
  splits: { categoryId: number; amount: number }[];
}

export interface ReceiptConfirmInput {
  date: string;
  description: string;
  vendor: string;
  /** The confirmed total, already validated as a positive number by the caller. */
  amount: number;
  categoryId: number;
}

/** The literal fallback the backend uses when it read no vendor to describe. */
const FALLBACK_DESCRIPTION = "Receipt purchase";

export function buildReceiptConfirmPayload(input: ReceiptConfirmInput): ReceiptConfirmPayload {
  const description = input.description.trim() || FALLBACK_DESCRIPTION;
  const vendor = input.vendor.trim();

  return {
    date: input.date,
    description,
    // Omitted rather than sent empty: the field is optional server-side, and
    // "" would store a vendor the receipt never had.
    ...(vendor ? { vendor } : {}),
    amount: input.amount,
    splits: [{ categoryId: input.categoryId, amount: input.amount }],
  };
}

// ============================================================
// The itemised path — a receipt reviewed line by line
// ============================================================
// Used when the server read more than one item off the receipt. The owner
// puts each line in a category and the SERVER groups them, so the amounts it
// writes and the item -> record links it writes come from one grouping and
// cannot disagree. That is why this sends assignments rather than splits it
// computed itself.

/**
 * How the owner accounts for a difference between the items and the total.
 *
 * A gap is normal, not a mistake: a VAT-exclusive register adds tax on top of
 * the printed lines, a discount takes money off, and OCR sometimes just
 * misses a line. `null` means they have not answered yet.
 */
export type ReconciliationPlan = "proportional" | "category" | "shrink" | null;

export type Reconciliation =
  | { mode: "none" }
  | { mode: "proportional" }
  | { mode: "category"; categoryId: number };

export interface ItemisedConfirmPayload {
  date: string;
  description: string;
  vendor?: string;
  amount: number;
  itemAssignments: { itemId: number; categoryId: number }[];
  /**
   * Lines the owner typed in because OCR missed them.
   *
   * Stored server-side as real items flagged `addedByOwner`, so they are
   * grouped and linked like any other line while staying distinguishable from
   * something FinSight claims to have read.
   */
  additionalItems?: { name: string; amount: number; categoryId: number }[];
  reconciliation: Reconciliation;
}

export interface ItemisedConfirmInput {
  date: string;
  description: string;
  vendor: string;
  /** The receipt total as the owner confirmed it against the photo. */
  totalAmount: number;
  /** What the item lines actually add up to. */
  itemsTotal: number;
  itemAssignments: { itemId: number; categoryId: number }[];
  /** Lines the owner typed in. Their amounts must already be in `itemsTotal`. */
  additionalItems?: { name: string; amount: number; categoryId: number }[];
  plan: ReconciliationPlan;
  gapCategoryId?: number | null;
}

/**
 * The difference between the total and the items, in centavos.
 *
 * Whole centavos because 1200.10 + 800.20 is not 2000.30 in binary floating
 * point, and an owner whose arithmetic is right must never be told it is
 * wrong by a rounding artefact. The server compares the same way.
 */
export function gapCentavos(totalAmount: number, itemsTotal: number): number {
  return Math.round(totalAmount * 100) - Math.round(itemsTotal * 100);
}

/**
 * THE RULE THIS ENCODES: the total the owner confirmed against the photo is
 * the anchor and is never altered to make the arithmetic work. It is what
 * left their pocket. The gap is allocated to categories instead.
 *
 * The single exception is "shrink", for the genuinely different case where
 * OCR misread the TOTAL rather than missing an item. There the items are the
 * trustworthy figure and the total follows them — and it only ever moves DOWN
 * to figures read off the receipt, never to an invented one.
 */
export function buildItemisedConfirmPayload(input: ItemisedConfirmInput): ItemisedConfirmPayload {
  const description = input.description.trim() || FALLBACK_DESCRIPTION;
  const vendor = input.vendor.trim();
  const gap = gapCentavos(input.totalAmount, input.itemsTotal);
  const shrinking = input.plan === "shrink" && gap !== 0;

  const additionalItems = input.additionalItems ?? [];

  if (input.itemAssignments.length === 0 && additionalItems.length === 0) {
    throw new Error("Every item on the receipt needs a category");
  }
  if (input.plan === "category" && input.gapCategoryId == null) {
    throw new Error("Choose a category for the remaining amount");
  }

  return {
    date: input.date,
    description,
    ...(vendor ? { vendor } : {}),
    amount: shrinking ? input.itemsTotal : input.totalAmount,
    itemAssignments: input.itemAssignments,
    // Omitted entirely rather than sent empty — the server treats the field's
    // absence and an empty list the same, and sending [] says nothing.
    ...(additionalItems.length > 0 ? { additionalItems } : {}),
    reconciliation:
      gap === 0 || shrinking
        ? // Nothing left to account for: either the items already reconcile,
          // or the total has just been moved to meet them.
          { mode: "none" }
        : input.plan === "category"
          ? { mode: "category", categoryId: input.gapCategoryId! }
          : { mode: "proportional" },
  };
}
