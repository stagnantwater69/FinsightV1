import { describe, expect, it } from "vitest";
import {
  computeReductionOpportunities,
  DEFAULT_REDUCTION_OPPORTUNITY_CONFIG,
  materialityFloor,
  SUGGESTED_CHECK_CATALOGUE,
  type ReductionOpportunityComputationInput,
  type ReductionOpportunityConfig,
} from "../../src/services/reductionOpportunity.service";

/**
 * Expense Reduction Opportunities — deterministic detection/ranking core.
 *
 * These pin the rules in docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md §6/§7,
 * and the specific cases §14.1 requires. `computeReductionOpportunities` is a
 * pure function (no Prisma), so every case here is exercised directly against
 * the rule engine rather than through mocks.
 */

const PERIOD_END_KEY = "2026-08-30";

// A small, cheap-to-read config: lower expectedMonthlyExpenses so the
// materiality floor is driven by `minimumMaterialAmount` (500) unless a test
// says otherwise, and keep the defaults from the plan everywhere else.
const config: ReductionOpportunityConfig = { ...DEFAULT_REDUCTION_OPPORTUNITY_CONFIG };

function baseInput(overrides: Partial<ReductionOpportunityComputationInput> = {}): ReductionOpportunityComputationInput {
  return {
    totalCurrent: 10_000,
    expectedMonthlyExpenses: 20_000, // floor = max(500, 20000*0.02) = 500
    categoryTrends: [],
    currentRecords: [],
    unusualExpenses: [],
    duplicateFindings: [],
    ...overrides,
  };
}

describe("materiality floor", () => {
  it("uses the configured minimum when the expected-expense fraction is smaller", () => {
    expect(materialityFloor(1000, config)).toBe(500); // max(500, 1000*0.02=20)
  });

  it("uses the expected-expense fraction when it exceeds the configured minimum", () => {
    expect(materialityFloor(100_000, config)).toBe(2000); // max(500, 100000*0.02=2000)
  });
});

describe("CATEGORY_PRESSURE", () => {
  it("crosses both amount and share thresholds for a high-share category", () => {
    const input = baseInput({
      totalCurrent: 10_000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Utilities", current: 3000, previous: 3000, percentChange: 0, recordCount: 4 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 1000 },
        { id: 2, categoryId: 1, amount: 1000 },
        { id: 3, categoryId: 1, amount: 500 },
        { id: 4, categoryId: 1, amount: 500 },
      ],
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("CATEGORY_PRESSURE");
    expect(opportunity?.evidence.expenseSharePercent).toBeCloseTo(30, 5);
    expect(opportunity?.evidence.currentAmount).toBe(3000);
  });

  it("fails materiality for a tiny category with a large percentage increase", () => {
    const input = baseInput({
      totalCurrent: 100_000, // tiny category's share will also be tiny
      expectedMonthlyExpenses: 100, // floor = 500 (configured minimum)
      categoryTrends: [
        { categoryId: 1, categoryName: "Office Snacks", current: 100, previous: 20, percentChange: 400, recordCount: 1 },
      ],
      currentRecords: [{ id: 1, categoryId: 1, amount: 100 }],
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunities).toHaveLength(0);
  });

  it("handles a material absolute increase with a moderate percentage", () => {
    // previous 3000 -> current 4000: +1000 absolute (>= floor 500), +33.3% (>= 20%)
    const input = baseInput({
      totalCurrent: 20_000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Supplies", current: 4000, previous: 3000, percentChange: (1000 / 3000) * 100, recordCount: 3 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 2000 },
        { id: 2, categoryId: 1, amount: 1000 },
        { id: 3, categoryId: 1, amount: 1000 },
      ],
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("CATEGORY_PRESSURE");
    expect(opportunity?.evidence.changeAmount).toBe(1000);
    expect(opportunity?.evidence.changePercent).toBeCloseTo((1000 / 3000) * 100, 5);
    // Only the increase signal fired (share is 20%, at the boundary — also
    // fires here), so confidence reflects however many signals actually did.
  });

  it("returns changePercent: null and limited confidence for a brand-new category", () => {
    const input = baseInput({
      totalCurrent: 10_000,
      categoryTrends: [
        // New category: no previous baseline, but it already commands 25% share.
        { categoryId: 1, categoryName: "Delivery Fees", current: 2500, previous: 0, percentChange: null, recordCount: 5 },
      ],
      currentRecords: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, categoryId: 1, amount: 500 })),
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("CATEGORY_PRESSURE");
    expect(opportunity?.evidence.previousAmount).toBeNull();
    expect(opportunity?.evidence.changeAmount).toBeNull();
    expect(opportunity?.evidence.changePercent).toBeNull();
    expect(opportunity?.confidence).toBe("limited");
    expect(opportunity?.observation).not.toMatch(/increase/i);
  });

  it("merges high share and meaningful increase into one combined opportunity", () => {
    const input = baseInput({
      totalCurrent: 10_000,
      categoryTrends: [
        // 30% share AND a 50% increase that also clears the materiality floor.
        { categoryId: 1, categoryName: "Rent-adjacent fees", current: 3000, previous: 2000, percentChange: 50, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 1500 },
        { id: 2, categoryId: 1, amount: 1500 },
      ],
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.type).toBe("CATEGORY_PRESSURE");
    expect(opportunities[0]?.confidence).toBe("strong"); // both signals fired
  });

  it("does not produce an opportunity for a declining category with no other signal", () => {
    const input = baseInput({
      totalCurrent: 20_000,
      categoryTrends: [
        // Declining, modest share, no other signal.
        { categoryId: 1, categoryName: "Fuel", current: 1000, previous: 1500, percentChange: (-500 / 1500) * 100, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 500 },
        { id: 2, categoryId: 1, amount: 500 },
      ],
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunities).toHaveLength(0);
  });
});

describe("FREQUENT_PURCHASE_ACCUMULATION", () => {
  it("qualifies only when count, share, and materiality all pass", () => {
    const input = baseInput({
      // share = 1200/8000 = 15% — above frequentCategorySharePercent (10) but
      // below highSharePercent (20), so this doesn't also read as CATEGORY_PRESSURE.
      totalCurrent: 8000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Ingredients", current: 1200, previous: 1200, percentChange: 0, recordCount: 6 },
      ],
      currentRecords: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, categoryId: 1, amount: 200 })),
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("FREQUENT_PURCHASE_ACCUMULATION");
    expect(opportunity?.evidence.recordCount).toBe(6);
  });

  it("does not qualify below the minimum count", () => {
    const input = baseInput({
      totalCurrent: 8000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Ingredients", current: 1200, previous: 1200, percentChange: 0, recordCount: 3 },
      ],
      currentRecords: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, categoryId: 1, amount: 400 })),
    });

    expect(computeReductionOpportunities(input, PERIOD_END_KEY, config)).toHaveLength(0);
  });

  it("does not qualify when category share is below the frequent-purchase threshold", () => {
    const input = baseInput({
      totalCurrent: 100_000, // 1200/100000 = 1.2% share, below frequentCategorySharePercent (10)
      categoryTrends: [
        { categoryId: 1, categoryName: "Ingredients", current: 1200, previous: 1200, percentChange: 0, recordCount: 6 },
      ],
      currentRecords: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, categoryId: 1, amount: 200 })),
    });

    expect(computeReductionOpportunities(input, PERIOD_END_KEY, config)).toHaveLength(0);
  });

  it("routes to RECORD_REVIEW_FIRST, not accumulation, when one record dominates and is flagged unusual", () => {
    const input = baseInput({
      totalCurrent: 6000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Repairs", current: 1200, previous: 1200, percentChange: 0, recordCount: 6 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 700 }, // 700/1200 = 58% — dominates (>= 50%)
        { id: 2, categoryId: 1, amount: 100 },
        { id: 3, categoryId: 1, amount: 100 },
        { id: 4, categoryId: 1, amount: 100 },
        { id: 5, categoryId: 1, amount: 100 },
        { id: 6, categoryId: 1, amount: 100 },
      ],
      unusualExpenses: [{ id: 1, categoryId: 1, amount: 700 }],
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("RECORD_REVIEW_FIRST");
    expect(opportunity?.relatedRecordIds).toEqual([1]);
  });

  it("EDGE CASE: one dominant record, not flagged, not otherwise material — falls through to no opportunity", () => {
    // This is the case flagged in review. A category with one dominant large
    // record disqualifies FREQUENT_PURCHASE_ACCUMULATION (dominance boundary).
    // It is not flagged as unusual/duplicate, so RECORD_REVIEW_FIRST does not
    // apply either. And its share/increase don't cross the CATEGORY_PRESSURE
    // thresholds. The documented, correct outcome is: no opportunity at all
    // for this category — not a crash, not a default/fallback opportunity.
    const input = baseInput({
      totalCurrent: 100_000, // large denominator keeps this category's share low
      categoryTrends: [
        { categoryId: 1, categoryName: "Equipment", current: 1200, previous: 1200, percentChange: 0, recordCount: 6 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 700 }, // dominates (58%) but unflagged
        { id: 2, categoryId: 1, amount: 100 },
        { id: 3, categoryId: 1, amount: 100 },
        { id: 4, categoryId: 1, amount: 100 },
        { id: 5, categoryId: 1, amount: 100 },
        { id: 6, categoryId: 1, amount: 100 },
      ],
      // No unusualExpenses, no duplicateFindings.
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunities).toHaveLength(0);
  });
});

describe("RECORD_REVIEW_FIRST", () => {
  it("uses existing duplicate findings, not a new detector", () => {
    const input = baseInput({
      totalCurrent: 5000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Supplies", current: 1000, previous: 1000, percentChange: 0, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 500 },
        { id: 2, categoryId: 1, amount: 500 },
      ],
      duplicateFindings: [{ expenseRecordId: 1, categoryId: 1, amount: 500 }],
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("RECORD_REVIEW_FIRST");
    expect(opportunity?.evidence.possibleDuplicateCount).toBe(1);
  });

  it("uses existing unusual-expense flags, not a new detector", () => {
    const input = baseInput({
      totalCurrent: 5000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Supplies", current: 1000, previous: 1000, percentChange: 0, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 900 },
        { id: 2, categoryId: 1, amount: 100 },
      ],
      unusualExpenses: [{ id: 1, categoryId: 1, amount: 900 }],
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunity?.type).toBe("RECORD_REVIEW_FIRST");
    expect(opportunity?.evidence.unusualRecordCount).toBe(1);
  });

  it("does not fire when flagged records don't materially contribute", () => {
    const input = baseInput({
      totalCurrent: 500_000,
      expectedMonthlyExpenses: 25_000, // floor = max(500, 500) = 500
      categoryTrends: [
        { categoryId: 1, categoryName: "Supplies", current: 1000, previous: 1000, percentChange: 0, recordCount: 3 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 10 },
        { id: 2, categoryId: 1, amount: 490 },
        { id: 3, categoryId: 1, amount: 500 },
      ],
      unusualExpenses: [{ id: 1, categoryId: 1, amount: 10 }], // flagged amount (10) below the floor (500)
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    // Category share here (1000/500000 = 0.2%) and amount (1000, just above
    // floor) don't clear CATEGORY_PRESSURE either, so nothing should fire.
    expect(opportunities.find((o) => o.categoryId === 1)).toBeUndefined();
  });
});

describe("ranking", () => {
  it("is stable and deterministic across repeated runs with the same input", () => {
    const input = baseInput({
      totalCurrent: 50_000,
      categoryTrends: [
        { categoryId: 1, categoryName: "A", current: 5000, previous: 2000, percentChange: 150, recordCount: 2 },
        { categoryId: 2, categoryName: "B", current: 4000, previous: 4000, percentChange: 0, recordCount: 2 },
        { categoryId: 3, categoryName: "C", current: 3000, previous: 3000, percentChange: 0, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 2500 },
        { id: 2, categoryId: 1, amount: 2500 },
        { id: 3, categoryId: 2, amount: 2000 },
        { id: 4, categoryId: 2, amount: 2000 },
        { id: 5, categoryId: 3, amount: 1500 },
        { id: 6, categoryId: 3, amount: 1500 },
      ],
    });

    const first = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    const second = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(first.map((o) => o.id)).toEqual(second.map((o) => o.id));
    // Larger absolute peso materiality ranks first among same-type opportunities.
    expect(first[0]?.categoryId).toBe(1);
  });

  it("ranks RECORD_REVIEW_FIRST with possible duplicates ahead of a larger CATEGORY_PRESSURE amount", () => {
    const input = baseInput({
      totalCurrent: 50_000,
      categoryTrends: [
        // Much larger amount, high share.
        { categoryId: 1, categoryName: "Big Category", current: 20_000, previous: 20_000, percentChange: 0, recordCount: 2 },
        // Smaller amount, but has an unresolved duplicate.
        { categoryId: 2, categoryName: "Flagged Category", current: 2000, previous: 2000, percentChange: 0, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 10_000 },
        { id: 2, categoryId: 1, amount: 10_000 },
        { id: 3, categoryId: 2, amount: 1000 },
        { id: 4, categoryId: 2, amount: 1000 },
      ],
      duplicateFindings: [{ expenseRecordId: 3, categoryId: 2, amount: 1000 }],
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunities[0]?.type).toBe("RECORD_REVIEW_FIRST");
    expect(opportunities[0]?.categoryId).toBe(2);
    expect(opportunities[1]?.type).toBe("CATEGORY_PRESSURE");
  });

  it("caps output at maxOpportunities and assigns priority by rank", () => {
    const smallConfig: ReductionOpportunityConfig = { ...config, maxOpportunities: 2 };
    const input = baseInput({
      totalCurrent: 50_000,
      categoryTrends: [
        { categoryId: 1, categoryName: "A", current: 15_000, previous: 15_000, percentChange: 0, recordCount: 2 },
        { categoryId: 2, categoryName: "B", current: 12_000, previous: 12_000, percentChange: 0, recordCount: 2 },
        { categoryId: 3, categoryName: "C", current: 10_000, previous: 10_000, percentChange: 0, recordCount: 2 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 7500 },
        { id: 2, categoryId: 1, amount: 7500 },
        { id: 3, categoryId: 2, amount: 6000 },
        { id: 4, categoryId: 2, amount: 6000 },
        { id: 5, categoryId: 3, amount: 5000 },
        { id: 6, categoryId: 3, amount: 5000 },
      ],
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, smallConfig);
    expect(opportunities).toHaveLength(2);
    expect(opportunities[0]?.priority).toBe("high");
    expect(opportunities[1]?.priority).toBe("medium");
  });
});

describe("bounded output and finite numbers", () => {
  it("bounds relatedRecordIds by maxRelatedRecordIds", () => {
    const smallConfig: ReductionOpportunityConfig = { ...config, maxRelatedRecordIds: 2 };
    const input = baseInput({
      totalCurrent: 6000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Ingredients", current: 1200, previous: 1200, percentChange: 0, recordCount: 6 },
      ],
      currentRecords: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, categoryId: 1, amount: 200 })),
    });

    const [opportunity] = computeReductionOpportunities(input, PERIOD_END_KEY, smallConfig);
    expect(opportunity?.relatedRecordIds.length).toBeLessThanOrEqual(2);
  });

  it("produces only finite numbers in every evidence field", () => {
    const input = baseInput({
      totalCurrent: 10_000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Utilities", current: 3000, previous: 2000, percentChange: 50, recordCount: 4 },
        { categoryId: 2, categoryName: "New Category", current: 2500, previous: 0, percentChange: null, recordCount: 5 },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 1500 },
        { id: 2, categoryId: 1, amount: 1500 },
        ...Array.from({ length: 5 }, (_, i) => ({ id: i + 10, categoryId: 2, amount: 500 })),
      ],
    });

    const opportunities = computeReductionOpportunities(input, PERIOD_END_KEY, config);
    expect(opportunities.length).toBeGreaterThan(0);
    for (const o of opportunities) {
      for (const [key, value] of Object.entries(o.evidence)) {
        if (value !== null) expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
      }
    }
  });

  it("produces an empty list, not an error, when there are no eligible categories", () => {
    const input = baseInput({ totalCurrent: 0, categoryTrends: [] });
    expect(computeReductionOpportunities(input, PERIOD_END_KEY, config)).toEqual([]);
  });
});

// ============================================================
// Cost-behavior-aware suggested checks — §5.2 / §15 Phase 5.
//
// Additive evidence/copy only: these tests assert that costBehavior never
// changes WHICH opportunity is produced, WHETHER it's produced, its
// priority, or its ranking — only which entries appear in `suggestedChecks`.
// ============================================================
describe("cost-behavior-aware suggested checks", () => {
  function categoryPressureInput(costBehavior?: "fixed" | "variable" | "mixed" | "unclassified"): ReductionOpportunityComputationInput {
    return baseInput({
      totalCurrent: 10_000,
      categoryTrends: [
        { categoryId: 1, categoryName: "Rent", current: 3000, previous: 3000, percentChange: 0, recordCount: 4, costBehavior },
      ],
      currentRecords: [
        { id: 1, categoryId: 1, amount: 1000 },
        { id: 2, categoryId: 1, amount: 1000 },
        { id: 3, categoryId: 1, amount: 500 },
        { id: 4, categoryId: 1, amount: 500 },
      ],
    });
  }

  it("echoes the category's costBehavior on the opportunity, lowercased", () => {
    const [opportunity] = computeReductionOpportunities(categoryPressureInput("fixed"), PERIOD_END_KEY, config);
    expect(opportunity?.costBehavior).toBe("fixed");
  });

  it("defaults costBehavior to 'unclassified' when the caller omits it", () => {
    const [opportunity] = computeReductionOpportunities(categoryPressureInput(undefined), PERIOD_END_KEY, config);
    expect(opportunity?.costBehavior).toBe("unclassified");
  });

  it("adds the fixed-cost review check only for a FIXED category", () => {
    const [fixed] = computeReductionOpportunities(categoryPressureInput("fixed"), PERIOD_END_KEY, config);
    expect(fixed?.suggestedChecks).toContain("Review the contract terms or continued need for this fixed cost.");

    const [unclassified] = computeReductionOpportunities(categoryPressureInput("unclassified"), PERIOD_END_KEY, config);
    expect(unclassified?.suggestedChecks).not.toContain("Review the contract terms or continued need for this fixed cost.");
  });

  it("adds the mixed-cost separation check only for a MIXED category", () => {
    const [mixed] = computeReductionOpportunities(categoryPressureInput("mixed"), PERIOD_END_KEY, config);
    expect(mixed?.suggestedChecks).toContain(
      "Consider separating the fixed and usage-dependent portions of this expense before deciding what to review.",
    );

    const [variable] = computeReductionOpportunities(categoryPressureInput("variable"), PERIOD_END_KEY, config);
    expect(variable?.suggestedChecks).not.toContain(
      "Consider separating the fixed and usage-dependent portions of this expense before deciding what to review.",
    );
  });

  it("adds no cost-behavior entries for UNCLASSIFIED (current default behavior is unchanged)", () => {
    const [unclassified] = computeReductionOpportunities(categoryPressureInput("unclassified"), PERIOD_END_KEY, config);
    const [omitted] = computeReductionOpportunities(categoryPressureInput(undefined), PERIOD_END_KEY, config);
    expect(unclassified?.suggestedChecks).toEqual([...SUGGESTED_CHECK_CATALOGUE.CATEGORY_PRESSURE]);
    expect(omitted?.suggestedChecks).toEqual([...SUGGESTED_CHECK_CATALOGUE.CATEGORY_PRESSURE]);
  });

  it("never changes eligibility, type, priority, or evidence based on costBehavior", () => {
    const behaviors = ["fixed", "variable", "mixed", "unclassified"] as const;
    const results = behaviors.map((b) => computeReductionOpportunities(categoryPressureInput(b), PERIOD_END_KEY, config));
    for (const [opportunity] of results) {
      expect(opportunity?.type).toBe("CATEGORY_PRESSURE");
      expect(opportunity?.priority).toBe("high");
      expect(opportunity?.confidence).toBe(results[0]![0]?.confidence);
      expect(opportunity?.evidence).toEqual(results[0]![0]?.evidence);
    }
  });
});
