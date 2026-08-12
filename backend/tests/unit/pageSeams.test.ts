import { describe, expect, it } from "vitest";
import {
  findPageSeams,
  joinPagesWithoutSeams,
  parseLineItems,
  reconcileItems,
  seamOverlapLength,
} from "../../src/services/ocr.service";

/**
 * The overlap the capture guide asks for, and what the server is allowed to
 * do about it.
 *
 * Like duplicatePage.test.ts these are hand-constructed rather than drawn
 * from a corpus — nobody has a collection of long receipts photographed in
 * deliberately overlapping sections, because the camera that asks for that
 * is what this change introduces. So these pin down BEHAVIOUR, and make no
 * claim about a measured rate.
 *
 * The last block is the important one: it checks the objective test the
 * pipeline actually leans on, rather than the seam finder in isolation.
 */

const PAGE_ONE = [
  "ABC SARI-SARI STORE",
  "Date: 2026-08-01",
  "Rice 25kg          1220.00",
  "Cooking oil         180.00",
  "Sugar 1kg            75.00",
].join("\n");

/** Photographed so its first two lines repeat page one's last two. */
const PAGE_TWO = [
  "Cooking oil         180.00",
  "Sugar 1kg            75.00",
  "Soy sauce            45.00",
  "TOTAL              1520.00",
].join("\n");

describe("seamOverlapLength", () => {
  it("finds the run where one section's tail begins the next", () => {
    expect(seamOverlapLength(PAGE_ONE, PAGE_TWO)).toBe(2);
  });

  it("reports nothing when the sections do not meet", () => {
    const unrelated = ["Soy sauce   45.00", "TOTAL   1520.00"].join("\n");
    expect(seamOverlapLength(PAGE_ONE, unrelated)).toBe(0);
  });

  /**
   * THE SAFETY PROPERTY. A restock receipt legitimately buys the same thing
   * twice, and an unanchored search for shared lines would call that an
   * overlap and delete a real purchase. Only a tail-to-head repeat counts,
   * because that is the only shape the overlap guide can produce.
   */
  it("ignores a repeated line that is not at the seam", () => {
    const a = ["Rice 25kg   1220.00", "Cooking oil   180.00", "Sugar 1kg   75.00"].join("\n");
    const b = ["Soy sauce   45.00", "Cooking oil   180.00", "TOTAL   1520.00"].join("\n");
    expect(seamOverlapLength(a, b)).toBe(0);
  });

  it("prefers the longest run, not the first one that matches", () => {
    const a = ["Header", "Item A   10.00", "Item B   20.00", "Item C   30.00"].join("\n");
    const b = ["Item A   10.00", "Item B   20.00", "Item C   30.00", "TOTAL   60.00"].join("\n");
    expect(seamOverlapLength(a, b)).toBe(3);
  });

  it("is not fooled by whitespace or case differing between two photographs", () => {
    const a = ["Rice 25kg     1220.00"].join("\n");
    const b = ["RICE 25KG   1220.00", "TOTAL   1220.00"].join("\n");
    expect(seamOverlapLength(a, b)).toBe(1);
  });
});

describe("findPageSeams", () => {
  it("reports the later page of each overlapping pair, 1-indexed", () => {
    expect(findPageSeams([PAGE_ONE, PAGE_TWO])).toEqual([{ pageNumber: 2, lineCount: 2 }]);
  });

  it("says nothing about a single-section scan", () => {
    expect(findPageSeams([PAGE_ONE])).toEqual([]);
  });

  it("looks only at adjacent sections", () => {
    // Page 3 repeats page 1's tail, but they were never photographed as a
    // continuous strip — nothing between them says so, and pretending
    // otherwise would drop lines from a genuinely different page.
    const pageThree = ["Cooking oil   180.00", "Sugar 1kg   75.00"].join("\n");
    const middle = ["Vinegar   30.00", "Salt   12.00"].join("\n");
    expect(findPageSeams([PAGE_ONE, middle, pageThree])).toEqual([]);
  });
});

describe("joinPagesWithoutSeams", () => {
  it("drops the repeated lines from the later section only", () => {
    const joined = joinPagesWithoutSeams([PAGE_ONE, PAGE_TWO]);
    expect(joined).toContain("Rice 25kg");
    expect(joined).toContain("Soy sauce");
    expect(joined).toContain("TOTAL");
    // Each overlapping line survives exactly once.
    expect(joined.match(/Cooking oil/g)).toHaveLength(1);
    expect(joined.match(/Sugar 1kg/g)).toHaveLength(1);
  });

  it("leaves non-overlapping sections exactly as they were", () => {
    const unrelated = ["Soy sauce   45.00", "TOTAL   1520.00"].join("\n");
    expect(joinPagesWithoutSeams([PAGE_ONE, unrelated])).toBe(`${PAGE_ONE}\n${unrelated}`);
  });

  it("counts significant lines, so a blank line inside the seam costs nothing", () => {
    const a = ["Item A   10.00", "Item B   20.00"].join("\n");
    // The blank and the stray single character are OCR noise, not content;
    // cutting by raw index rather than by significant line would take
    // "Item C" with them.
    const b = ["Item A   10.00", "", "-", "Item B   20.00", "Item C   30.00"].join("\n");
    expect(seamOverlapLength(a, b)).toBe(2);
    expect(joinPagesWithoutSeams([a, b])).toContain("Item C");
    expect(joinPagesWithoutSeams([a, b]).match(/Item B/g)).toHaveLength(1);
  });
});

/**
 * THE OBJECTIVE TEST ITSELF.
 *
 * receiptScan.service does not trust the seam finder on its own — it builds
 * both readings and keeps the de-overlapped one only when the plain reading
 * fails to account for the receipt's printed total and the de-overlapped one
 * does. That composition is the actual safety rule, so it is what gets
 * asserted, not just the helper underneath it.
 */
describe("the arithmetic that decides whether to drop a seam", () => {
  it("de-overlapping settles a total the doubled reading cannot", () => {
    const plainText = `${PAGE_ONE}\n${PAGE_TWO}`;
    const total = 1520;

    const plainItems = parseLineItems(plainText);
    const plain = reconcileItems(plainText, plainItems, total);
    // Cooking oil and sugar counted twice: the items overshoot the printed
    // total, and nothing on the receipt explains the difference.
    expect(plain.reconciled).toBe(false);

    const seamFreeText = joinPagesWithoutSeams([PAGE_ONE, PAGE_TWO]);
    const seamFreeItems = parseLineItems(seamFreeText);
    const seamFree = reconcileItems(seamFreeText, seamFreeItems, total);
    expect(seamFree.reconciled).toBe(true);
    expect(seamFree.itemsTotal).toBe(total);
  });

  /**
   * The other direction, which is the one that protects money. Where removing
   * the seam does NOT make the arithmetic work, there is no evidence it
   * helped — so the plain reading has to stand and the gap has to reach the
   * owner. A line the owner can see and delete beats one this deleted
   * quietly.
   */
  it("leaves a reading alone when removing the seam does not settle anything", () => {
    // A middle section is missing, so the items fall short of the total no
    // matter which reading is used.
    const first = ["Rice 25kg   1220.00", "Cooking oil   180.00"].join("\n");
    const second = ["Cooking oil   180.00", "TOTAL   9999.00"].join("\n");
    const total = 9999;

    const plainText = `${first}\n${second}`;
    expect(reconcileItems(plainText, parseLineItems(plainText), total).reconciled).toBe(false);

    const seamFreeText = joinPagesWithoutSeams([first, second]);
    expect(seamOverlapLength(first, second)).toBe(1);
    expect(reconcileItems(seamFreeText, parseLineItems(seamFreeText), total).reconciled).toBe(false);
  });
});
