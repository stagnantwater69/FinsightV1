import { describe, expect, it } from "vitest";
import { dateLine, greetingFor, pickHeadline } from "./homeInsight";
import type { DashboardSummary, RecoveryTargets } from "./types";

/**
 * These guard the branch ORDER as much as the wording. `pickHeadline` is
 * duplicated in mobile/src/lib/homeInsight.ts on purpose (both clients must put
 * the same sentence in Fin's mouth), and the failure mode of a port is a branch
 * that silently ranks differently — a business with records needing review
 * being told about its biggest cost category instead. That is invisible in a
 * diff and only shows up in front of an owner, so it is pinned here.
 */

function recovery(over: Partial<RecoveryTargets> = {}): RecoveryTargets {
  return {
    expectedMonthlyExpenses: 30000,
    operatingDays: 26,
    dailyNeededTarget: 1154,
    salesThisMonth: 10000,
    remainingTarget: 20000,
    daysInMonth: 30,
    calendarDaysLeftInMonth: 10,
    remainingOperatingDays: 10,
    remainingOperatingDaysIsApproximated: false,
    adjustedDailyTarget: 2000,
    todaysTarget: 2000,
    todaysSales: 0,
    todaysGap: 2000,
    todaysStatus: "below",
    monthCoveragePercent: 33,
    ...over,
  } as RecoveryTargets;
}

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    periodDays: 30,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    overview: { availableFunds: 5000, totalExpenses: 10000, totalSalesReference: 8000 },
    expenseCategoryBreakdown: [],
    recoveryStatus: recovery(),
    recordsNeedingReview: 0,
    alerts: [],
    ...over,
  } as DashboardSummary;
}

describe("pickHeadline", () => {
  it("puts records needing review first, ahead of every informational branch", () => {
    // Recovery gap AND a top category are both present and both would produce
    // a sentence; the review count has to win anyway, because it is the only
    // one with a next step attached.
    const h = pickHeadline(
      summary({
        recordsNeedingReview: 3,
        expenseCategoryBreakdown: [
          { categoryId: 1, categoryName: "Rent", total: 9000, percent: 90 },
        ],
      }),
    );
    expect(h).toEqual({ text: "You have 3 records waiting for a second look.", tone: "warn" });
  });

  it("says 'record' not 'records' for exactly one", () => {
    const h = pickHeadline(summary({ recordsNeedingReview: 1 }));
    expect(h?.text).toBe("You have 1 record waiting for a second look.");
  });

  it("reports the remaining target and a per-day figure when the month is short", () => {
    const h = pickHeadline(
      summary({ recoveryStatus: recovery({ remainingTarget: 20000, remainingOperatingDays: 10 }) }),
    );
    expect(h?.tone).toBe("plain");
    expect(h?.text).toContain("PHP 20,000");
    expect(h?.text).toContain("PHP 2,000");
  });

  it("congratulates once the month is covered", () => {
    const h = pickHeadline(summary({ recoveryStatus: recovery({ remainingTarget: 0 }) }));
    expect(h?.text).toBe("This month's expenses are already covered — nice work!");
  });

  it("falls back to the biggest cost category with its share", () => {
    // remainingTarget > 0 but no operating days left, so the recovery branch
    // cannot fire and the category branch is what remains.
    const h = pickHeadline(
      summary({
        recoveryStatus: recovery({ remainingTarget: 5000, remainingOperatingDays: 0 }),
        overview: { availableFunds: 0, totalExpenses: 10000, totalSalesReference: 0 },
        expenseCategoryBreakdown: [
          { categoryId: 1, categoryName: "Supplies", total: 2500, percent: 25 },
          { categoryId: 2, categoryName: "Rent", total: 7500, percent: 75 },
        ],
      }),
    );
    expect(h?.text).toBe("Rent is your biggest cost so far, at 75% of what you've spent.");
  });

  it("prompts for a first record when nothing has been spent", () => {
    const h = pickHeadline(
      summary({
        recoveryStatus: recovery({ remainingTarget: 5000, remainingOperatingDays: 0 }),
        overview: { availableFunds: 0, totalExpenses: 0, totalSalesReference: 0 },
      }),
    );
    expect(h?.text).toBe("Nothing's been recorded yet this period — add your first expense or sale.");
  });
});

describe("greetingFor", () => {
  it.each([
    [5, "Good morning"],
    [11, "Good morning"],
    [12, "Good afternoon"],
    [17, "Good afternoon"],
    [18, "Good evening"],
    [23, "Good evening"],
    // Before 5am falls through to evening rather than to a fourth greeting —
    // matching mobile, where the same three cover the clock.
    [0, "Good evening"],
    [4, "Good evening"],
  ])("hour %i reads %s", (hour, expected) => {
    expect(greetingFor(hour)).toBe(expected);
  });
});

describe("dateLine", () => {
  it("spells out the weekday and month", () => {
    // Constructed in local time so the weekday cannot shift with the runner's
    // timezone the way a "2026-01-15" string date would.
    const line = dateLine(new Date(2026, 0, 15));
    expect(line).toContain("Thursday");
    expect(line).toContain("January");
    expect(line).toContain("15");
  });
});
