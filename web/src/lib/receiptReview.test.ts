import { describe, expect, it } from "vitest";
import {
  everyLineIsReady,
  groupByCategory,
  isAddedLineComplete,
  sumCentavos,
  toReviewLines,
  type AddedLine,
  type ScannedLine,
} from "./receiptReview";

/**
 * This module decides how a receipt's money is split across categories and
 * whether the owner may save it. It sat inline in the confirm screen until
 * now, where nothing could reach it — these are the checks that were not
 * possible before.
 */

const scanned = (id: number, amount: number): ScannedLine => ({ id, amount });
const added = (over: Partial<AddedLine> = {}): AddedLine => ({
  key: "a1",
  name: "Missed item",
  amount: 50,
  categoryId: 2,
  ...over,
});

describe("toReviewLines", () => {
  it("converts pesos to centavos so later sums are exact", () => {
    const lines = toReviewLines([scanned(1, 12.34)], { 1: 5 }, []);
    expect(lines).toEqual([{ key: "scanned-1", centavos: 1234, categoryId: 5 }]);
  });

  it("marks a scanned item with no chosen category as uncategorised", () => {
    expect(toReviewLines([scanned(1, 10)], {}, [])[0]!.categoryId).toBe("");
  });

  /**
   * An added line counts toward the total the moment it has an amount, before
   * it has a name or a category — so typing a missed item closes the gap on
   * screen immediately instead of only once the row is finished.
   */
  it("includes an added line as soon as it has an amount", () => {
    const lines = toReviewLines([], {}, [added({ name: "", categoryId: "", amount: 25 })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.centavos).toBe(2500);
  });

  it("ignores an added line with no amount yet", () => {
    expect(toReviewLines([], {}, [added({ amount: "" })])).toHaveLength(0);
  });
});

describe("sumCentavos", () => {
  /**
   * THE REASON THIS MODULE WORKS IN CENTAVOS. Adding these as floats gives
   * 60.599999999999994, which would then be shown against a receipt total of
   * 60.60 and read as a one-centavo discrepancy that does not exist.
   */
  it("sums amounts that do not survive float addition", () => {
    const lines = toReviewLines([scanned(1, 10.1), scanned(2, 20.2), scanned(3, 30.3)], {}, []);
    expect(sumCentavos(lines)).toBe(6060);
    // The float route, for contrast — this is what is being avoided.
    expect(10.1 + 20.2 + 30.3).not.toBe(60.6);
  });

  it("is zero for an empty receipt", () => {
    expect(sumCentavos([])).toBe(0);
  });
});

describe("groupByCategory", () => {
  it("adds up every line sharing a category into one record", () => {
    const lines = toReviewLines([scanned(1, 100), scanned(2, 250)], { 1: 7, 2: 7 }, []);
    expect(groupByCategory(lines)).toEqual([{ categoryId: 7, subtotal: 350, count: 2 }]);
  });

  it("keeps different categories apart", () => {
    const lines = toReviewLines([scanned(1, 100), scanned(2, 250)], { 1: 7, 2: 9 }, []);
    const groups = groupByCategory(lines);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.categoryId === 7)!.subtotal).toBe(100);
    expect(groups.find((g) => g.categoryId === 9)!.subtotal).toBe(250);
  });

  /**
   * The subtotals an owner reads must add up to the total they read, or the
   * screen contradicts itself. Division happens once, at the end, from an
   * integer sum — this is what that buys.
   */
  it("produces subtotals that add up to the receipt total exactly", () => {
    const lines = toReviewLines(
      [scanned(1, 10.1), scanned(2, 20.2), scanned(3, 30.3), scanned(4, 0.05)],
      { 1: 1, 2: 2, 3: 1, 4: 2 },
      [],
    );
    const groups = groupByCategory(lines);
    const fromGroups = Math.round(groups.reduce((s, g) => s + g.subtotal, 0) * 100);
    expect(fromGroups).toBe(sumCentavos(lines));
  });

  it("groups uncategorised lines together rather than scattering them", () => {
    const lines = toReviewLines([scanned(1, 100), scanned(2, 50)], {}, []);
    expect(groupByCategory(lines)).toEqual([{ categoryId: "", subtotal: 150, count: 2 }]);
  });

  it("counts an owner-added line alongside scanned ones in the same category", () => {
    const lines = toReviewLines([scanned(1, 100)], { 1: 3 }, [added({ categoryId: 3, amount: 40 })]);
    expect(groupByCategory(lines)).toEqual([{ categoryId: 3, subtotal: 140, count: 2 }]);
  });

  it("returns nothing for a receipt with no lines", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("isAddedLineComplete", () => {
  it("accepts a fully filled row", () => {
    expect(isAddedLineComplete(added())).toBe(true);
  });

  it.each([
    ["no name", { name: "" }],
    ["whitespace-only name", { name: "   " }],
    ["no amount", { amount: "" as const }],
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["no category", { categoryId: "" as const }],
  ])("rejects a row with %s", (_label, over) => {
    expect(isAddedLineComplete(added(over))).toBe(false);
  });
});

describe("everyLineIsReady", () => {
  it("is true when every scanned item has a category and there are no added rows", () => {
    expect(everyLineIsReady([scanned(1, 10), scanned(2, 20)], { 1: 4, 2: 5 }, [])).toBe(true);
  });

  it("is false while any scanned item is uncategorised", () => {
    expect(everyLineIsReady([scanned(1, 10), scanned(2, 20)], { 1: 4 }, [])).toBe(false);
  });

  /**
   * A half-typed row must not enable Confirm — it would otherwise be saved
   * with a blank description or into no category at all.
   */
  it("is false while an added row is half-typed", () => {
    expect(everyLineIsReady([scanned(1, 10)], { 1: 4 }, [added({ categoryId: "" })])).toBe(false);
  });

  it("is true once the added row is finished", () => {
    expect(everyLineIsReady([scanned(1, 10)], { 1: 4 }, [added()])).toBe(true);
  });

  it("is true for a receipt with no lines at all", () => {
    expect(everyLineIsReady([], {}, [])).toBe(true);
  });
});
