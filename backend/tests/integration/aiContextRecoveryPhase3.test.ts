import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as sales from "../../src/services/salesRecord.service";
import * as businessProfile from "../../src/services/businessProfile.service";
import { buildModuleContext } from "../../src/services/aiContext.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * Recovery Target AI context — Phase 3 deterministic facts (plan
 * docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §10.3/§11).
 *
 * These lines must be plain, server-computed arithmetic strings — never a
 * prompt asking the model to interpret `dataWarnings`/`setupIssues`/
 * `changeSincePreviousDay` itself. Each assertion below pins the exact
 * wording so a future change here is a deliberate, reviewed diff rather than
 * a drift nobody notices.
 */

const RECOVERY_SECTION = "=== RECOVERY TARGET DETAIL ===";
const NOTE_PREFIX = "- Note:";
const APPROX_LINE = "- Operating days are approximated from a monthly count, not an exact weekly schedule.";
const CHANGE_PREFIX = "- Since yesterday: adjusted daily target";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

afterAll(disconnectDb);
afterEach(() => {
  vi.useRealTimers();
});

async function addSale(amount: number, dayOffset: number, description = "Daily sales") {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: utcDayString(dayOffset),
    description,
    amount,
  });
}

async function recoverySectionFor(question = "am I on pace?") {
  const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
  const { context } = await buildModuleContext(ctx.user.id, profile, "Recovery Target", question);
  const start = context.indexOf(RECOVERY_SECTION);
  expect(start).toBeGreaterThanOrEqual(0);
  return context.slice(start);
}

describe("plain unconfigured profile — regression baseline", () => {
  beforeEach(async () => {
    await resetDb();
    // expectedMonthlyExpenses = 0 -> needsSetup, which per §9.7 already gets
    // its own "SETUP NEEDED" status line elsewhere in this context. None of
    // the three new Phase 3 lines should pile on top of it.
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 0, operatingDays: 25 });
  });

  it("adds no data-warning, no approximation note, and no change line", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    const section = await recoverySectionFor();
    expect(section).not.toContain(NOTE_PREFIX);
    expect(section).not.toContain(APPROX_LINE);
    expect(section).not.toContain(CHANGE_PREFIX);
  });
});

describe("operating-schedule approximation note", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile(
      { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
      ["Inventory", "Utilities"]
    );
  });

  it("is added once setup is complete but no weekly schedule is configured", async () => {
    vi.useFakeTimers();
    // Business-local (Asia/Manila, UTC+8) 2026-08-01 18:00 — the 1st of the
    // month, so changeSincePreviousDay is null and doesn't add its own line
    // on top of the one under test here.
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
    await addSale(4500, 0, "Confirmed sale");

    const section = await recoverySectionFor();
    expect(section).toContain(APPROX_LINE);
    expect(section).not.toContain(NOTE_PREFIX);
    expect(section).not.toContain(CHANGE_PREFIX);
  });

  it("is NOT added when the profile still needs setup — that's the bigger issue", async () => {
    await businessProfile.updateBusinessProfile(ctx.user.id, ctx.profile.id, { expectedMonthlyExpenses: 0 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));

    const section = await recoverySectionFor();
    expect(section).not.toContain(APPROX_LINE);
  });
});

describe("provisional-sales data-warning note", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile(
      { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
      ["Inventory", "Utilities"]
    );
  });

  it("reports the exact provisional peso amount when a sale needs review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
    await addSale(4500, 0, "Confirmed sale");
    const needsReview = await addSale(1000, 0, "Needs review sale");
    await sales.updateSalesRecord(ctx.user.id, needsReview.id, { reviewStatus: "Needs Review" });

    const section = await recoverySectionFor();
    expect(section).toContain(
      "- Note: PHP 1,000.00 of this month's recorded sales is pending review or flagged as a possible duplicate; the figures above include it."
    );
  });

  it("reports the same note for a flagged-duplicate sale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
    await addSale(4500, 0, "Confirmed sale");
    const flagged = await addSale(1000, 0, "Flagged sale");
    await sales.updateSalesRecord(ctx.user.id, flagged.id, { duplicateStatus: "Flagged" });

    const section = await recoverySectionFor();
    expect(section).toContain(
      "- Note: PHP 1,000.00 of this month's recorded sales is pending review or flagged as a possible duplicate; the figures above include it."
    );
  });

  it("adds no note at all when every sale this month is confirmed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
    await addSale(4500, 0, "Confirmed sale");

    const section = await recoverySectionFor();
    expect(section).not.toContain(NOTE_PREFIX);
  });
});

describe("'why it changed' line", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile(
      { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
      ["Inventory", "Utilities"]
    );
  });

  it("reports a decrease attributed to sales being recorded", async () => {
    vi.useFakeTimers();
    // Mirrors tests/integration/dashboardInsights.test.ts's changeSincePreviousDay
    // fixture: mid-month so remainingOperatingDays isn't clamped at an edge.
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    await addSale(4500, 0, "Day 15 sale");
    vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"));
    await addSale(20000, 0, "Day 16 sale");

    const section = await recoverySectionFor();
    expect(section).toMatch(/- Since yesterday: adjusted daily target decreased by PHP [\d,.]+ \(sales were recorded\)\./);
  });

  it("reports an increase attributed to a day elapsing when no new sales come in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    await addSale(4500, 0, "Only sale this month");
    vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"));

    const section = await recoverySectionFor();
    expect(section).toMatch(/- Since yesterday: adjusted daily target increased by PHP [\d,.]+ \(a day elapsed\)\./);
  });

  it("adds no change line on the 1st of the month, when there is no 'yesterday' to compare", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
    await addSale(4500, 0, "Confirmed sale");

    const section = await recoverySectionFor();
    expect(section).not.toContain(CHANGE_PREFIX);
  });
});
