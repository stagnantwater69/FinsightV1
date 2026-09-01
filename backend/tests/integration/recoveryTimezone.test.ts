import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * Recovery Target QA gate — RECOVERY-TARGET-IMPROVEMENT-PLAN.md §11 Phase 1 /
 * §17 Gate A/B.
 *
 * Unlike tests/unit/dates.test.ts (which exercises resolveBusinessToday as a
 * pure function against a fixed clock) and tests/unit/recoveryTarget.test.ts
 * (which exercises computeRecoveryTarget against caller-supplied `today`
 * values), this file drives the real integration path end to end: a real
 * BusinessProfile row with a real `timezone` column, real SalesReferenceRecord
 * rows, and the actual `getRecoveryInsight` service call that resolves "today"
 * from the server's real (faked) wall clock via `resolveBusinessToday`.
 *
 * The server clock is pinned with vitest fake timers rather than mocking
 * `resolveBusinessToday` itself, so both the test's own date math and the
 * service's internal `new Date()` calls agree on the same instant — see the
 * task notes on why building dates from testDb's `utcDayString` (which reads
 * the REAL current time) doesn't compose with a faked business-local "today".
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

afterEach(() => {
  vi.useRealTimers();
});

afterAll(disconnectDb);

async function addSaleOn(dateKey: string, amount: number, description = "Sale") {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: dateKey,
    description,
    amount,
  });
}

describe("Manila is already 'tomorrow' while the UTC calendar is still on today", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 125000, operatingDays: 25, timezone: "Asia/Manila" });
    vi.useFakeTimers();
    // 20:00 UTC on the 25th = 04:00 the next Manila morning (UTC+8).
    vi.setSystemTime(new Date("2026-07-25T20:00:00.000Z"));
  });

  it("anchors asOfDate on the Manila-local calendar day, not the UTC one", async () => {
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.asOfDate).toBe("2026-07-26");
    expect(result.timezone).toBe("Asia/Manila");
  });

  it("counts a sale dated the Manila-local day as today's sale, even though UTC still reads the previous day", async () => {
    await addSaleOn("2026-07-26", 4500, "Manila-local today");
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.todaysSales).toBe(4500);
  });
});

describe("Los Angeles is still 'yesterday' while the UTC calendar has already rolled over", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({
      expectedMonthlyExpenses: 125000,
      operatingDays: 25,
      timezone: "America/Los_Angeles",
    });
    vi.useFakeTimers();
    // 02:00 UTC on the 26th = 19:00 the previous evening in Los Angeles (PDT, UTC-7).
    vi.setSystemTime(new Date("2026-07-26T02:00:00.000Z"));
  });

  it("anchors asOfDate on the LA-local calendar day, one day behind UTC", async () => {
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.asOfDate).toBe("2026-07-25");
    expect(result.timezone).toBe("America/Los_Angeles");
  });

  it("does not yet count a sale dated the UTC-calendar day, since LA has not turned over to it", async () => {
    await addSaleOn("2026-07-26", 4500, "UTC-only day, not LA's yet");
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.todaysSales).toBe(0);
  });
});

/**
 * Proves resolveBusinessToday is genuinely IANA-aware rather than a
 * fixed-offset calculation in disguise: America/New_York is UTC-5 in January
 * (EST) and UTC-4 in July (EDT). An instant chosen to straddle midnight under
 * the real (DST-aware) offset but NOT under a hardcoded -5 offset only lands
 * on the correct local calendar day if the implementation actually consults
 * the IANA rules for the date in question. Neither instant below is a DST
 * transition day itself.
 */
describe("America/New_York — DST-aware, not a fixed UTC-5 offset", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({
      expectedMonthlyExpenses: 125000,
      operatingDays: 25,
      timezone: "America/New_York",
    });
  });

  it("in July (EDT, UTC-4): the real local day is AHEAD of what a hardcoded UTC-5 offset would compute", async () => {
    vi.useFakeTimers();
    // 04:30 UTC on Jul 15. Real EDT (-4h) -> Jul 15 00:30 -> local day 2026-07-15.
    // A hardcoded -5h offset would instead give Jul 14 23:30 -> 2026-07-14.
    vi.setSystemTime(new Date("2026-07-15T04:30:00.000Z"));
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.asOfDate).toBe("2026-07-15");
  });

  it("in January (EST, UTC-5): the same instant-shape calculation matches a UTC-5 offset, as a control", async () => {
    vi.useFakeTimers();
    // Same clock time of day, non-DST month: 04:30 UTC on Jan 15.
    // EST (-5h) -> Jan 14 23:30 -> local day 2026-01-14, matching a fixed -5h offset.
    vi.setSystemTime(new Date("2026-01-15T04:30:00.000Z"));
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.asOfDate).toBe("2026-01-14");
  });
});

describe("month rollover: Manila-local 1st of the month while UTC is still on the last day of the previous month", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 125000, operatingDays: 25, timezone: "Asia/Manila" });
    vi.useFakeTimers();
    // 20:00 UTC on Jul 31 = 04:00 Aug 1 in Manila. UTC calendar is still July.
    vi.setSystemTime(new Date("2026-07-31T20:00:00.000Z"));
  });

  it("anchors asOfDate and monthStart on the new (Manila-local) month, not the UTC one", async () => {
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.asOfDate).toBe("2026-08-01");
    expect(result.monthStart.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("counts a sale dated the new month's 1st as this month's sale, and excludes one dated the old month's last day", async () => {
    await addSaleOn("2026-07-31", 1000, "Previous (UTC-calendar) month");
    await addSaleOn("2026-08-01", 5000, "New (Manila-local) month");

    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.salesThisMonth).toBe(5000);
    expect(result.todaysSales).toBe(5000);
    expect(result.monthHasNoRecords).toBe(false);
  });
});
