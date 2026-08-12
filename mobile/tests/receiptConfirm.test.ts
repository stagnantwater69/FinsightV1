import { describe, expect, it } from "vitest";
import {
  buildItemisedConfirmPayload,
  buildReceiptConfirmPayload,
  gapCentavos,
} from "../src/lib/receiptConfirm";

/**
 * The contract this screen broke once already.
 *
 * Mobile posted `categoryId` long after the server stopped accepting it. Zod
 * strips unknown keys rather than rejecting them, so the field vanished
 * without an error, `splits` arrived empty, and EVERY receipt confirmation on
 * mobile was rejected with "Assign the receipt to at least one category".
 *
 * These are deliberately pinned against the SERVER's schema
 * (backend/src/controllers/receiptScan.controller.ts `confirmSchema`), not
 * against whatever the client happens to do — a test that only restates the
 * implementation would have passed happily throughout the outage.
 */

const base = {
  date: "2026-07-31",
  description: "Groceries",
  vendor: "ABC Sari-Sari Store",
  amount: 188,
  categoryId: 7,
};

describe("the shape the server actually accepts", () => {
  it("sends splits, because there is no single-category shape", () => {
    const out = buildReceiptConfirmPayload(base);
    expect(out.splits).toEqual([{ categoryId: 7, amount: 188 }]);
  });

  /** The specific regression. A stray categoryId is silently dropped server-side. */
  it("does not send a top-level categoryId", () => {
    expect(buildReceiptConfirmPayload(base)).not.toHaveProperty("categoryId");
  });

  /**
   * The server compares splits against the total in centavos and refuses a
   * mismatch, so "close" is not good enough.
   */
  it("makes the splits sum to the confirmed total exactly", () => {
    for (const amount of [188, 1400, 0.01, 1220.55, 99999.99]) {
      const out = buildReceiptConfirmPayload({ ...base, amount });
      const summed = out.splits.reduce((s, x) => s + Math.round(x.amount * 100), 0);
      expect(summed, `total ${amount}`).toBe(Math.round(amount * 100));
    }
  });

  it("carries the fields the server requires", () => {
    const out = buildReceiptConfirmPayload(base);
    expect(out.date).toBe("2026-07-31");
    expect(out.description).toBe("Groceries");
    expect(out.amount).toBe(188);
  });
});

describe("vendor and description handling", () => {
  it("omits the vendor rather than sending an empty one", () => {
    const out = buildReceiptConfirmPayload({ ...base, vendor: "   " });
    expect(out).not.toHaveProperty("vendor");
  });

  it("trims a real vendor", () => {
    expect(buildReceiptConfirmPayload({ ...base, vendor: "  ABC Store  " }).vendor).toBe("ABC Store");
  });

  /** description is min(1) server-side, so an empty one would be a 400. */
  it("falls back to a description rather than sending an empty string", () => {
    expect(buildReceiptConfirmPayload({ ...base, description: "   " }).description).toBe("Receipt purchase");
  });

  it("trims a real description", () => {
    expect(buildReceiptConfirmPayload({ ...base, description: "  Groceries  " }).description).toBe("Groceries");
  });
});

// ============================================================
// The itemised path
// ============================================================

const itemised = {
  date: "2026-07-31",
  description: "Grocery run",
  vendor: "Savemore",
  totalAmount: 1400,
  itemsTotal: 1400,
  itemAssignments: [
    { itemId: 1, categoryId: 7 },
    { itemId: 2, categoryId: 8 },
  ],
  plan: null as any,
};

describe("itemised receipts", () => {
  it("sends assignments and lets the server do the grouping", () => {
    const out = buildItemisedConfirmPayload(itemised);
    expect(out.itemAssignments).toHaveLength(2);
    // Splits are the server's job here; sending both would let the amounts
    // and the item -> record links disagree.
    expect(out).not.toHaveProperty("splits");
  });

  it("needs no reconciliation when the items already add up", () => {
    expect(buildItemisedConfirmPayload(itemised).reconciliation).toEqual({ mode: "none" });
  });

  it("refuses to build with no assignments at all", () => {
    expect(() => buildItemisedConfirmPayload({ ...itemised, itemAssignments: [] })).toThrow(/category/i);
  });
});

describe("accounting for a gap between items and total", () => {
  // A VAT-exclusive register: 1400 of items, 1568 payable.
  const withGap = { ...itemised, totalAmount: 1568, itemsTotal: 1400 };

  it("spreads tax across the categories in proportion", () => {
    const out = buildItemisedConfirmPayload({ ...withGap, plan: "proportional" });
    expect(out.reconciliation).toEqual({ mode: "proportional" });
    // The total the owner confirmed is the anchor and never moves.
    expect(out.amount).toBe(1568);
  });

  it("can file the difference as its own record", () => {
    const out = buildItemisedConfirmPayload({ ...withGap, plan: "category", gapCategoryId: 9 });
    expect(out.reconciliation).toEqual({ mode: "category", categoryId: 9 });
    expect(out.amount).toBe(1568);
  });

  it("refuses that plan without a category to put it in", () => {
    expect(() => buildItemisedConfirmPayload({ ...withGap, plan: "category" })).toThrow(/category/i);
  });

  /**
   * The one plan that moves the total, and it only ever moves it DOWN to
   * figures read off the receipt — never to an invented one.
   */
  it("shrinks the total to the items when OCR misread the total", () => {
    const out = buildItemisedConfirmPayload({ ...withGap, plan: "shrink" });
    expect(out.amount).toBe(1400);
    expect(out.reconciliation).toEqual({ mode: "none" });
  });

  it("ignores a shrink plan when there is nothing to shrink", () => {
    const out = buildItemisedConfirmPayload({ ...itemised, plan: "shrink" });
    expect(out.amount).toBe(1400);
    expect(out.reconciliation).toEqual({ mode: "none" });
  });

  /** A discount: the items come to MORE than was actually paid. */
  it("handles a negative gap", () => {
    const out = buildItemisedConfirmPayload({
      ...itemised,
      totalAmount: 1300,
      itemsTotal: 1400,
      plan: "proportional",
    });
    expect(out.reconciliation).toEqual({ mode: "proportional" });
    expect(out.amount).toBe(1300);
  });
});

describe("gap arithmetic", () => {
  /** Centavos, because 1200.10 + 800.20 is not 2000.30 in binary floating point. */
  it("does not report a gap that is only a rounding artefact", () => {
    expect(gapCentavos(2000.3, 1200.1 + 800.2)).toBe(0);
  });

  it("reports a real difference in centavos", () => {
    expect(gapCentavos(1568, 1400)).toBe(16800);
    expect(gapCentavos(1300, 1400)).toBe(-10000);
  });
});

describe("lines the owner adds because OCR missed them", () => {
  const added = [{ name: "Bagged ice", amount: 40, categoryId: 7 }];

  it("sends them alongside the extracted assignments", () => {
    const out = buildItemisedConfirmPayload({ ...itemised, additionalItems: added });
    expect(out.additionalItems).toEqual(added);
    expect(out.itemAssignments).toHaveLength(2);
  });

  /** Absence and an empty list mean the same thing server-side; [] says nothing. */
  it("omits the field entirely when there are none", () => {
    expect(buildItemisedConfirmPayload({ ...itemised })).not.toHaveProperty("additionalItems");
    expect(buildItemisedConfirmPayload({ ...itemised, additionalItems: [] })).not.toHaveProperty(
      "additionalItems",
    );
  });

  /**
   * A receipt whose every extracted line was removed as "not a purchase" can
   * still be saved from hand-typed lines alone.
   */
  it("can carry a receipt with no extracted lines left", () => {
    const out = buildItemisedConfirmPayload({
      ...itemised,
      itemAssignments: [],
      additionalItems: added,
      itemsTotal: 40,
      totalAmount: 40,
    });
    expect(out.additionalItems).toEqual(added);
    expect(out.reconciliation).toEqual({ mode: "none" });
  });

  it("still refuses a receipt with nothing on it at all", () => {
    expect(() =>
      buildItemisedConfirmPayload({ ...itemised, itemAssignments: [], additionalItems: [] }),
    ).toThrow(/category/i);
  });
});
