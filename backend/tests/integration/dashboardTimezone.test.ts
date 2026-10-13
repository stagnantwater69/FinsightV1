import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as expenses from "../../src/services/expenseRecord.service";
import * as dashboard from "../../src/services/dashboard.service";
import * as insights from "../../src/services/insights.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * The eight hours a day the Dashboard disagreed with the owner's calendar.
 *
 * `BusinessProfile.timezone` defaults to `Asia/Manila` (UTC+8) and record
 * dates are date-only `@db.Date` values. The summary, the cashflow chart and
 * the expense-behaviour comparison all anchored their windows on the server's
 * UTC day. So from 00:00 to 08:00 Manila time — the whole morning of trading —
 * "today" was still yesterday's UTC date, and an expense the owner had just
 * entered for today fell past the window's upper bound: absent from the
 * period total, absent from the chart's last bucket, and absent from the
 * comparison against the previous period.
 *
 * The clock is pinned with fake timers rather than mocking `resolveBusinessToday`,
 * so the service's own `new Date()` and this file's expectations read the same
 * instant — the same approach recoveryTimezone.test.ts takes, and for the same
 * reason. 2026-09-16T16:30:00Z is 00:30 on 2026-09-17 in Manila: inside the
 * broken window, and squarely on the previous day by UTC.
 */

const MANILA_EARLY_MORNING = new Date("2026-09-16T16:30:00.000Z");
/** The Manila calendar day at that instant. UTC still reads 2026-09-16. */
const MANILA_TODAY = "2026-09-17";
const UTC_TODAY = "2026-09-16";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

afterEach(() => {
  vi.useRealTimers();
});

afterAll(disconnectDb);

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ timezone: "Asia/Manila" });
  vi.useFakeTimers();
  vi.setSystemTime(MANILA_EARLY_MORNING);
});

/** Guards the premise: if these ever agree, the window below proves nothing. */
it("is pinned inside the Manila-midnight-to-08:00 window", () => {
  expect(MANILA_EARLY_MORNING.toISOString().slice(0, 10)).toBe(UTC_TODAY);
  expect(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(MANILA_EARLY_MORNING),
  ).toBe(MANILA_TODAY);
});

describe("the dashboard's day is the business's day, not the server's", () => {
  async function addExpenseOn(dateKey: string, amount: number, description = "Morning delivery") {
    return expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: dateKey,
      description,
      amount,
    });
  }

  it("counts an expense dated the Manila day in the period total", async () => {
    await addExpenseOn(MANILA_TODAY, 1250);

    const summary = await dashboard.getDashboardSummary(ctx.user.id, ctx.profile.id, 7);

    expect(summary.overview.totalExpenses).toBe(1250);
    // The window's own upper bound moved with it.
    expect(summary.periodEnd?.toISOString().slice(0, 10)).toBe(MANILA_TODAY);
  });

  it("gives the cashflow chart a last bucket the owner is actually living in", async () => {
    await addExpenseOn(MANILA_TODAY, 900);

    const { points } = await dashboard.getDashboardCashflow(ctx.user.id, ctx.profile.id, "daily");

    const last = points.at(-1)!;
    expect(last.date).toBe(MANILA_TODAY);
    expect(last.expenses).toBe(900);
    // And nothing was dropped off the front to make room.
    expect(points).toHaveLength(7);
    expect(points[0]!.date).toBe("2026-09-11");
  });

  it("puts this morning's expense in the current period, not outside both periods", async () => {
    await addExpenseOn(MANILA_TODAY, 400, "Manila morning");
    await addExpenseOn("2026-09-15", 100, "Two days back");

    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 2);

    // A 2-day window ending on the Manila day covers the 16th and 17th, so the
    // 400 is current and the 100 sits in the previous window rather than both
    // of them landing on the wrong side of a UTC boundary.
    expect(behavior.totals.current).toBe(400);
    expect(behavior.totals.previous).toBe(100);
  });

  it("measures a planned purchase against a baseline that includes today", async () => {
    await addExpenseOn(MANILA_TODAY, 2000);

    const impact = await insights.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 500, 30);

    expect(impact.periodExpenses.before).toBe(2000);
    expect(impact.periodEnd.toISOString().slice(0, 10)).toBe(MANILA_TODAY);
  });
});
