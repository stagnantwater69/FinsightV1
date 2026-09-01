/**
 * The guided tour, auto-started over a real dashboard.
 *
 * REGRESSION GUARD. This combination — a fresh account, the dashboard, the
 * tour starting by itself — used to crash the whole app into the error
 * boundary with "Maximum update depth exceeded". The tour's progress write
 * went through AuthContext's `updatePreferences`, which was a new function on
 * every render of the provider it set state on, so persisting progress
 * re-created the callback, which re-fired the effect that persists progress.
 * The error surfaced from inside the recharts panels because they were the
 * deepest thing subscribed to a store, not because charts had anything to do
 * with it — hence a dashboard carrying a category chart here.
 *
 * As with the other specs in this directory, no real backend or Supabase
 * project is involved; see mocks.ts.
 */
import { expect, test } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, TEST_BUSINESS_PROFILE, TEST_PROFILE } from "./mocks";
import type { DashboardSummary, ExpenseBehavior } from "../src/lib/types";

const CATEGORIES = ["Transportation", "Inventory", "Utilities", "Rent", "Supplies", "Salaries", "Marketing"];

const SUMMARY: DashboardSummary = {
  periodDays: 30,
  periodStart: "2026-07-01",
  periodEnd: "2026-08-01",
  overview: {
    availableFunds: TEST_BUSINESS_PROFILE.availableFunds,
    totalExpenses: 18000,
    totalSalesReference: 42000,
  },
  expenseCategoryBreakdown: CATEGORIES.map((categoryName, i) => ({
    categoryId: 100 + i,
    categoryName,
    total: (CATEGORIES.length - i) * 1000,
    percent: 100 / CATEGORIES.length,
  })),
  recoveryStatus: {
    expectedMonthlyExpenses: TEST_BUSINESS_PROFILE.expectedMonthlyExpenses,
    operatingDays: TEST_BUSINESS_PROFILE.operatingDays,
    dailyNeededTarget: 800,
    salesThisMonth: 42000,
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

test("the tour auto-starts over the dashboard without looping the app into the error boundary", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (message) => {
    // The mocked network answers with CORS-less fulfilments for anything not
    // routed here; those console entries are the harness, not the app.
    const text = message.text();
    if (message.type() === "error" && !text.includes("CORS") && !text.includes("Failed to load resource")) {
      errors.push(text);
    }
  });

  // No stored tour state: this account has never toured, so it auto-starts.
  await page.addInitScript((id) => {
    window.localStorage.removeItem(`finsight.tour.${id}`);
  }, TEST_PROFILE.id);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);

  await page.route("**/api/**/dashboard/summary**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUMMARY) }),
  );
  await page.route("**/api/**/insights/expense-behavior**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(EMPTY_BEHAVIOR) }),
  );

  await page.goto("/dashboard");

  // The tour's first card is a centered welcome, and the dashboard behind it
  // still rendered — neither is true once the error boundary has taken over.
  await expect(page.getByRole("heading", { name: "Welcome to FinSight!" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Something broke on this page")).toHaveCount(0);

  // Step through a few targeted steps: each one moves the spotlight, which is
  // where the repeated preference writes came from.
  for (let i = 0; i < 3; i++) {
    const next = page.getByRole("button", { name: "Next" }).first();
    if (!(await next.count())) break;
    await next.click();
    await page.waitForTimeout(600);
  }

  await expect(page.getByText("Something broke on this page")).toHaveCount(0);
  expect(errors.filter((e) => e.includes("Maximum update depth"))).toEqual([]);
});
