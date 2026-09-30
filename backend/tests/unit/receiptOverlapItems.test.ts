import { describe, expect, it } from "vitest";
import { findSeamRepeats, itemNameSimilarity, resolveSeamRepeats, type SeamItem } from "../../src/lib/receiptOverlapItems";

const item = (name: string, amount: number, pageNumber: number | null, quantity: number | null = null): SeamItem => ({
  name, amount, pageNumber, quantity,
});
const sumsTo = (total: number | null) => (list: SeamItem[]) =>
  total === null ? null : Math.round(list.reduce((sum, entry) => sum + entry.amount, 0) * 100) === Math.round(total * 100);
const names = (list: SeamItem[]) => list.map((entry) => entry.name);

describe("seam repeats between overlapping receipt photos", () => {
  it("counts overlapping items once when the printed total confirms it (scenario 1)", () => {
    const items = [
      item("Milk", 80, 1), item("Bread", 50, 1), item("Eggs", 120, 1), item("Rice", 200, 1),
      item("Eggs", 120, 2), item("Rice", 200, 2), item("Cooking Oil", 150, 2),
    ];
    const outcome = resolveSeamRepeats(items, sumsTo(600));
    expect(outcome.resolution).toBe("removed-reconciled");
    expect(names(outcome.items)).toEqual(["Milk", "Bread", "Eggs", "Rice", "Cooking Oil"]);
    expect(outcome.removed.map((repeat) => [repeat.repeatIndex, repeat.originalIndex])).toEqual([[4, 2], [5, 3]]);
    expect(outcome.keptInputIndexes).toEqual([0, 1, 2, 3, 6]);
    expect(outcome.flagged).toEqual([]);
  });

  it("never removes a legitimate repeated purchase on one page (scenario 2)", () => {
    const items = [item("Coke 1.5L", 75, 1), item("Coke 1.5L", 75, 1), item("Chips", 40, 1), item("Coke 1.5L", 75, 2)];
    expect(findSeamRepeats(items.slice(0, 3))).toEqual([]);
    // The seam match here is real paper: the list as read adds up.
    const outcome = resolveSeamRepeats(items, sumsTo(265));
    expect(outcome.resolution).toBe("kept-reconciled");
    expect(outcome.items).toHaveLength(4);
  });

  it("keeps a same-name line at the seam when the total says it was bought twice", () => {
    const items = [item("Bread", 50, 1), item("Eggs", 120, 1), item("Eggs", 120, 2), item("Oil", 150, 2)];
    const outcome = resolveSeamRepeats(items, sumsTo(440));
    expect(outcome.resolution).toBe("kept-reconciled");
    expect(outcome.removed).toEqual([]);
  });

  it("distinguishes similar names with different prices or quantities (scenario 3)", () => {
    expect(findSeamRepeats([item("Lucky Me Beef", 9, 1), item("Lucky Me Beef", 12.25, 2)])).toEqual([]);
    expect(findSeamRepeats([item("Surf Pow", 41, 1, 1), item("Surf Pow", 41, 2, 2)])).toEqual([]);
    expect(findSeamRepeats([item("Surf Pow Rose", 41, 1), item("Nescafe Stick", 41, 2)])).toEqual([]);
  });

  it("tolerates OCR noise in the repeated names", () => {
    expect(itemNameSimilarity("CRMSILK STD STRT PNK", "CRMSlLK STD STRT PNK")).toBeGreaterThanOrEqual(0.8);
    expect(itemNameSimilarity("DOVE SH STRT&SLKY PNK 13.5ml", "DOVE SH STRT&SLKY")).toBeGreaterThanOrEqual(0.8);
    const items = [item("MILO 24g/12s/42", 106.05, 1), item("6+1 SURF POW ROSE", 41, 1), item("6+l SURF P0W ROSE", 41, 2), item("NISSIN", 63.25, 2)];
    const outcome = resolveSeamRepeats(items, sumsTo(210.3));
    expect(outcome.resolution).toBe("removed-reconciled");
    expect(names(outcome.items)).toEqual(["MILO 24g/12s/42", "6+1 SURF POW ROSE", "NISSIN"]);
  });

  it("handles three or more overlapping photos seam by seam (scenario 4)", () => {
    const items = [
      item("A", 10, 1), item("B", 20, 1), item("C", 30, 1),
      item("B", 20, 2), item("C", 30, 2), item("D", 40, 2), item("E", 50, 2),
      item("E", 50, 3), item("F", 60, 3),
    ];
    const outcome = resolveSeamRepeats(items, sumsTo(210));
    expect(outcome.resolution).toBe("removed-reconciled");
    expect(names(outcome.items)).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("allows a line one photo's reading skipped inside the overlap", () => {
    const items = [item("A", 10, 1), item("B", 20, 1), item("C", 30, 1), item("D", 40, 1), item("B", 20, 2), item("D", 40, 2), item("E", 50, 2)];
    const outcome = resolveSeamRepeats(items, sumsTo(150));
    expect(names(outcome.items)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("flags instead of removing when the total cannot confirm (scenario 5)", () => {
    const items = [item("Bread", 50, 1), item("Eggs", 120, 1), item("Eggs", 120, 2), item("Oil", 150, 2)];
    const outcome = resolveSeamRepeats(items, sumsTo(999));
    expect(outcome.resolution).toBe("flagged");
    expect(outcome.items).toHaveLength(4);
    expect(outcome.flagged.map((repeat) => [repeat.repeatIndex, repeat.originalIndex, repeat.pageNumber, repeat.originalPageNumber]))
      .toEqual([[2, 1, 2, 1]]);
  });

  it("without a total removes only strong multi-line runs and flags a single match", () => {
    const run = [item("Bread", 50, 1), item("Eggs", 120, 1), item("Rice", 200, 1), item("Eggs", 120, 2), item("Rice", 200, 2), item("Oil", 150, 2)];
    const runOutcome = resolveSeamRepeats(run, sumsTo(null));
    expect(runOutcome.resolution).toBe("removed-context");
    expect(names(runOutcome.items)).toEqual(["Bread", "Eggs", "Rice", "Oil"]);

    const single = [item("Bread", 50, 1), item("Eggs", 120, 1), item("Eggs", 120, 2), item("Oil", 150, 2)];
    const singleOutcome = resolveSeamRepeats(single, sumsTo(null));
    expect(singleOutcome.resolution).toBe("flagged");
    expect(singleOutcome.items).toHaveLength(4);
  });

  it("ignores items with no page and non-adjacent pages", () => {
    expect(findSeamRepeats([item("Eggs", 120, null), item("Eggs", 120, null)])).toEqual([]);
    expect(findSeamRepeats([item("Eggs", 120, 1), item("Eggs", 120, 3)])).toEqual([]);
  });

  it("keeps a list that adds up untouched, and a list with no seams (scenario 6)", () => {
    const clean = [item("Milk", 80, 1), item("Bread", 50, 2)];
    expect(resolveSeamRepeats(clean, sumsTo(130)).resolution).toBe("none");
  });
});

describe("overlap warnings shown to the owner", async () => {
  const { seamRepeatWarnings } = await import("../../src/services/receiptScan/extraction");

  it("names what was counted once and what may still repeat, per page", () => {
    expect(seamRepeatWarnings(undefined)).toEqual([]);
    expect(seamRepeatWarnings({
      resolution: "removed-reconciled",
      removed: [
        { name: "Eggs", quantity: 1, amount: 120, pageNumber: 2, originalPageNumber: 1 },
        { name: "Rice", quantity: null, amount: 200, pageNumber: 2, originalPageNumber: 1 },
      ],
      flagged: [{ name: "Oil", quantity: 1, amount: 150, pageNumber: 3, originalPageNumber: 2, itemIndex: 4, originalName: "Oil" }],
    })).toEqual([
      { code: "OVERLAP_ITEMS_COUNTED_ONCE", pageNumber: 2, detail: "Eggs 120.00; Rice 200.00" },
      { code: "POSSIBLE_REPEATED_ITEMS", pageNumber: 3, detail: "Oil 150.00" },
    ]);
  });
});

describe("seam repeats carrying printed product codes", () => {
  const coded = (name: string, amount: number, pageNumber: number, code: string): SeamItem => ({
    name, amount, pageNumber, quantity: 1, code,
  });

  it("matches the same code even when one photograph lost the description", () => {
    const items = [
      coded("CASINO FEMME 60ML", 22.25, 1, "004065833"),
      coded("003523216", 88, 1, "003523216"),
      coded("CLOSEUP RED HOT NEW 10G 1", 88, 2, "003523216"),
    ];
    expect(findSeamRepeats(items)).toMatchObject([{ repeatIndex: 2, originalIndex: 1, similarity: 1 }]);
  });

  it("never matches two different codes, however alike the names and prices", () => {
    // Two lotions of one brand at one price, printed one after the other.
    const items = [coded("SILKA WHTNG LOT ENRG CTRS", 58, 1, "004461333"), coded("SILKA WHTNG LOT ENRG CTRS", 58, 2, "004461336")];
    expect(findSeamRepeats(items)).toEqual([]);
  });
});
