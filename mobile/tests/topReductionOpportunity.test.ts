import { describe, expect, it } from "vitest";
import { selectTopOpportunity } from "../src/lib/topReductionOpportunity";
import type { ReductionOpportunity, ReductionOpportunityResponse } from "../src/lib/types";

/**
 * The Dashboard's gate for its one compact opportunity card — plan
 * §13.1/§15 Phase 5. Never shown for limited confidence, an empty list, or
 * insufficient history.
 */

function opportunity(overrides: Partial<ReductionOpportunity> = {}): ReductionOpportunity {
  return {
    id: "opp-1",
    type: "CATEGORY_PRESSURE",
    categoryId: 10,
    categoryName: "Stock",
    priority: "high",
    confidence: "strong",
    observation: "Stock rose sharply against the period before.",
    rationale: "Stock is 42% of expenses this period, up from 28%.",
    evidence: {
      currentAmount: 8400,
      previousAmount: 5200,
      changeAmount: 3200,
      changePercent: 61.5,
      expenseSharePercent: 42,
      recordCount: 9,
      unusualRecordCount: 0,
      possibleDuplicateCount: 0,
    },
    costBehavior: "unclassified",
    suggestedChecks: [],
    relatedRecordIds: [],
    limitations: [],
    ...overrides,
  };
}

function response(overrides: Partial<ReductionOpportunityResponse> = {}): ReductionOpportunityResponse {
  return {
    period: { days: 30, start: "2026-07-28", end: "2026-08-26" },
    dataQuality: { status: "sufficient", currentRecordCount: 20, previousRecordCount: 18, message: null },
    opportunities: [opportunity()],
    detectorVersion: "v1",
    ...overrides,
  };
}

describe("selectTopOpportunity", () => {
  it("returns the first ranked opportunity when confidence is not limited", () => {
    const top = opportunity({ id: "a" });
    const second = opportunity({ id: "b", confidence: "limited" });
    expect(selectTopOpportunity(response({ opportunities: [top, second] }))).toEqual(top);
  });

  it("hides the card when the top opportunity has limited confidence", () => {
    expect(
      selectTopOpportunity(response({ opportunities: [opportunity({ confidence: "limited" })] })),
    ).toBeNull();
  });

  it("hides the card when there are no opportunities", () => {
    expect(selectTopOpportunity(response({ opportunities: [] }))).toBeNull();
  });

  it("hides the card when history is insufficient, even with an opportunity present", () => {
    expect(
      selectTopOpportunity(
        response({
          dataQuality: { status: "insufficient", currentRecordCount: 1, previousRecordCount: 0, message: "Not enough history." },
        }),
      ),
    ).toBeNull();
  });

  it("hides the card when there is no response yet", () => {
    expect(selectTopOpportunity(null)).toBeNull();
  });
});
