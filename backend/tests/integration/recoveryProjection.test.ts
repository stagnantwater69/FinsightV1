import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { resolveExactOperatingCounts } from "../../src/services/operatingCalendar.service";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { PROJECTION_LOOKBACK_OPEN_DAYS } from "../../src/services/analysis.service";

/**
 * `insights.computeRecoveryProjection` end-to-end against real seeded sales
 * and (where relevant) a real operating schedule — RECOVERY-TARGET-
 * IMPROVEMENT-PLAN.md §9.8/§11 Phase 5.
 *
 * NOT WIRED to any endpoint yet — see the doc comment on
 * `computeRecoveryProjection` in insights.service.ts. This file only proves
 * the function reads confirmed-only sales correctly and respects the exact
 * operating calendar when a schedule is configured; the pure guard/formula
 * logic itself is covered without a database in
 * tests/unit/recoveryProjection.test.ts.
 *
 * `computeRecoveryProjection` takes `today` as an explicit parameter (like
 * `computeWeeklyCheckpoints`), so every test controls it directly instead of
 * depending on the real system clock.
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const dateIso = (y: number, m: number, d: number) => utc(y, m, d).toISOString().slice(0, 10);

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 150000, operatingDays: 30 }, ["Inventory"]);
});

afterAll(disconnectDb);

async function addConfirmedSale(y: number, m: number, d: number, amount: number) {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: dateIso(y, m, d),
    description: "Daily sales",
    amount,
  });
}

async function addProvisionalSale(y: number, m: number, d: number, amount: number) {
  return prisma.salesReferenceRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      date: utc(y, m, d),
      description: "Unreviewed sale",
      amount,
      source: "MANUAL_ENTRY",
      reviewStatus: "Needs Review",
      duplicateStatus: "Not a Duplicate",
    },
  });
}

async function seedDailySchedule(closedWeekday: number) {
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.businessOperatingDay.create({
      data: { businessProfileId: ctx.profile.id, weekday, isOpen: weekday !== closedWeekday },
    });
  }
}

async function loadTargetsAnd(today: Date) {
  const exactCalendar = await resolveExactOperatingCounts(ctx.profile.id, today);
  const targets = await insights.loadRecoveryTargets(ctx.profile, today, exactCalendar);
  return { targets, exactCalendar };
}

describe("computeRecoveryProjection — reads confirmed-only sales (real seeded data)", () => {
  it("computes the projection from 7 confirmed lookback days, excluding a provisional-only day", async () => {
    // May 2026 (31 days), every day open (operatingDays = 30 default isn't
    // used here since no schedule is configured => approximation mode).
    // Confirmed sales on the 1st through the 7th (7 completed open days by
    // the 8th), and a provisional-only sale on the 8th that must not count
    // as "recent" evidence toward staleness being false (it's still within
    // the 3-day staleness window on day 9) nor into the confirmed average.
    for (let d = 1; d <= 7; d++) await addConfirmedSale(2026, 5, d, 1000);
    // A modest provisional sale on the 8th — small enough to stay under the
    // provisional-fraction guard (so the test actually exercises "excluded
    // from the average", not the separate too-much-provisional guard), but
    // large enough that if it were wrongly folded into the confirmed rate
    // the projected total below would visibly differ from the assertion.
    await addProvisionalSale(2026, 5, 8, 3500);

    const today = utc(2026, 5, 9);
    const { targets, exactCalendar } = await loadTargetsAnd(today);
    const projection = await insights.computeRecoveryProjection(
      ctx.profile.id,
      ctx.profile,
      today,
      exactCalendar,
      targets.confirmedSalesThisMonth,
      targets.remainingOperatingDays,
    );

    expect(projection.status).toBe("available");
    expect(projection.lookbackOperatingDays).toBe(PROJECTION_LOOKBACK_OPEN_DAYS);
    // 7,000 confirmed / 7 days = 1,000/day average — the 999,999 provisional
    // sale on day 8 must be completely absent from this rate.
    const expectedRate = 1000;
    const expected = targets.confirmedSalesThisMonth + expectedRate * targets.remainingOperatingDays;
    expect(projection.projectedMonthEndSales).toBeCloseTo(expected, 6);
    expect(projection.projectedVarianceAmount).toBeCloseTo(expected - 150000, 6);
  });

  it("returns stale_data when no sales at all were recorded in the last 3 calendar days", async () => {
    for (let d = 1; d <= 7; d++) await addConfirmedSale(2026, 5, d, 1000);
    // Nothing recorded on the 8th, 9th, or 10th.
    const today = utc(2026, 5, 11);
    const { targets, exactCalendar } = await loadTargetsAnd(today);
    const projection = await insights.computeRecoveryProjection(
      ctx.profile.id,
      ctx.profile,
      today,
      exactCalendar,
      targets.confirmedSalesThisMonth,
      targets.remainingOperatingDays,
    );
    expect(projection.status).toBe("stale_data");
    expect(projection.projectedMonthEndSales).toBeNull();
  });

  it("returns insufficient_data early in the month, before a week of open days has elapsed", async () => {
    await addConfirmedSale(2026, 5, 1, 1000);
    await addConfirmedSale(2026, 5, 2, 1000);
    const today = utc(2026, 5, 3);
    const { targets, exactCalendar } = await loadTargetsAnd(today);
    const projection = await insights.computeRecoveryProjection(
      ctx.profile.id,
      ctx.profile,
      today,
      exactCalendar,
      targets.confirmedSalesThisMonth,
      targets.remainingOperatingDays,
    );
    expect(projection.status).toBe("insufficient_data");
    expect(projection.lookbackOperatingDays).toBeLessThan(PROJECTION_LOOKBACK_OPEN_DAYS);
  });

  it("returns insufficient_data (0 lookback days) on the 1st of the month, without querying a backwards range", async () => {
    const today = utc(2026, 5, 1);
    const { targets, exactCalendar } = await loadTargetsAnd(today);
    const projection = await insights.computeRecoveryProjection(
      ctx.profile.id,
      ctx.profile,
      today,
      exactCalendar,
      targets.confirmedSalesThisMonth,
      targets.remainingOperatingDays,
    );
    expect(projection.status).toBe("insufficient_data");
    expect(projection.lookbackOperatingDays).toBe(0);
  });
});

describe("computeRecoveryProjection — respects the exact operating calendar", () => {
  it("counts only open weekdays toward the lookback window when a schedule is configured", async () => {
    // May 2026: 1st is a Friday (ISO weekday 5). Close Sundays (weekday 7).
    // Confirmed sales every calendar day 1-9 (including the closed Sunday,
    // the 3rd) — the Sunday's sale must not count toward the open-day
    // average or its day-count, even though it was recorded.
    await seedDailySchedule(7);
    for (let d = 1; d <= 9; d++) await addConfirmedSale(2026, 5, d, 1000);

    const today = utc(2026, 5, 10); // a Sunday itself — closed, but only matters for "today", not the lookback window
    const { targets, exactCalendar } = await loadTargetsAnd(today);
    expect(exactCalendar).not.toBeNull();

    const projection = await insights.computeRecoveryProjection(
      ctx.profile.id,
      ctx.profile,
      today,
      exactCalendar,
      targets.confirmedSalesThisMonth,
      targets.remainingOperatingDays,
    );

    // Open days from May 1 (Fri) through May 9 (Sat), excluding May 3 (Sun):
    // 1,2,4,5,6,7,8,9 = 8 open days, each with a confirmed 1,000 sale.
    expect(projection.status).toBe("available");
    expect(projection.lookbackOperatingDays).toBe(8);
    const expectedRate = 8000 / 8; // 1,000/day — the Sunday's own sale isn't excluded from the SUM (it's a real sale), only from the day COUNT
    // Confirmed sum over the lookback range includes May 3's sale too (it's
    // still a real confirmed sale on a real calendar day within the range) —
    // only the DAY COUNT used as the average's denominator excludes closed
    // days. So the sum is 9,000 (all 9 days' sales) divided by 8 open days.
    const expectedRateActual = 9000 / 8;
    const expected = targets.confirmedSalesThisMonth + expectedRateActual * targets.remainingOperatingDays;
    expect(projection.projectedMonthEndSales).toBeCloseTo(expected, 6);
    expect(expectedRate).not.toBe(expectedRateActual); // sanity: the two hand-computed rates differ, confirming the assertion above is deliberate
  });

  it("falls back to the approximation when no schedule is configured, and stays internally consistent with loadRecoveryTargets' own approximation", async () => {
    for (let d = 1; d <= 10; d++) await addConfirmedSale(2026, 5, d, 500);
    const today = utc(2026, 5, 11);
    const { targets, exactCalendar } = await loadTargetsAnd(today);
    expect(exactCalendar).toBeNull();
    expect(targets.operatingScheduleConfigured).toBe(false);

    const projection = await insights.computeRecoveryProjection(
      ctx.profile.id,
      ctx.profile,
      today,
      exactCalendar,
      targets.confirmedSalesThisMonth,
      targets.remainingOperatingDays,
    );

    // Enough calendar history exists (10 days) that the approximation should
    // clear the minimum lookback in this scenario (operatingDays=30, i.e.
    // every calendar day counts as open under the approximation).
    expect(projection.status).toBe("available");
    expect(projection.lookbackOperatingDays).toBeGreaterThanOrEqual(PROJECTION_LOOKBACK_OPEN_DAYS);
  });
});
