import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { resolveExactOperatingCounts } from "../../src/services/operatingCalendar.service";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { utcDateKey, utcDaysInMonth } from "../../src/lib/dates";

/**
 * `insights.computeWeeklyCheckpoints` end-to-end against real seeded sales and
 * (where relevant) a real operating schedule/override — RECOVERY-TARGET-
 * IMPROVEMENT-PLAN.md §10.4, Phase 4. The checkpoint MATH itself (date
 * alignment, tolerance-based status, approximation vs. exact target) is
 * covered without a database in tests/unit/recoveryTarget.test.ts
 * (`deriveRecoveryCheckpoints`); this file only exercises the DB-backed
 * wiring — the grouped sales query and `resolveExactOperatingCounts` —
 * feeding that pure function correctly.
 *
 * `computeWeeklyCheckpoints` takes `today` as an explicit parameter rather
 * than resolving it from the system clock, so every test below controls
 * `today` directly instead of depending on whatever real calendar date the
 * suite happens to run on (needed to exercise a short February deterministically).
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 150000, operatingDays: 30 }, ["Inventory"]);
});

afterAll(disconnectDb);

async function addSale(dateIso: string, amount: number) {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: dateIso,
    description: "Daily sales",
    amount,
  });
}

async function seedDailySchedule(closedWeekday: number) {
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.businessOperatingDay.create({
      data: { businessProfileId: ctx.profile.id, weekday, isOpen: weekday !== closedWeekday },
    });
  }
}

describe("computeWeeklyCheckpoints — approximation mode, real seeded sales", () => {
  it("anchors every checkpoint's recorded amount to the 1st of the month, not to any coverageDays window", async () => {
    // May 2026 (31 days) — approximation mode (no BusinessOperatingDay rows).
    const today = utc(2026, 5, 10);
    await addSale("2026-05-01", 20000);
    await addSale("2026-05-07", 5000);
    await addSale("2026-05-10", 3000);
    // Outside the month, must never be counted.
    await addSale("2026-04-30", 999999);

    const targets = await insights.loadRecoveryTargets(ctx.profile, today);
    const checkpoints = await insights.computeWeeklyCheckpoints(ctx.profile.id, ctx.profile, today, targets.dailyNeededTarget, null);

    expect(checkpoints.map((c) => c.endDate)).toEqual(["2026-05-07", "2026-05-14", "2026-05-21", "2026-05-28", "2026-05-31"]);
    // First checkpoint (05-07): 05-01 + 05-07 = 25,000.
    expect(checkpoints[0]!.recordedAmount).toBe(25000);
    // Second checkpoint (05-14) is in the future relative to today (05-10) —
    // no, 05-14 > 05-10 so it's pending; but the current-month running total
    // through today's own date isn't a checkpoint boundary here. Confirm the
    // 05-14 checkpoint is pending, and no checkpoint's recordedAmount ever
    // includes the 05-01..05-10 sales beyond what's cumulative-correct.
    expect(checkpoints[1]!.status).toBe("pending");
    expect(checkpoints[1]!.recordedAmount).toBeNull();
  });

  it("computes exactly 4 checkpoints for a non-leap February, with the last landing on the 28th (no dangling extra day)", async () => {
    const today = utc(2026, 2, 28);
    expect(utcDaysInMonth(today)).toBe(28);
    await addSale("2026-02-01", 1000);

    const targets = await insights.loadRecoveryTargets(ctx.profile, today);
    const checkpoints = await insights.computeWeeklyCheckpoints(ctx.profile.id, ctx.profile, today, targets.dailyNeededTarget, null);

    expect(checkpoints.map((c) => c.endDate)).toEqual(["2026-02-07", "2026-02-14", "2026-02-21", "2026-02-28"]);
    // The final checkpoint IS the last day of the month and today at once —
    // it must be resolved, not pending.
    expect(checkpoints[3]!.status).not.toBe("pending");
    expect(checkpoints[3]!.recordedAmount).toBe(1000);
  });
});

describe("computeWeeklyCheckpoints — exact operating schedule, including an override", () => {
  it("a holiday closure inside a checkpoint's date range lowers that checkpoint's cumulativeTarget versus the same schedule without it", async () => {
    // June 2026 (30 days), closed Sundays. June 2026: the 1st is a Monday, so
    // the only Sunday within the first checkpoint window (06-01..06-07) is
    // 06-07 itself.
    await seedDailySchedule(7 /* Sunday */);
    const today = utc(2026, 6, 20);
    const exactCalendarBefore = await resolveExactOperatingCounts(ctx.profile.id, today);
    expect(exactCalendarBefore).not.toBeNull();

    const targets = await insights.loadRecoveryTargets(ctx.profile, today, exactCalendarBefore);
    const before = await insights.computeWeeklyCheckpoints(
      ctx.profile.id,
      ctx.profile,
      today,
      targets.dailyNeededTarget,
      exactCalendarBefore,
    );

    // Now add a holiday override closing an otherwise-open day inside the
    // same first-checkpoint window (06-03, a Wednesday).
    await prisma.businessOperatingDayOverride.create({
      data: { businessProfileId: ctx.profile.id, date: utc(2026, 6, 3), type: "CLOSED", reason: "Test holiday" },
    });
    const exactCalendarAfter = await resolveExactOperatingCounts(ctx.profile.id, today);
    const after = await insights.computeWeeklyCheckpoints(
      ctx.profile.id,
      ctx.profile,
      today,
      targets.dailyNeededTarget,
      exactCalendarAfter,
    );

    expect(after[0]!.endDate).toBe("2026-06-07");
    expect(after[0]!.cumulativeTarget).toBeLessThan(before[0]!.cumulativeTarget);
    expect(before[0]!.cumulativeTarget - after[0]!.cumulativeTarget).toBeCloseTo(targets.dailyNeededTarget, 6);
  });

  it("recordedAmount reflects real seeded sales summed cumulatively through the exact-mode checkpoint dates", async () => {
    await seedDailySchedule(7);
    const today = utc(2026, 6, 20);
    await addSale("2026-06-01", 4000);
    await addSale("2026-06-05", 6000);
    await addSale("2026-06-14", 2500);

    const exactCalendar = await resolveExactOperatingCounts(ctx.profile.id, today);
    const targets = await insights.loadRecoveryTargets(ctx.profile, today, exactCalendar);
    const checkpoints = await insights.computeWeeklyCheckpoints(
      ctx.profile.id,
      ctx.profile,
      today,
      targets.dailyNeededTarget,
      exactCalendar,
    );

    expect(checkpoints[0]!.recordedAmount).toBe(10000); // 06-01 + 06-05
    expect(checkpoints[1]!.recordedAmount).toBe(12500); // + 06-14
  });
});

describe("getRecoveryInsight — weeklyCheckpoints wired into the main response", () => {
  it("includes weeklyCheckpoints bounded to the current month, anchored to the business-local today used by the rest of the response", async () => {
    await addSale(utcDateKey(new Date()), 500);
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    expect(Array.isArray(result.weeklyCheckpoints)).toBe(true);
    expect(result.weeklyCheckpoints.length).toBeGreaterThan(0);
    for (const checkpoint of result.weeklyCheckpoints) {
      expect(checkpoint.endDate.startsWith(result.asOfDate.slice(0, 7))).toBe(true);
    }
  });
});
