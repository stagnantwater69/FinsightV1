import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { ALL_TIME_PERIOD, getDashboardCashflow, getDashboardSummary } from "../../src/services/dashboard.service";
import { Z_SCORE_THRESHOLD } from "../../src/services/analysis.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

// Dashboard and Insights computed from real rows in a real database. This is
// where the UTC date-boundary regression lives: records dated TODAY were being
// excluded from every period-scoped query on any server not running in UTC.

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  // EME 125,000 over 25 operating days -> daily needed target exactly 5,000.
  ctx = await makeOwnerWithProfile(
    { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
    ["Inventory", "Utilities", "Transportation"]
  );
});

afterAll(disconnectDb);

async function addExpense(category: string, description: string, amount: number, dayOffset: number) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories[category]!,
    date: utcDayString(dayOffset),
    description,
    amount,
  });
}

async function addSale(amount: number, dayOffset: number, description = "Daily sales") {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: utcDayString(dayOffset),
    description,
    amount,
  });
}

describe("REGRESSION: records dated today must be included", () => {
  it("counts an expense dated today in the dashboard totals", async () => {
    await addExpense("Inventory", "Recorded today", 1234, 0);
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(summary.overview.totalExpenses).toBe(1234);
  });

  it("counts a sale dated today in the dashboard totals", async () => {
    await addSale(4500, 0);
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(summary.overview.totalSalesReference).toBe(4500);
  });

  it("counts today's records even in a single-day period", async () => {
    await addExpense("Inventory", "Today only", 500, 0);
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 1);
    expect(summary.overview.totalExpenses).toBe(500);
  });

  it("counts today's sale in the recovery tracker's month-to-date figures", async () => {
    await addSale(4500, 0);
    const recovery = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(recovery.todaysSales).toBe(4500);
    expect(recovery.salesThisMonth).toBeGreaterThanOrEqual(4500);
  });

  it("counts today's expense in expense-behaviour category trends", async () => {
    await addExpense("Inventory", "Today", 2000, 0);
    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    const inventory = behavior.categoryTrends.find((t) => t.categoryName === "Inventory");
    expect(inventory?.current).toBe(2000);
  });

  it("excludes a record dated tomorrow", async () => {
    await addExpense("Inventory", "Future dated", 777, 1);
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(summary.overview.totalExpenses).toBe(0);
  });
});

describe("dashboard period scoping", () => {
  beforeEach(async () => {
    await addExpense("Inventory", "Today", 100, 0);
    await addExpense("Inventory", "Three days ago", 200, -3);
    await addExpense("Inventory", "Twenty days ago", 400, -20);
    await addExpense("Inventory", "Ninety days ago", 800, -90);
  });

  it("a 1-day period sees only today", async () => {
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 1);
    expect(s.overview.totalExpenses).toBe(100);
  });

  it("a 7-day period sees today and three days ago", async () => {
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 7);
    expect(s.overview.totalExpenses).toBe(300);
  });

  it("a 30-day period sees everything except the 90-day-old record", async () => {
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(s.overview.totalExpenses).toBe(700);
  });
});

describe("category breakdown", () => {
  it("aggregates per category and computes shares that sum to 100%", async () => {
    await addExpense("Inventory", "Stock", 6000, -1);
    await addExpense("Inventory", "More stock", 2000, -2);
    await addExpense("Utilities", "Electric", 2000, -1);

    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(s.overview.totalExpenses).toBe(10000);

    const inventory = s.expenseCategoryBreakdown.find((c) => c.categoryName === "Inventory");
    const utilities = s.expenseCategoryBreakdown.find((c) => c.categoryName === "Utilities");
    expect(inventory?.total).toBe(8000);
    expect(inventory?.percent).toBeCloseTo(80, 6);
    expect(utilities?.total).toBe(2000);
    expect(utilities?.percent).toBeCloseTo(20, 6);

    const sum = s.expenseCategoryBreakdown.reduce((acc, c) => acc + c.percent, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it("is sorted largest first", async () => {
    await addExpense("Utilities", "Electric", 1000, -1);
    await addExpense("Inventory", "Stock", 9000, -1);
    await addExpense("Transportation", "Fuel", 5000, -1);

    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    const totals = s.expenseCategoryBreakdown.map((c) => c.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it("returns no breakdown rows and no NaN when there are no expenses", async () => {
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(s.expenseCategoryBreakdown).toEqual([]);
    expect(s.overview.totalExpenses).toBe(0);
  });
});

describe("dashboard and insights agree on recovery", () => {
  it("returns identical recovery figures from both entry points", async () => {
    await addSale(4500, 0);
    await addSale(9000, -2);

    const dash = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    const ins = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    // Same canonical computation, so every shared field must match exactly.
    for (const key of [
      "dailyNeededTarget",
      "salesThisMonth",
      "remainingTarget",
      "remainingOperatingDays",
      "adjustedDailyTarget",
      "todaysTarget",
      "todaysSales",
      "todaysGap",
      "todaysStatus",
      "monthCoveragePercent",
      "onTrack",
    ] as const) {
      expect(dash.recoveryStatus[key], key).toEqual(ins[key]);
    }
  });

  it("gives the same recovery figures regardless of the dashboard period selected", async () => {
    await addSale(4500, 0);
    const [a, b, c] = await Promise.all([
      getDashboardSummary(ctx.user.id, ctx.profile.id, 1),
      getDashboardSummary(ctx.user.id, ctx.profile.id, 7),
      getDashboardSummary(ctx.user.id, ctx.profile.id, 30),
    ]);
    // Recovery is month-to-date by definition, so the period selector must not
    // move it.
    expect(a.recoveryStatus).toEqual(b.recoveryStatus);
    expect(b.recoveryStatus).toEqual(c.recoveryStatus);
  });

  it("computes the daily needed target as EME / operating days", async () => {
    const ins = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(ins.dailyNeededTarget).toBe(5000);
  });
});

describe("unusual-expense detection against real rows", () => {
  it("flags the planted outlier and nothing else", async () => {
    // The Insights fixture: seven ordinary restocks plus one bulk delivery.
    // Seven, not four, because detection needs MIN_HISTORY_FOR_DETECTION (8)
    // records in the category before it will score anything.
    await addExpense("Inventory", "Supplier stocks", 6000, -2);
    await addExpense("Inventory", "Supplier stocks B", 5800, -5);
    await addExpense("Inventory", "Supplier stocks C", 6200, -8);
    await addExpense("Inventory", "Supplier stocks D", 5500, -11);
    await addExpense("Inventory", "Supplier stocks E", 5900, -13);
    await addExpense("Inventory", "Supplier stocks F", 6100, -15);
    await addExpense("Inventory", "Supplier stocks G", 5700, -17);
    await addExpense("Inventory", "Bulk rice delivery", 30000, -3);

    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);

    expect(behavior.unusualExpenses).toHaveLength(1);
    expect(behavior.unusualExpenses[0]!.description).toBe("Bulk rice delivery");
    expect(behavior.unusualExpenses[0]!.amount).toBe(30000);
    expect(Math.abs(behavior.unusualExpenses[0]!.zScore)).toBeGreaterThan(Z_SCORE_THRESHOLD);
    // The baseline excludes the candidate, so the reported mean is the mean of
    // the four ordinary restocks, not of all five records.
    expect(behavior.unusualExpenses[0]!.categoryMean).toBeCloseTo(5885.71, 2);
  });

  it("reports insufficient history rather than guessing below the minimum", async () => {
    await addExpense("Utilities", "Electric", 4200, -1);
    await addExpense("Utilities", "Water", 1300, -2);

    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    const utilities = behavior.insufficientHistoryCategories.find((c) => c.categoryName === "Utilities");
    expect(utilities).toBeDefined();
    expect(utilities!.historyCount).toBe(2);
    expect(behavior.unusualExpenses).toHaveLength(0);
  });

  it("only flags records inside the selected period, but uses recent history outside that period", async () => {
    // History sits outside the 7-day window; the outlier sits inside it.
    await addExpense("Inventory", "Old stock A", 6000, -40);
    await addExpense("Inventory", "Old stock B", 5800, -41);
    await addExpense("Inventory", "Old stock C", 6200, -42);
    await addExpense("Inventory", "Old stock D", 5500, -43);
    await addExpense("Inventory", "Old stock E", 5900, -44);
    await addExpense("Inventory", "Old stock F", 6100, -45);
    await addExpense("Inventory", "Old stock G", 5700, -46);
    await addExpense("Inventory", "Recent bulk delivery", 30000, -1);

    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 7);
    // Detected, because the rolling baseline is wider than the selected 7-day view.
    expect(behavior.unusualExpenses.map((u) => u.description)).toEqual(["Recent bulk delivery"]);
  });

  it("does not let records older than the annual baseline influence detection", async () => {
    for (let i = 0; i < 7; i++) {
      await addExpense("Inventory", `Obsolete price ${i}`, 500 + i * 10, -400 - i);
    }
    await addExpense("Inventory", "Current purchase", 6000, -1);

    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    expect(behavior.unusualExpenses).toHaveLength(0);
    expect(behavior.insufficientHistoryCategories).toContainEqual({
      categoryId: ctx.categories.Inventory,
      categoryName: "Inventory",
      historyCount: 1,
    });
  });

  it("computes period-over-period category trends", async () => {
    await addExpense("Inventory", "This period", 9000, -5);
    await addExpense("Inventory", "Previous period", 3000, -35);

    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    const inventory = behavior.categoryTrends.find((t) => t.categoryName === "Inventory")!;
    expect(inventory.current).toBe(9000);
    expect(inventory.previous).toBe(3000);
    expect(inventory.direction).toBe("up");
    expect(inventory.percentChange).toBeCloseTo(200, 6);
  });

  it("reports a null percent change for brand-new spending rather than a fake 0%", async () => {
    await addExpense("Inventory", "Brand new category spend", 5000, -1);
    const behavior = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    const inventory = behavior.categoryTrends.find((t) => t.categoryName === "Inventory")!;
    expect(inventory.previous).toBe(0);
    expect(inventory.percentChange).toBeNull();
  });
});

describe("spending impact against real rows", () => {
  it("computes before/after funds and period expenses", async () => {
    await addExpense("Inventory", "Existing spend", 10000, -1);

    const impact = await insights.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 11000, 30);
    expect(impact.funds.before).toBe(48500);
    expect(impact.funds.after).toBe(37500);
    expect(impact.periodExpenses.before).toBe(10000);
    expect(impact.periodExpenses.after).toBe(21000);
    expect(impact.percentOfFunds).toBeCloseTo(22.68, 2);
    expect(impact.impactBand).toBe("Noticeable Impact");
    expect(impact.exceedsFunds).toBe(false);
  });

  it("uses available funds — not expected monthly expenses — as the banding base", async () => {
    // 20,000 is 41% of the 48,500 available funds (High), but only 16% of the
    // 125,000 expected monthly expenses (which would be Noticeable).
    const impact = await insights.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 20000, 30);
    expect(impact.impactBand).toBe("High Impact");
    expect(impact.thresholdAmount).toBe(48500 * 0.25);
  });

  it("reports exceeding funds and a negative remainder", async () => {
    const impact = await insights.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 60000, 30);
    expect(impact.exceedsFunds).toBe(true);
    expect(impact.funds.after).toBe(-11500);
    expect(impact.impactBand).toBe("High Impact");
  });

  it("saves nothing — it is a what-if only", async () => {
    await insights.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 11000, 30);
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(s.overview.totalExpenses).toBe(0);
    expect(s.overview.availableFunds).toBe(48500);
  });
});

describe("dashboard cashflow — daily", () => {
  it("defaults to daily and returns one zero-filled row per day, even with no records", async () => {
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id);
    expect(cf.granularity).toBe("daily");
    expect(cf.points).toHaveLength(7);
    expect(cf.points.every((d) => d.sales === 0 && d.expenses === 0)).toBe(true);
  });

  it("buckets a sale and an expense dated today into today's row", async () => {
    await addSale(4500, 0);
    await addExpense("Inventory", "Today", 1200, 0);
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "daily");
    const today = cf.points[cf.points.length - 1]!;
    expect(today.sales).toBe(4500);
    expect(today.expenses).toBe(1200);
  });

  it("sums multiple records that land on the same day", async () => {
    await addExpense("Inventory", "Morning", 500, -2);
    await addExpense("Utilities", "Afternoon", 300, -2);
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "daily");
    const threeDaysAgoRow = cf.points[cf.points.length - 3]!;
    expect(threeDaysAgoRow.expenses).toBe(800);
  });

  it("excludes records outside the 7-day window", async () => {
    await addExpense("Inventory", "Ninety days ago", 800, -90);
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "daily");
    expect(cf.points.reduce((s, d) => s + d.expenses, 0)).toBe(0);
  });

  it("rows are in chronological order, oldest first", async () => {
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "daily");
    const dates = cf.points.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("dashboard cashflow — monthly", () => {
  it("returns one zero-filled row per month, even with no records", async () => {
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "monthly");
    expect(cf.granularity).toBe("monthly");
    expect(cf.points).toHaveLength(6);
    expect(cf.points.every((d) => d.sales === 0 && d.expenses === 0)).toBe(true);
  });

  it("buckets a sale and an expense dated today into the current month's row", async () => {
    await addSale(9000, 0);
    await addExpense("Inventory", "This month", 3000, 0);
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "monthly");
    const currentMonth = cf.points[cf.points.length - 1]!;
    expect(currentMonth.sales).toBe(9000);
    expect(currentMonth.expenses).toBe(3000);
  });

  it("excludes a record from eight months ago", async () => {
    await addExpense("Inventory", "Long ago", 5000, -240);
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "monthly");
    expect(cf.points.reduce((s, d) => s + d.expenses, 0)).toBe(0);
  });

  it("rows are in chronological order, oldest first", async () => {
    const cf = await getDashboardCashflow(ctx.user.id, ctx.profile.id, "monthly");
    const dates = cf.points.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("records needing review", () => {
  it("counts both flagged duplicates and large expenses", async () => {
    // 31,250+ is over 25% of 125,000 -> large expense -> Needs Review.
    await addExpense("Inventory", "Big one", 40000, -1);
    // An exact repeat -> flagged duplicate.
    await addExpense("Utilities", "Electric", 1000, -1);
    await addExpense("Utilities", "Electric", 1000, -1);

    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(s.recordsNeedingReview).toBe(2);
  });

  it("surfaces alerts for this business profile", async () => {
    await addExpense("Inventory", "Big one", 40000, -1);
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(s.alerts.length).toBeGreaterThan(0);
    expect(s.alerts.every((a) => a.businessProfileId === ctx.profile.id)).toBe(true);
  });
});

/**
 * The dashboard answers TWO different questions and must not use one set of
 * numbers for both.
 *
 * "What happened lately" is period-scoped and always has been. "Has this
 * business ever recorded anything" is not, and was being answered with the
 * period figures — so an owner who imported two years of history onto a
 * dashboard showing "This month" was told, by the setup checklist, that they
 * had not yet recorded their first expense or sale. Their 21,097 records were
 * all there; none of them fell inside 30 days.
 *
 * That is the worst available failure for an import feature: the data is fine
 * and the app says it is missing.
 */
describe("lifetime totals are reported outside the period", () => {
  it("counts records the period cannot see", async () => {
    // Well outside any period selector the dashboard offers.
    await addExpense("Inventory", "Old stock purchase", 1200, -400);
    await addSale(3000, -395);

    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);

    // The period is genuinely empty — that part was never wrong.
    expect(summary.overview.totalExpenses).toBe(0);
    expect(summary.overview.totalSalesReference).toBe(0);

    // But the business is not, and this is what the checklist reads.
    expect(summary.lifetime.recordCount).toBe(2);
  });

  it("reports the most recent record's date, so the page can say where the data is", async () => {
    await addExpense("Inventory", "Older", 500, -400);
    await addSale(900, -350);

    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);

    expect(summary.lifetime.latestRecordDate).not.toBeNull();
    expect(summary.lifetime.latestRecordDate!.toISOString().slice(0, 10)).toBe(utcDayString(-350));
  });

  it("takes the later of the two record types", async () => {
    await addExpense("Inventory", "Expense is newer", 500, -100);
    await addSale(900, -200);

    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 1);
    expect(summary.lifetime.latestRecordDate!.toISOString().slice(0, 10)).toBe(utcDayString(-100));
  });

  it("says nothing at all for a business that has genuinely never recorded", async () => {
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(summary.lifetime.recordCount).toBe(0);
    expect(summary.lifetime.latestRecordDate).toBeNull();
  });

  /** Scoped to the business, not the owner — the count must not leak across profiles. */
  it("counts only this business profile's records", async () => {
    const other = await makeOwnerWithProfile();
    await expenses.createExpenseRecord(other.user.id, {
      businessProfileId: other.profile.id,
      categoryId: other.categories.Inventory!,
      date: utcDayString(-300),
      description: "Someone else's record",
      amount: 999,
    });

    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(summary.lifetime.recordCount).toBe(0);
  });
});

/**
 * "All time" — the period that has no lower bound.
 *
 * It exists because every other setting is a lookback window of a month or
 * less, while CSV import invites owners to bring in years of history. Without
 * it a business whose records end more than 30 days ago has no setting that can
 * see a single one of them, which is what a real 21,097-row import of 2023-2025
 * data ran into.
 */
describe("the all-time period", () => {
  it("includes records far outside every other period", async () => {
    await addExpense("Inventory", "Two years ago", 1200, -700);
    await addSale(4000, -700);

    const month = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(month.overview.totalExpenses).toBe(0);
    expect(month.overview.totalSalesReference).toBe(0);

    const allTime = await getDashboardSummary(ctx.user.id, ctx.profile.id, ALL_TIME_PERIOD);
    expect(allTime.overview.totalExpenses).toBe(1200);
    expect(allTime.overview.totalSalesReference).toBe(4000);
  });

  it("builds the category breakdown across the whole history", async () => {
    await addExpense("Inventory", "Old stock", 1000, -700);
    await addExpense("Utilities", "Old power", 500, -365);
    await addExpense("Inventory", "Recent stock", 500, -2);

    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, ALL_TIME_PERIOD);

    expect(s.overview.totalExpenses).toBe(2000);
    const inventory = s.expenseCategoryBreakdown.find((c) => c.categoryName === "Inventory");
    expect(inventory?.total).toBe(1500);
    expect(inventory?.percent).toBeCloseTo(75);
    // Sorted by size, like every other period.
    expect(s.expenseCategoryBreakdown[0]!.categoryName).toBe("Inventory");
  });

  /**
   * A spreadsheet can legitimately carry a future date, and an owner who
   * imported one must be able to find it. This is why "all time" drops the
   * filter rather than widening the lower bound and keeping `lte: today`.
   */
  it("includes future-dated records, which the bounded periods exclude", async () => {
    await addExpense("Inventory", "Dated ahead", 300, 5);

    const month = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);
    expect(month.overview.totalExpenses).toBe(0);

    const allTime = await getDashboardSummary(ctx.user.id, ctx.profile.id, ALL_TIME_PERIOD);
    expect(allTime.overview.totalExpenses).toBe(300);
  });

  it("reports the span it actually covers, so the page can say so", async () => {
    await addExpense("Inventory", "First ever", 100, -500);
    await addSale(200, -10);

    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, ALL_TIME_PERIOD);
    expect(s.periodStart?.toISOString().slice(0, 10)).toBe(utcDayString(-500));
  });

  it("stays scoped to the one business profile", async () => {
    const other = await makeOwnerWithProfile();
    await expenses.createExpenseRecord(other.user.id, {
      businessProfileId: other.profile.id,
      categoryId: other.categories.Inventory!,
      date: utcDayString(-700),
      description: "Someone else's history",
      amount: 9999,
    });
    await addExpense("Inventory", "Mine", 100, -700);

    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, ALL_TIME_PERIOD);
    expect(s.overview.totalExpenses).toBe(100);
  });

  it("is empty, not broken, for a business with no records at all", async () => {
    const s = await getDashboardSummary(ctx.user.id, ctx.profile.id, ALL_TIME_PERIOD);
    expect(s.overview.totalExpenses).toBe(0);
    expect(s.expenseCategoryBreakdown).toEqual([]);
    expect(s.periodStart).toBeNull();
  });
});

/**
 * Anchoring an insight window somewhere other than today.
 *
 * WHY THIS EXISTS. Every window on the Expense Insight page is measured back
 * from today, which is right for a business recording daily and useless for one
 * whose history was imported — CSV import will happily accept two years ending
 * a year ago, and then every window the page offers lands in a gap. The page
 * then reports "no expenses recorded" and invites the owner to import a
 * spreadsheet, which is the app contradicting something they just did.
 *
 * `endDate` moves the window to where the records are. It is also the primitive
 * a custom date range would need, so it is not throwaway.
 */
describe("insight windows can be anchored to a past date", () => {
  it("reads the window ending on the given date, not on today", async () => {
    // Two years back — outside every window the page offers by default.
    await addExpense("Inventory", "Old stock", 1200, -700);

    const today = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    expect(today.totals.current).toBe(0);

    const anchored = await insights.getExpenseBehavior(
      ctx.user.id,
      ctx.profile.id,
      30,
      new Date(`${utcDayString(-700)}T00:00:00.000Z`),
    );
    expect(anchored.totals.current).toBe(1200);
    expect(anchored.periodEnd.toISOString().slice(0, 10)).toBe(utcDayString(-700));
  });

  /** The comparison is the point of the page, so it has to move with the window. */
  it("compares against the period before the anchor, not before today", async () => {
    await addExpense("Inventory", "Anchor month", 1000, -400);
    await addExpense("Inventory", "Month before that", 600, -430);

    const anchored = await insights.getExpenseBehavior(
      ctx.user.id,
      ctx.profile.id,
      30,
      new Date(`${utcDayString(-400)}T00:00:00.000Z`),
    );
    expect(anchored.totals.current).toBe(1000);
    expect(anchored.totals.previous).toBe(600);
  });

  it("defaults to today when no anchor is given", async () => {
    await addExpense("Inventory", "Recent", 300, -1);
    const result = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    expect(result.totals.current).toBe(300);
    expect(result.periodEnd.toISOString().slice(0, 10)).toBe(utcDayString(0));
  });

  /**
   * The field that lets an empty window tell "you have never recorded an
   * expense" apart from "you have plenty, none of it lately". Those produced an
   * identical screen and identical, opposite-of-useful advice.
   */
  it("reports the latest expense date regardless of the window", async () => {
    await addExpense("Inventory", "Old stock", 1200, -700);

    const result = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    expect(result.totals.current).toBe(0);
    expect(result.latestExpenseDate?.toISOString().slice(0, 10)).toBe(utcDayString(-700));
  });

  it("reports no latest expense for a business that has never recorded one", async () => {
    const result = await insights.getExpenseBehavior(ctx.user.id, ctx.profile.id, 30);
    expect(result.latestExpenseDate).toBeNull();
  });
});

/**
 * Recovery is month-to-date and has no period to select, so a business whose
 * records stop months ago is shown zero sales against its full monthly target —
 * "you are catastrophically behind", for a month it never traded in. The
 * arithmetic is right and the framing was missing; these two fields are what
 * let the page say so.
 */
describe("recovery reports an empty month rather than implying a missed target", () => {
  it("flags a month with no sales at all", async () => {
    await addSale(5000, -400); // long before this month

    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 31);
    expect(result.monthHasNoRecords).toBe(true);
    expect(result.latestSaleDate?.toISOString().slice(0, 10)).toBe(utcDayString(-400));
    // The targets themselves are untouched — it is the framing that was added.
    expect(result.salesThisMonth).toBe(0);
  });

  it("does not flag a month that has sales in it", async () => {
    await addSale(5000, 0);
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 31);
    expect(result.monthHasNoRecords).toBe(false);
  });
});
