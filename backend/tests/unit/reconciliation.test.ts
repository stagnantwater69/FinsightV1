import { describe, expect, it } from "vitest";
import { reconcileItems } from "../../src/services/ocr.service";

/**
 * Reconciliation decides two things that reach the owner: whether a scan is
 * re-read by a vision model (billed) and whether the confirm screen points at
 * a line as suspect (an interruption). Both are only worth it when the gap is
 * real, so the false-alarm cases below matter as much as the true ones.
 *
 * Every "explained gap" case here is taken from the accuracy corpus, not
 * invented — a bare `sum !== total` flagged all of them and was wrong each
 * time.
 */
describe("reconcileItems", () => {
  it("reconciles when the items add up exactly", () => {
    const r = reconcileItems("TOTAL 1400.00", [{ amount: 1220 }, { amount: 180 }], 1400);
    expect(r.reconciled).toBe(true);
    expect(r.reason).toBe("exact");
    expect(r.difference).toBe(0);
  });

  it("flags an unexplained gap", () => {
    const r = reconcileItems("TOTAL 1400.00", [{ amount: 1200 }, { amount: 180 }], 1400);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toBe("unexplained");
    expect(r.difference).toBe(20);
  });

  /**
   * The case this whole check was rebuilt around: a single digit misread. The
   * items are 20.00 short, nothing on the receipt accounts for it, and that
   * shortfall is the entire evidence that something went wrong.
   */
  it("flags the misread-digit shortfall that motivated this", () => {
    // Printed: 82.00 + 607.75 = 689.75, which reconciles exactly.
    const text = ["Del Monte Pineapple 82.00", "Rice 5kg 607.75", "TOTAL 689.75"].join("\n");
    // Read: 82 as 62, leaving the items 20.00 short of the printed total.
    const r = reconcileItems(text, [{ amount: 62 }, { amount: 607.75 }], 689.75);
    expect(r.reconciled).toBe(false);
    expect(r.difference).toBe(20);
  });

  describe("gaps the receipt explains — these must NOT be flagged", () => {
    it("accepts items matching a printed subtotal, with VAT on top", () => {
      // Corpus: syn-06. 12% Philippine VAT.
      const text = ["Goods 1000.00", "SUBTOTAL 1000.00", "VAT 12% 120.00", "TOTAL 1120.00"].join("\n");
      const r = reconcileItems(text, [{ amount: 1000 }], 1120);
      expect(r.reconciled).toBe(true);
      expect(r.reason).toBe("matches-subtotal");
    });

    it("accepts a discount that the receipt prints", () => {
      // Corpus: syn-18. No subtotal line, so the adjustment itself must match.
      const text = [
        "Paracetamol box 250.00",
        "Vitamins bottle 230.00",
        "Less Senior Discount 50.00",
        "TOTAL 430.00",
      ].join("\n");
      const r = reconcileItems(text, [{ amount: 250 }, { amount: 230 }], 430);
      expect(r.reconciled).toBe(true);
      expect(r.reason).toBe("explained-by-adjustment");
    });

    it("accepts a tax line on a receipt that prints a subtotal", () => {
      // Corpus: real-02, a genuine receipt.
      const text = ["SUBTOTAL $8.17", "TAX $0.53", "BALANCE $8.70"].join("\n");
      const r = reconcileItems(text, [{ amount: 3.19 }, { amount: 1.99 }, { amount: 2.99 }], 8.7);
      expect(r.reconciled).toBe(true);
    });

    it("accepts a gap explained by several adjustments together", () => {
      const text = ["Goods 500.00", "VAT 60.00", "Service charge 25.00", "TOTAL 585.00"].join("\n");
      const r = reconcileItems(text, [{ amount: 500 }], 585);
      expect(r.reconciled).toBe(true);
      expect(r.reason).toBe("explained-by-adjustment");
    });
  });

  /**
   * A tender line carries the receipt's own total, so treating it as an
   * adjustment would let any gap equal to the amount paid excuse itself. This
   * is why reconciliation uses its own narrow list rather than NOT_AN_ITEM.
   */
  it("does not let a cash-tendered line excuse a gap", () => {
    const text = ["Rice 1200.00", "CASH 200.00", "TOTAL 1400.00"].join("\n");
    const r = reconcileItems(text, [{ amount: 1200 }], 1400);
    expect(r.reconciled).toBe(false);
  });

  describe("nothing to compare", () => {
    it("is not comparable without a total", () => {
      const r = reconcileItems("Rice 100.00", [{ amount: 100 }], null);
      expect(r.reconciled).toBe(true);
      expect(r.reason).toBe("not-comparable");
    });

    it("is not comparable without items", () => {
      // A total-only receipt is normal in this market, not a failure.
      const r = reconcileItems("TOTAL 500.00", [], 500);
      expect(r.reconciled).toBe(true);
      expect(r.reason).toBe("not-comparable");
    });
  });

  it("compares in centavos so float addition cannot invent a gap", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point.
    const r = reconcileItems("TOTAL 0.30", [{ amount: 0.1 }, { amount: 0.2 }], 0.3);
    expect(r.reconciled).toBe(true);
    expect(r.reason).toBe("exact");
  });
});
