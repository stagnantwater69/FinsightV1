import { describe, expect, it } from "vitest";
import { askSchema, createConversationSchema, appendMessageSchema } from "../../src/controllers/ai.controller";
import { SUGGESTED_CHECK_CATALOGUE } from "../../src/services/reductionOpportunity.service";

/**
 * Validates the request-side shape checked on `reductionOpportunity` (plan
 * §11.1): a structured, bounded object — not free-form client prose — so an
 * oversized or malformed payload is rejected before it ever reaches a prompt.
 */

function validOpportunity() {
  return {
    id: "ro_1",
    type: "CATEGORY_PRESSURE" as const,
    categoryId: 1,
    categoryName: "Inventory",
    priority: "high" as const,
    confidence: "strong" as const,
    observation: "Inventory makes up 40% of this period's expenses.",
    rationale: "Worth reviewing.",
    evidence: {
      currentAmount: 4800,
      previousAmount: 3600,
      changeAmount: 1200,
      changePercent: 33.3,
      expenseSharePercent: 40,
      recordCount: 4,
      unusualRecordCount: 0,
      possibleDuplicateCount: 0,
    },
    // [ADDED] Plan §5.2/§15 Phase 5 — see ReductionOpportunity.costBehavior.
    costBehavior: "unclassified" as const,
    suggestedChecks: [...SUGGESTED_CHECK_CATALOGUE.CATEGORY_PRESSURE],
    relatedRecordIds: [1, 2, 3],
    limitations: ["A large or growing category can still be necessary for the business."],
  };
}

describe("reductionOpportunity request schema", () => {
  it("accepts a well-formed opportunity on all three AI-chat entry points", () => {
    const opportunity = validOpportunity();
    expect(
      askSchema.safeParse({
        businessProfileId: 1,
        module: "Expense Insights",
        question: "Why was this flagged?",
        reductionOpportunity: opportunity,
      }).success
    ).toBe(true);
    expect(
      createConversationSchema.safeParse({
        businessProfileId: 1,
        originModule: "Expense Insights",
        question: "Why was this flagged?",
        reductionOpportunity: opportunity,
      }).success
    ).toBe(true);
    expect(
      appendMessageSchema.safeParse({
        question: "What should I check first?",
        reductionOpportunity: opportunity,
      }).success
    ).toBe(true);
  });

  it("is optional — the ordinary ask/append flow is unaffected", () => {
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Expense Insights", question: "hi" }).success
    ).toBe(true);
  });

  it("rejects an unknown opportunity type", () => {
    const opportunity = { ...validOpportunity(), type: "SOMETHING_ELSE" };
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Expense Insights", question: "hi", reductionOpportunity: opportunity })
        .success
    ).toBe(false);
  });

  it("rejects a non-finite evidence figure", () => {
    const opportunity = validOpportunity();
    (opportunity.evidence as unknown as { currentAmount: number }).currentAmount = Number.POSITIVE_INFINITY;
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Expense Insights", question: "hi", reductionOpportunity: opportunity })
        .success
    ).toBe(false);
  });

  it("rejects an oversized suggestedChecks or relatedRecordIds array", () => {
    const tooManyChecks = { ...validOpportunity(), suggestedChecks: Array(11).fill("check") };
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Expense Insights", question: "hi", reductionOpportunity: tooManyChecks })
        .success
    ).toBe(false);

    const tooManyIds = { ...validOpportunity(), relatedRecordIds: Array.from({ length: 21 }, (_, i) => i + 1) };
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Expense Insights", question: "hi", reductionOpportunity: tooManyIds })
        .success
    ).toBe(false);
  });

  it("rejects an oversized observation/rationale string", () => {
    const opportunity = { ...validOpportunity(), observation: "x".repeat(401) };
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Expense Insights", question: "hi", reductionOpportunity: opportunity })
        .success
    ).toBe(false);
  });

  it("does not reject the request when module is not Expense Insights (server-side code ignores it there instead)", () => {
    // Belt-and-suspenders: the module-scoping enforcement lives in
    // ai.service/conversation.service (tested in
    // tests/integration/aiContextReductionOpportunity.test.ts), not as a hard
    // 400 here, so a client that races a module switch doesn't get a broken
    // request — the extra field is just inert on any other module.
    const opportunity = validOpportunity();
    expect(
      askSchema.safeParse({ businessProfileId: 1, module: "Dashboard", question: "hi", reductionOpportunity: opportunity }).success
    ).toBe(true);
  });
});
