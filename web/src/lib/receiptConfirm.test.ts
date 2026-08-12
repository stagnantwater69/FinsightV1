import { describe, expect, it } from "vitest";
import { buildReceiptConfirmPayload, gapCentavos, type ReceiptConfirmInput } from "./receiptConfirm";

/**
 * The first tests this project has had.
 *
 * They exist here rather than anywhere else because this is the shape that
 * has already broken a client once: mobile posted a field the server had
 * stopped accepting, zod stripped it silently, and every receipt confirmation
 * failed with an error about something else entirely. Web builds the same
 * request, so it is worth pinning the same way.
 */

const base: ReceiptConfirmInput = {
  date: "2026-07-31",
  description: "Grocery run",
  vendor: "Savemore",
  amount: 1400,
  isItemised: false,
  itemAssignments: [],
  additionalItems: [],
  itemsTotal: 0,
  gapPlan: null,
  gapCategoryId: null,
  splits: [{ categoryId: 7, amount: 1400 }],
};

const itemised: ReceiptConfirmInput = {
  ...base,
  isItemised: true,
  itemsTotal: 1400,
  itemAssignments: [
    { itemId: 1, categoryId: 7 },
    { itemId: 2, categoryId: 8 },
  ],
  splits: [],
};

describe("a receipt with one line or none", () => {
  it("sends splits, because there is no single-category shape", () => {
    const out = buildReceiptConfirmPayload(base);
    expect(out.splits).toEqual([{ categoryId: 7, amount: 1400 }]);
    expect(out).not.toHaveProperty("itemAssignments");
  });

  it("does not send a top-level categoryId", () => {
    // The exact field the server silently discards.
    expect(buildReceiptConfirmPayload(base)).not.toHaveProperty("categoryId");
  });

  it("carries a hand-made multi-category split", () => {
    const out = buildReceiptConfirmPayload({
      ...base,
      splits: [
        { categoryId: 7, amount: 1000 },
        { categoryId: 8, amount: 400 },
      ],
    });
    expect(out.splits).toHaveLength(2);
    const summed = out.splits!.reduce((s, x) => s + Math.round(x.amount * 100), 0);
    expect(summed).toBe(Math.round(out.amount * 100));
  });
});

describe("a receipt reviewed line by line", () => {
  it("sends assignments and lets the server group them", () => {
    const out = buildReceiptConfirmPayload(itemised);
    expect(out.itemAssignments).toHaveLength(2);
    // Sending both would let the amounts and the item -> record links drift.
    expect(out.splits).toBeUndefined();
  });

  it("needs no reconciliation when the items already add up", () => {
    expect(buildReceiptConfirmPayload(itemised).reconciliation).toEqual({ mode: "none" });
  });

  it("omits owner-added lines rather than sending an empty list", () => {
    expect(buildReceiptConfirmPayload(itemised)).not.toHaveProperty("additionalItems");
  });

  it("sends owner-added lines when there are some", () => {
    const additionalItems = [{ name: "Bagged ice", amount: 40, categoryId: 7 }];
    expect(buildReceiptConfirmPayload({ ...itemised, additionalItems }).additionalItems).toEqual(
      additionalItems,
    );
  });
});

describe("accounting for a gap between items and total", () => {
  // A VAT-exclusive register: 1400 of items, 1568 payable.
  const withGap = { ...itemised, amount: 1568 };

  it("spreads tax across the categories, leaving the total alone", () => {
    const out = buildReceiptConfirmPayload({ ...withGap, gapPlan: "proportional" });
    expect(out.reconciliation).toEqual({ mode: "proportional" });
    expect(out.amount).toBe(1568);
  });

  it("can file the difference as its own record", () => {
    const out = buildReceiptConfirmPayload({ ...withGap, gapPlan: "category", gapCategoryId: 9 });
    expect(out.reconciliation).toEqual({ mode: "category", categoryId: 9 });
  });

  /** Falls back rather than emitting a category mode with no category. */
  it("does not send a category plan without a category", () => {
    const out = buildReceiptConfirmPayload({ ...withGap, gapPlan: "category", gapCategoryId: null });
    expect(out.reconciliation).toEqual({ mode: "proportional" });
  });

  /**
   * The one plan that moves the total, and only ever DOWN to figures read off
   * the receipt — never to an invented one.
   */
  it("shrinks the total to the items when OCR misread the total", () => {
    const out = buildReceiptConfirmPayload({ ...withGap, gapPlan: "shrink" });
    expect(out.amount).toBe(1400);
    expect(out.reconciliation).toEqual({ mode: "none" });
  });

  it("ignores a shrink plan when there is nothing to shrink", () => {
    const out = buildReceiptConfirmPayload({ ...itemised, gapPlan: "shrink" });
    expect(out.amount).toBe(1400);
  });

  it("handles a discount, where the items come to more than was paid", () => {
    const out = buildReceiptConfirmPayload({ ...itemised, amount: 1300, gapPlan: "proportional" });
    expect(out.reconciliation).toEqual({ mode: "proportional" });
    expect(out.amount).toBe(1300);
  });
});

describe("gap arithmetic", () => {
  it("does not report a gap that is only a rounding artefact", () => {
    expect(gapCentavos(2000.3, 1200.1 + 800.2)).toBe(0);
  });

  it("reports a real difference in centavos", () => {
    expect(gapCentavos(1568, 1400)).toBe(16800);
    expect(gapCentavos(1300, 1400)).toBe(-10000);
  });
});

describe("vendor handling", () => {
  it("omits a blank vendor rather than storing an empty one", () => {
    expect(buildReceiptConfirmPayload({ ...base, vendor: "   " })).not.toHaveProperty("vendor");
  });

  it("trims a real vendor", () => {
    expect(buildReceiptConfirmPayload({ ...base, vendor: "  Savemore  " }).vendor).toBe("Savemore");
  });
});
