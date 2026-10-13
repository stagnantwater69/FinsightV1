import { describe, expect, it } from "vitest";
import {
  categoriesCreatedByScan,
  categoryReviewNote,
  rowsToApplySuggestionTo,
  suggestedNewCategory,
} from "../src/lib/categorySuggestion";

/**
 * Offering a category the business does not have yet.
 *
 * The classifier can propose one when nothing on the list fits. The proposal
 * is only ever an offer — a category appearing in someone's books that they
 * never asked for is what the classifier's grounding rules exist to prevent.
 * These pin when the offer should and should not appear.
 */

const CATEGORIES = ["Ingredients", "Utilities", "Equipment"];
const UNCATEGORISED_ID = 99;

const item = (suggestedCategoryName: string | null) => ({ suggestedCategoryName });

describe("when the offer appears", () => {
  it("offers a genuinely new category for an unplaced row", () => {
    expect(suggestedNewCategory(item("Packaging"), null, UNCATEGORISED_ID, CATEGORIES)).toBe("Packaging");
  });

  /** Sitting in Uncategorized is the absence of a decision, not a decision. */
  it("still offers when the row is only in Uncategorized", () => {
    expect(suggestedNewCategory(item("Packaging"), UNCATEGORISED_ID, UNCATEGORISED_ID, CATEGORIES)).toBe(
      "Packaging",
    );
  });

  it("offers when the business has no Uncategorized category at all", () => {
    expect(suggestedNewCategory(item("Packaging"), null, null, CATEGORIES)).toBe("Packaging");
  });
});

describe("when it is withheld", () => {
  /**
   * The suggestion answers "nothing here fits this", which stops being true
   * the moment the owner says what does.
   */
  it("goes away once the owner places the row themselves", () => {
    expect(suggestedNewCategory(item("Packaging"), 7, UNCATEGORISED_ID, CATEGORIES)).toBeNull();
  });

  /** Accepting it for one row must not leave the offer up on its siblings. */
  it("goes away once the category exists", () => {
    expect(
      suggestedNewCategory(item("Packaging"), null, UNCATEGORISED_ID, [...CATEGORIES, "Packaging"]),
    ).toBeNull();
  });

  it("matches an existing category case-insensitively", () => {
    expect(
      suggestedNewCategory(item("packaging"), null, UNCATEGORISED_ID, [...CATEGORIES, "PACKAGING"]),
    ).toBeNull();
  });

  it("has nothing to offer when the model proposed nothing", () => {
    expect(suggestedNewCategory(item(null), null, UNCATEGORISED_ID, CATEGORIES)).toBeNull();
    expect(suggestedNewCategory(item("   "), null, UNCATEGORISED_ID, CATEGORIES)).toBeNull();
    expect(suggestedNewCategory({}, null, UNCATEGORISED_ID, CATEGORIES)).toBeNull();
  });
});

describe("which rows an accepted category is applied to", () => {
  const items = [
    { id: 1, suggestedCategoryName: "Packaging" },
    { id: 2, suggestedCategoryName: "Packaging" },
    { id: 3, suggestedCategoryName: "Cleaning" },
    { id: 4, suggestedCategoryName: null },
  ];

  /**
   * Every unplaced row it was proposed for, not just the one tapped — four
   * packaging lines is one decision, not four.
   */
  it("applies to every unplaced row with the same proposal", () => {
    const assignments = { 1: null, 2: null, 3: null, 4: null };
    expect(rowsToApplySuggestionTo(items, "Packaging", assignments, UNCATEGORISED_ID)).toEqual([1, 2]);
  });

  it("leaves rows the owner already placed alone", () => {
    const assignments = { 1: 7, 2: null, 3: null, 4: null };
    expect(rowsToApplySuggestionTo(items, "Packaging", assignments, UNCATEGORISED_ID)).toEqual([2]);
  });

  it("treats a row in Uncategorized as still unplaced", () => {
    const assignments = { 1: UNCATEGORISED_ID, 2: null, 3: null, 4: null };
    expect(rowsToApplySuggestionTo(items, "Packaging", assignments, UNCATEGORISED_ID)).toEqual([1, 2]);
  });

  it("never touches rows proposed a different category", () => {
    const assignments = { 1: null, 2: null, 3: null, 4: null };
    const applied = rowsToApplySuggestionTo(items, "Packaging", assignments, UNCATEGORISED_ID);
    expect(applied).not.toContain(3);
    expect(applied).not.toContain(4);
  });

  it("matches the proposal case-insensitively", () => {
    const assignments = { 1: null, 2: null, 3: null, 4: null };
    expect(rowsToApplySuggestionTo(items, "PACKAGING", assignments, UNCATEGORISED_ID)).toEqual([1, 2]);
  });
});

describe("a category FinSight is unsure of", () => {
  const unsure = {
    categoryId: 7,
    categorisation: { confidence: "low" as const, reason: "Looks like a personal purchase.", newCategory: false },
  };

  it("shows why while the row still has the category FinSight chose", () => {
    expect(categoryReviewNote(unsure, 7)).toBe("Looks like a personal purchase.");
  });

  it("goes quiet once the owner chooses a category themselves", () => {
    expect(categoryReviewNote(unsure, 9)).toBeNull();
  });

  it("says nothing about a confident choice, or a scan from before this was recorded", () => {
    expect(categoryReviewNote({ categoryId: 7, categorisation: { ...unsure.categorisation, confidence: "medium" } }, 7)).toBeNull();
    expect(categoryReviewNote({ categoryId: 7 }, 7)).toBeNull();
  });
});

describe("categories a scan created", () => {
  const categories = [{ id: 1, name: "Inventory / Stock" }, { id: 2, name: "Personal Care" }, { id: 3, name: "Utilities" }];
  const row = (categoryId: number, newCategory: boolean) => ({
    categoryId,
    categorisation: { confidence: "medium" as const, reason: null, newCategory },
  });

  it("names each created category once, in the order the rows use them", () => {
    expect(categoriesCreatedByScan([row(2, true), row(1, true), row(2, true), row(3, false)], categories)).toEqual([
      "Personal Care",
      "Inventory / Stock",
    ]);
  });

  it("names nothing when every category already existed", () => {
    expect(categoriesCreatedByScan([row(3, false)], categories)).toEqual([]);
  });
});
