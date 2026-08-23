import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the per-message loader sharing in aiContext.service actually holds.
 *
 * The Dashboard context is the union of four blocks on top of the shared
 * financial snapshot, and two of those figures (expense behaviour, recovery
 * targets) are needed by more than one block. Each block fetching its own copy
 * would double expensive reads on a billed, latency-sensitive path — so the
 * blocks share one in-flight promise per buildModuleContext call.
 *
 * These counters wrap the real insights service rather than replacing it: the
 * numbers in the rendered context still come from the database, so a dedup
 * that accidentally changed the output would fail the byte-identity check at
 * the bottom of this file rather than pass a mocked-away assertion.
 */

const behaviorCalls = vi.fn();
const recoveryTargetCalls = vi.fn();
const recoveryInsightCalls = vi.fn();

vi.mock("../../src/services/insights.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/insights.service")>();
  return {
    ...actual,
    getExpenseBehavior: (...args: Parameters<typeof actual.getExpenseBehavior>) => {
      behaviorCalls(...args);
      return actual.getExpenseBehavior(...args);
    },
    loadRecoveryTargets: (...args: Parameters<typeof actual.loadRecoveryTargets>) => {
      recoveryTargetCalls(...args);
      return actual.loadRecoveryTargets(...args);
    },
    getRecoveryInsight: (...args: Parameters<typeof actual.getRecoveryInsight>) => {
      recoveryInsightCalls(...args);
      return actual.getRecoveryInsight(...args);
    },
  };
});

import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import { buildModuleContext } from "../../src/services/aiContext.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile(
    { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
    ["Inventory", "Utilities"]
  );
  for (let i = 1; i <= 3; i += 1) {
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
  // Cleared AFTER setup so the fixtures' own service calls aren't counted.
  behaviorCalls.mockClear();
  recoveryTargetCalls.mockClear();
  recoveryInsightCalls.mockClear();
});

afterAll(disconnectDb);

async function contextFor(module: Parameters<typeof buildModuleContext>[2], question = "how am I doing?") {
  const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
  const { context } = await buildModuleContext(ctx.user.id, profile, module, question);
  return context;
}

describe("expense-behaviour read is shared per message", () => {
  it("runs exactly once for a Dashboard message, despite two blocks needing it", async () => {
    await contextFor("Dashboard");
    // Snapshot + Expense Insights block, one read.
    expect(behaviorCalls).toHaveBeenCalledTimes(1);
  });

  it("still runs exactly once for an Expense Insights message", async () => {
    await contextFor("Expense Insights", "why is inventory so high?");
    expect(behaviorCalls).toHaveBeenCalledTimes(1);
  });

  it("runs once for the modules that only need it for the snapshot", async () => {
    await contextFor("Records Review", "explain this flag");
    expect(behaviorCalls).toHaveBeenCalledTimes(1);
  });
});

describe("recovery read is shared per message", () => {
  it("does not add a targets-only read when the recovery block is rendered (Recovery Target)", async () => {
    await contextFor("Recovery Target", "am I on pace?");
    expect(recoveryInsightCalls).toHaveBeenCalledTimes(1);
    // The snapshot now reads its targets off the recovery insight instead of
    // issuing its own loadRecoveryTargets.
    expect(recoveryTargetCalls).toHaveBeenCalledTimes(0);
  });

  it("does not add a targets-only read from the snapshot on Dashboard", async () => {
    await contextFor("Dashboard");
    expect(recoveryInsightCalls).toHaveBeenCalledTimes(1);
    // The single remaining call belongs to dashboard.service's own summary
    // (a different service, outside this file's dedup), NOT to the snapshot.
    expect(recoveryTargetCalls).toHaveBeenCalledTimes(1);
  });

  it("keeps the cheaper targets-only read for modules without a recovery block", async () => {
    await contextFor("Expense Insights", "why is inventory so high?");
    expect(recoveryTargetCalls).toHaveBeenCalledTimes(1);
    expect(recoveryInsightCalls).toHaveBeenCalledTimes(0);
  });
});

describe("sharing did not change the rendered context", () => {
  it("renders the snapshot's recovery block identically on the shared and unshared paths", async () => {
    // Records Review takes the unshared path (its own loadRecoveryTargets);
    // Dashboard takes the shared one. The rendered lines must match exactly.
    const recoverySection = (context: string) =>
      context.slice(context.indexOf("Recovery status (month to date):")).split("\n=== ")[0];

    const unshared = recoverySection(await contextFor("Records Review", "explain this flag"));
    const shared = recoverySection(await contextFor("Dashboard"));

    expect(unshared).not.toBe("");
    expect(shared).toBe(unshared);
  });

  it("renders the snapshot's spending lines identically with a shared behaviour read", async () => {
    const snapshotSection = (context: string) =>
      context.slice(context.indexOf("=== FINANCIAL SNAPSHOT"), context.indexOf("Recovery status (month to date):"));

    const dashboard = snapshotSection(await contextFor("Dashboard"));
    const review = snapshotSection(await contextFor("Records Review", "explain this flag"));

    expect(dashboard).not.toBe("");
    expect(dashboard).toBe(review);
  });
});
