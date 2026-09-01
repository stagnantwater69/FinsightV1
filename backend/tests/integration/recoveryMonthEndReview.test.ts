import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { resolveBusinessToday } from "../../src/lib/dates";

/**
 * `insights.computeMonthEndReview` end-to-end against real seeded sales and
 * (where relevant) a real operating schedule — RECOVERY-TARGET-IMPROVEMENT-
 * PLAN.md §10.9/§11 Phase 7.
 *
 * NOT WIRED to any endpoint yet — see the doc comment on
 * `computeMonthEndReview` in insights.service.ts. This file proves the
 * function reads confirmed-only sales correctly, respects the exact
 * operating calendar when a schedule is configured, and never writes
 * anything; the pure materiality/selection/templating logic itself is
 * covered without a database in tests/unit/recoveryMonthEndReview.test.ts.
 *
 * `computeMonthEndReview` resolves "today" internally via
 * `resolveBusinessToday(profile.timezone)` off the real system clock (like
 * every other Recovery Target entry point) — these tests use a fixed
 * synthetic month (May 2020) that is guaranteed to be in the past relative
 * to the actual system clock this suite runs under, and separately prove
 * the "not yet reviewable" guard using the REAL current/next month.
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

describe("computeMonthEndReview — not-yet-reviewable guard", () => {
  it("refuses to summarize the current (still in-progress) month", async () => {
    // Same clock the function under test resolves "today" from — see
    // resolveBusinessToday's own comment on why a naive `new Date()` UTC
    // getter disagrees with it for roughly a third of every day (this
    // profile's default timezone, Asia/Manila, is already on its next
    // calendar day for 16:00-23:59 UTC).
    const today = resolveBusinessToday(ctx.profile.timezone);
    const currentMonth = utc(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, currentMonth);
    expect(result.status).toBe("not_yet_reviewable");
  });

  it("refuses to summarize a future month", async () => {
    const today = resolveBusinessToday(ctx.profile.timezone);
    const futureMonth = utc(today.getUTCFullYear() + 1, today.getUTCMonth() + 1, 1);
    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, futureMonth);
    expect(result.status).toBe("not_yet_reviewable");
  });

  it("treats a definitely-past month as reviewable", async () => {
    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 1, 15));
    expect(result.status).toBe("reviewable");
  });
});

describe("computeMonthEndReview — normal completed month, no schedule configured", () => {
  it("computes coverage, surplus/shortfall, and strongest/weakest confirmed days", async () => {
    // May 2020 (31 days), no schedule => every calendar day is a potential
    // open day per this function's documented fallback.
    await addConfirmedSale(2020, 5, 1, 1000);
    await addConfirmedSale(2020, 5, 15, 9000); // strongest
    await addConfirmedSale(2020, 5, 31, 200); // weakest among days WITH a recorded sale, but...
    // every other day in May has zero sales, so the weakest open day is
    // actually one of those (earliest: May 2nd), not the 200 sale.

    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 5, 10));
    expect(result.status).toBe("reviewable");
    if (result.status !== "reviewable") throw new Error("unreachable");

    expect(result.month).toBe("2020-05");
    expect(result.operatingScheduleConfigured).toBe(false);
    expect(result.openDayCount).toBe(31);

    const totalSales = 1000 + 9000 + 200;
    expect(result.coveragePercent).toBeCloseTo((totalSales / 150000) * 100, 6);
    expect(result.surplusOrShortfall).toBeCloseTo(totalSales - 150000, 6);

    expect(result.strongestOpenDay).toEqual({ date: "2020-05-15", sales: 9000 });
    expect(result.weakestOpenDay).toEqual({ date: "2020-05-02", sales: 0 });

    // originalDailyTarget uses profile.operatingDays (30) as the approximation.
    expect(result.originalDailyTarget).toBeCloseTo(150000 / 30, 6);
    // No schedule configured => remainingOperatingDays is always clamped >= 1,
    // so finalAdjustedDailyTarget is a real number, never null.
    expect(result.finalAdjustedDailyTarget).not.toBeNull();

    // Coverage is far under 100% (~6.8%) => flagged as materially off pattern.
    expect(result.baselineAppearsOffFromPattern).toBe(true);
    expect(result.suggestedQuestionsForNextMonth.length).toBeGreaterThanOrEqual(2);
    expect(result.suggestedQuestionsForNextMonth.length).toBeLessThanOrEqual(4);
  });
});

describe("computeMonthEndReview — provisional sales", () => {
  it("counts a day with a provisional-only sale as missing/provisional, and excludes it from confirmed strongest/weakest", async () => {
    await addConfirmedSale(2020, 6, 1, 5000);
    await addProvisionalSale(2020, 6, 2, 999999); // huge, but not confirmed — must not read as "strongest"

    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 6, 15));
    expect(result.status).toBe("reviewable");
    if (result.status !== "reviewable") throw new Error("unreachable");

    // June has 30 days; June 2 is provisional (confirmed=0 there), every
    // other day (28 of them, excluding June 1) has zero total sales.
    expect(result.strongestOpenDay?.date).toBe("2020-06-01");
    expect(result.strongestOpenDay?.sales).toBe(5000);
    // June 2 has confirmed=0 like the 28 untouched days, but the untouched
    // days are earlier/later than June 2 is irrelevant here — the weakest
    // among all the zero-confirmed days is whichever is earliest chronologically.
    expect(result.weakestOpenDay?.sales).toBe(0);

    // Missing/provisional count: June 2 (provisional) + every other
    // zero-sales day (28 days) = 29 of 30 open days.
    expect(result.missingOrProvisionalDayCount).toBe(29);
    expect(result.openDayCount).toBe(30);
  });
});

describe("computeMonthEndReview — schedule with closed days", () => {
  it("excludes closed weekdays from strongestOpenDay/weakestOpenDay/openDayCount and from the missing/provisional count", async () => {
    // July 2020: 1st is a Wednesday. Close Sundays (weekday 7).
    await seedDailySchedule(7);
    // Put a large sale on a closed Sunday (July 5) — must be completely
    // excluded from the open-day population, not just deprioritized.
    await addConfirmedSale(2020, 7, 5, 999999);
    await addConfirmedSale(2020, 7, 6, 2000);

    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 7, 20));
    expect(result.status).toBe("reviewable");
    if (result.status !== "reviewable") throw new Error("unreachable");

    expect(result.operatingScheduleConfigured).toBe(true);
    // July has 31 days; Sundays in July 2020: 5, 12, 19, 26 => 4 closed days.
    expect(result.openDayCount).toBe(31 - 4);

    // The huge Sunday sale must not appear as the strongest open day.
    expect(result.strongestOpenDay?.date).not.toBe("2020-07-05");
    expect(result.strongestOpenDay).toEqual({ date: "2020-07-06", sales: 2000 });
  });

  it("returns null finalAdjustedDailyTarget when the schedule's last calendar day of the month is closed", async () => {
    // August 2020 has 31 days; August 31, 2020 is a Monday. Close Mondays so
    // the month's literal last day is closed.
    await seedDailySchedule(1);
    await addConfirmedSale(2020, 8, 3, 1000);

    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 8, 15));
    expect(result.status).toBe("reviewable");
    if (result.status !== "reviewable") throw new Error("unreachable");
    expect(result.finalAdjustedDailyTarget).toBeNull();
  });
});

describe("computeMonthEndReview — zero sales all month", () => {
  it("does not crash, and both strongest and weakest point at the same real zero-sales open day", async () => {
    const result = await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 9, 15));
    expect(result.status).toBe("reviewable");
    if (result.status !== "reviewable") throw new Error("unreachable");

    expect(result.coveragePercent).toBe(0);
    expect(result.surplusOrShortfall).toBeCloseTo(-150000, 6);
    expect(result.strongestOpenDay).toEqual({ date: "2020-09-01", sales: 0 });
    expect(result.weakestOpenDay).toEqual({ date: "2020-09-01", sales: 0 });
    // Every open day in September (30, no schedule configured) is missing.
    expect(result.missingOrProvisionalDayCount).toBe(30);
    expect(result.openDayCount).toBe(30);
    expect(result.baselineAppearsOffFromPattern).toBe(true);
  });
});

describe("computeMonthEndReview — never writes anything", () => {
  it("leaves the business profile's expectedMonthlyExpenses and operatingDays untouched", async () => {
    await addConfirmedSale(2020, 5, 1, 1000);
    await insights.computeMonthEndReview(ctx.profile.id, ctx.profile, utc(2020, 5, 15));

    const reloaded = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    expect(Number(reloaded.expectedMonthlyExpenses)).toBe(150000);
    expect(reloaded.operatingDays).toBe(30);
  });
});
