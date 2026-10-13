/**
 * Mocked-network E2E coverage for the dashboard's period switch and
 * recalculation.
 *
 * As with the other new specs in this directory, no real Supabase project or
 * FinSight backend is involved — every request the app makes is intercepted
 * with `page.route()` and answered with hand-written JSON shaped to
 * `web/src/lib/types.ts`. See mocks.ts for the shared session/context setup.
 */
import { expect, test } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour, TEST_BUSINESS_PROFILE } from "./mocks";
import type { DashboardSummary, ExpenseBehavior } from "../src/lib/types";

function summaryFor(period: "week" | "month" | "all"): DashboardSummary {
  // Distinct, easy-to-tell-apart totals per window so the assertions prove
  // the UI actually re-rendered with the new response rather than reusing
  // stale numbers.
  const byPeriod: Record<number, { expenses: number; sales: number }> = {
    1: { expenses: 500, sales: 1200 },
    7: { expenses: 4500, sales: 9800 },
    30: { expenses: 18000, sales: 42000 },
    0: { expenses: 210000, sales: 480000 },
  };
  const periodDays = period === "week" ? 7 : period === "all" ? 0 : 30;
  const { expenses, sales } = byPeriod[periodDays];
  return {
    periodDays,
    periodStart: "2026-07-01",
    periodEnd: "2026-08-01",
    overview: {
      availableFunds: TEST_BUSINESS_PROFILE.availableFunds,
      totalExpenses: expenses,
      totalSalesReference: sales,
    },
    expenseCategoryBreakdown: [{ categoryId: 100, categoryName: "Inventory", total: expenses, percent: 100 }],
    recoveryStatus: {
      expectedMonthlyExpenses: TEST_BUSINESS_PROFILE.expectedMonthlyExpenses,
      operatingDays: TEST_BUSINESS_PROFILE.operatingDays,
      dailyNeededTarget: 800,
      salesThisMonth: sales,
      remainingTarget: 0,
      daysInMonth: 31,
      calendarDaysLeftInMonth: 10,
      remainingOperatingDays: 8,
      remainingOperatingDaysIsApproximated: false,
      adjustedDailyTarget: 800,
      todaysTarget: 800,
      todaysSales: 800,
      todaysGap: 0,
      todaysStatus: "at",
      monthCoveragePercent: 100,
      onTrack: true,
    },
    recordsNeedingReview: 0,
    alerts: [],
    lifetime: { recordCount: 42, latestRecordDate: "2026-08-01" },
  };
}

const EMPTY_BEHAVIOR: ExpenseBehavior = {
  periodStart: "2026-07-01",
  periodEnd: "2026-08-01",
  previousPeriodStart: "2026-06-01",
  previousPeriodEnd: "2026-07-01",
  periodDays: 30,
  totals: { current: 0, previous: 0 },
  dailyTotals: [],
  categoryTrends: [],
  unusualExpenses: [],
  insufficientHistoryCategories: [],
};

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);

  await page.route("**/dashboard/summary**", async (route) => {
    const url = new URL(route.request().url());
    const period = (url.searchParams.get("period") ?? "week") as "week" | "month" | "all";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryFor(period)),
    });
  });
  await page.route("**/insights/expense-overview**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      view: "dashboard",
      comparison: {
        status: "available",
        data: { totals: EMPTY_BEHAVIOR.totals, categoryTrends: EMPTY_BEHAVIOR.categoryTrends },
      },
      topOpportunity: { status: "available", data: null },
    }) });
  });
});

test("switching the dashboard period recalculates the displayed totals", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  await expect(page.getByText("PHP 4,500").first()).toBeVisible();
  await expect(page.getByText("PHP 9,800").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "This week" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.getByText("PHP 210,000").first()).toBeVisible();
  await expect(page.getByText("PHP 480,000").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "All time" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "This week" }).click();
  await expect(page.getByText("PHP 4,500").first()).toBeVisible();
});
