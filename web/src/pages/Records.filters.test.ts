import { describe, expect, it } from "vitest";
import { filtersAreActive } from "./records/filters";

/**
 * Regression: `hasFilters` used to compare `JSON.stringify(filters)` against
 * `JSON.stringify(emptyFilters)`. The two Filters values are built in two
 * places that declare their keys in a different order, and JSON.stringify
 * preserves insertion order, so the comparison was never equal — an owner with
 * no records got "No records match these filters" instead of the onboarding
 * empty state, and "Clear filters" was always offered.
 */
describe("filtersAreActive", () => {
  const cleared = {
    type: "all",
    categoryId: "",
    dateFrom: "",
    dateTo: "",
    keyword: "",
    source: "",
    importBatchId: "",
  } as const;

  it("is false for cleared filters", () => {
    expect(filtersAreActive({ ...cleared })).toBe(false);
  });

  it("is false regardless of the order the keys were declared in", () => {
    // The shape filtersFromParams builds: keyword before dateFrom/dateTo.
    const fromParams = {
      type: "all",
      categoryId: "",
      keyword: "",
      dateFrom: "",
      dateTo: "",
      source: "",
      importBatchId: "",
    } as const;
    expect(JSON.stringify(fromParams)).not.toBe(JSON.stringify(cleared));
    expect(filtersAreActive({ ...fromParams })).toBe(false);
  });

  it.each([
    ["type", { type: "expense" }],
    ["categoryId", { categoryId: "cat-1" }],
    ["dateFrom", { dateFrom: "2026-01-01" }],
    ["dateTo", { dateTo: "2026-01-31" }],
    ["keyword", { keyword: "rent" }],
    ["source", { source: "CSV_UPLOAD" }],
    ["importBatchId", { importBatchId: "batch-1" }],
  ])("is true when %s is set", (_name, patch) => {
    expect(filtersAreActive({ ...cleared, ...patch } as never)).toBe(true);
  });
});
