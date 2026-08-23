import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import { buildModuleContext, INTERACTION_MODULES } from "../../src/services/aiContext.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * Guards the module-scoping contract of the Ask FinSight context.
 *
 * Dashboard is deliberately WIDE (its conversation wanders across expense
 * behaviour, recovery pace and the review queue); every other module is
 * deliberately NARROW, and that narrowness is the reason an expense-behaviour
 * question is not answered with recovery arithmetic. Both halves are asserted
 * here — widening the narrow modules by accident is the silent regression this
 * file exists to catch.
 */

const DASHBOARD_SECTION = "=== DASHBOARD SUMMARY";
const EXPENSE_SECTION = "=== EXPENSE BEHAVIOR DETAIL ===";
const RECOVERY_SECTION = "=== RECOVERY TARGET DETAIL ===";
const REVIEW_SECTION = "=== RECORDS NEEDING REVIEW ===";
const IMPACT_SECTION = "=== SPENDING IMPACT ===";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile(
    { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
    ["Inventory", "Utilities"]
  );
  // A little real activity so none of the blocks collapse to their empty-state
  // wording — an empty context would pass the section-marker assertions for
  // the wrong reason.
  for (let i = 1; i <= 4; i += 1) {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(-i),
      description: `Rice sack ${i}`,
      amount: 1200 + i * 10,
    });
  }
  await sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: utcDayString(0),
    description: "Daily sales",
    amount: 3000,
  });
});

afterAll(disconnectDb);

async function contextFor(module: (typeof INTERACTION_MODULES)[number], question = "how am I doing?") {
  const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
  const { context } = await buildModuleContext(ctx.user.id, profile, module, question);
  return context;
}

describe("Dashboard context is the wide one", () => {
  it("carries the dashboard summary plus expense, recovery and review detail", async () => {
    const context = await contextFor("Dashboard");
    expect(context).toContain(DASHBOARD_SECTION);
    expect(context).toContain(EXPENSE_SECTION);
    expect(context).toContain(RECOVERY_SECTION);
    expect(context).toContain(REVIEW_SECTION);
  });

  it("leads with the dashboard summary and reads the rest as supporting detail", async () => {
    const context = await contextFor("Dashboard");
    const order = [DASHBOARD_SECTION, EXPENSE_SECTION, RECOVERY_SECTION, REVIEW_SECTION].map((s) =>
      context.indexOf(s)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("excludes the scenario-driven spending-impact block", async () => {
    // That block is meaningless without a planned purchase parsed out of the
    // question, so including it unconditionally would be the largest block in
    // the context and pure noise.
    const context = await contextFor("Dashboard", "should I buy a new freezer for 20,000?");
    expect(context).not.toContain(IMPACT_SECTION);
  });

  it("does not compute a scenario, even when the question looks like one", async () => {
    const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    const { scenario } = await buildModuleContext(
      ctx.user.id,
      profile,
      "Dashboard",
      "if I buy a freezer for 20,000 what happens?"
    );
    expect(scenario).toBeUndefined();
  });
});

describe("the other modules stay narrow", () => {
  it("Expense Insights carries only its own detail block", async () => {
    const context = await contextFor("Expense Insights", "why is inventory so high?");
    expect(context).toContain(EXPENSE_SECTION);
    expect(context).not.toContain(RECOVERY_SECTION);
    expect(context).not.toContain(REVIEW_SECTION);
    expect(context).not.toContain(DASHBOARD_SECTION);
    expect(context).not.toContain(IMPACT_SECTION);
  });

  it("Recovery Target carries only its own detail block", async () => {
    const context = await contextFor("Recovery Target", "am I on pace?");
    expect(context).toContain(RECOVERY_SECTION);
    expect(context).not.toContain(EXPENSE_SECTION);
    expect(context).not.toContain(REVIEW_SECTION);
    expect(context).not.toContain(DASHBOARD_SECTION);
  });

  it("Records Review carries only its own detail block", async () => {
    const context = await contextFor("Records Review", "explain this flag");
    expect(context).toContain(REVIEW_SECTION);
    expect(context).not.toContain(EXPENSE_SECTION);
    expect(context).not.toContain(RECOVERY_SECTION);
    expect(context).not.toContain(DASHBOARD_SECTION);
  });

  it("Spending Impact carries only its own detail block, and still parses the scenario", async () => {
    const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    const { context, scenario } = await buildModuleContext(
      ctx.user.id,
      profile,
      "Spending Impact",
      "what if I buy a freezer for 20,000?"
    );
    expect(context).toContain(IMPACT_SECTION);
    expect(context).not.toContain(EXPENSE_SECTION);
    expect(context).not.toContain(RECOVERY_SECTION);
    expect(context).not.toContain(REVIEW_SECTION);
    expect(context).not.toContain(DASHBOARD_SECTION);
    expect(scenario?.amount).toBe(20000);
  });
});

describe("steering line", () => {
  it("tells the Dashboard model it may range across the wider context", async () => {
    const context = await contextFor("Dashboard");
    expect(context).toContain("looking at the Dashboard screen");
    expect(context).toMatch(/expense behaviour, recovery pace and review queue/i);
    // Planned purchases belong to Spending Impact's scenario path, which is
    // not in this context — the model must not invite them here.
    expect(context).toMatch(/Do not invite questions about planned purchases/i);
    expect(context).not.toContain("Stay scoped to that");
  });

  it.each(["Expense Insights", "Recovery Target", "Spending Impact", "Records Review"] as const)(
    "keeps the original narrow steering wording for %s",
    async (module) => {
      const context = await contextFor(module, "what if I buy a freezer for 20,000?");
      expect(context).toContain(
        `The owner is currently looking at the ${module} screen. Stay scoped to that unless they clearly ask about something else in this context.`
      );
    }
  );
});
