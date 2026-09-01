import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { buildModuleContext, INTERACTION_MODULES } from "../../src/services/aiContext.service";
import { SUGGESTED_CHECK_CATALOGUE, type ReductionOpportunity } from "../../src/services/reductionOpportunity.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * Guards plan §11.1/§5.4: a selected Reduction Opportunity attaches ONLY to
 * the existing "Expense Insights" module context, never to any other module,
 * and there is no new InteractionModule value for it.
 */

const OPPORTUNITY_SECTION = "=== SELECTED REDUCTION OPPORTUNITY";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

function fixtureOpportunity(categoryId: number): ReductionOpportunity {
  return {
    id: "ro_test",
    type: "CATEGORY_PRESSURE",
    categoryId,
    categoryName: "Inventory",
    priority: "high",
    confidence: "strong",
    observation: "Inventory makes up 40.0% of this period's expenses.",
    rationale: "Worth reviewing: a high share of spend, a material increase, or both, can point to a category worth a closer look.",
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
    suggestedChecks: [...SUGGESTED_CHECK_CATALOGUE.CATEGORY_PRESSURE],
    relatedRecordIds: [1, 2, 3],
    limitations: ["A large or growing category can still be necessary for the business."],
  };
}

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile(
    { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
    ["Inventory", "Utilities"]
  );
  for (let i = 1; i <= 4; i += 1) {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(-i),
      description: `Rice sack ${i}`,
      amount: 1200 + i * 10,
    });
  }
});

afterAll(disconnectDb);

async function contextFor(
  module: (typeof INTERACTION_MODULES)[number],
  opportunity?: ReductionOpportunity,
  question = "why is this category flagged?"
) {
  const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
  const { context } = await buildModuleContext(ctx.user.id, profile, module, question, opportunity);
  return context;
}

describe("selected reduction opportunity context", () => {
  it("attaches to Expense Insights when an opportunity is passed", async () => {
    const opportunity = fixtureOpportunity(ctx.categories.Inventory!);
    const context = await contextFor("Expense Insights", opportunity);
    expect(context).toContain(OPPORTUNITY_SECTION);
    expect(context).toContain("Category: Inventory");
  });

  it("is absent from Expense Insights when no opportunity is passed", async () => {
    const context = await contextFor("Expense Insights");
    expect(context).not.toContain(OPPORTUNITY_SECTION);
  });

  it.each(["Recovery Target", "Spending Impact", "Records Review", "Dashboard"] as const)(
    "never attaches to %s even when an opportunity is passed",
    async (module) => {
      const opportunity = fixtureOpportunity(ctx.categories.Inventory!);
      const context = await contextFor(module, opportunity, "tell me about this");
      expect(context).not.toContain(OPPORTUNITY_SECTION);
    }
  );

  it("still renders the normal Expense Insights detail block alongside the opportunity", async () => {
    const opportunity = fixtureOpportunity(ctx.categories.Inventory!);
    const context = await contextFor("Expense Insights", opportunity);
    expect(context).toContain("=== EXPENSE BEHAVIOR DETAIL ===");
    expect(context).toContain(OPPORTUNITY_SECTION);
  });

  it("steers the model toward the opportunity first while keeping the module scoped", async () => {
    const opportunity = fixtureOpportunity(ctx.categories.Inventory!);
    const context = await contextFor("Expense Insights", opportunity);
    expect(context).toMatch(/Reduction Opportunity card in Expense Insights/i);
  });
});
