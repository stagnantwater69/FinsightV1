/**
 * The guided tour, offered and accepted over a real dashboard.
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
import { expect, test, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour, TEST_BUSINESS_PROFILE, TEST_PROFILE } from "./mocks";
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

/** Signs in with no stored tour state and serves a populated dashboard. */
async function openFreshDashboard(page: Page) {
  // No stored tour state: this account has never toured, so it is offered.
  await page.addInitScript((id) => {
    window.localStorage.removeItem(`finsight.tour.${id}`);
  }, TEST_PROFILE.id);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);

  await page.route("**/api/**/dashboard/summary**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUMMARY) }),
  );
  await page.route("**/api/**/insights/expense-overview**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      view: "dashboard",
      comparison: {
        status: "available",
        data: { totals: EMPTY_BEHAVIOR.totals, categoryTrends: EMPTY_BEHAVIOR.categoryTrends },
      },
      topOpportunity: { status: "available", data: null },
    }) }),
  );

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Show me around" }).click({ timeout: 15000 });
}

test("the tour starts over the dashboard without looping the app into the error boundary", async ({ page }) => {
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

  await openFreshDashboard(page);

  // The tour's first card is a centered welcome, and the dashboard behind it
  // still rendered — neither is true once the error boundary has taken over.
  await expect(page.getByRole("heading", { name: "Welcome to FinSight" })).toBeVisible({ timeout: 15000 });
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

test("on a phone, the tour card never covers the bottom-nav item it points at", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshDashboard(page);
  await expect(page.getByRole("heading", { name: "Welcome to FinSight" })).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Records" });
  for (let i = 0; i < 8; i++) {
    if (await page.getByRole("heading", { name: "Records", exact: true }).count()) break;
    await page.getByRole("button", { name: "Next" }).click();
    await page.waitForTimeout(400);
  }
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();

  const nav = page.locator('[data-tour="records"] >> visible=true');
  const card = await dialog.boundingBox();
  const target = await nav.boundingBox();
  expect(card && target).toBeTruthy();
  // No vertical overlap between the card and the highlighted nav item.
  expect(card!.y + card!.height <= target!.y || target!.y + target!.height <= card!.y).toBe(true);
});

test("the Tutorials page link replays the tour for a signed-in owner who already finished it", async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);

  await page.goto("/tutorials");
  await page.getByRole("link", { name: "Take the in-app tour" }).click();

  // Straight into the tour: asking would be redundant after they clicked a link to it.
  await expect(page.getByRole("heading", { name: "Welcome to FinSight" })).toBeVisible({ timeout: 20000 });
  // The parameter is dropped, so a reload does not start it over.
  await expect(page).toHaveURL(/\/dashboard$/);
});
