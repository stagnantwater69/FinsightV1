/**
 * Mocked-browser request topology only. This does not measure production
 * latency, device performance, or a live backend connection.
 */
import { expect, test } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

test("mocked browser: warm Dashboard return reuses the scoped overview cache", async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);

  let dashboardOverviewRequests = 0;
  let detailOverviewRequests = 0;
  let dashboardSummaryRequests = 0;
  let dashboardFeedRequests = 0;
  let recordListRequests = 0;
  let legacyCoreRequests = 0;

  await page.route("**/records/months**", (route) => route.fulfill({ json: { months: ["2026-09"] } }));
  await page.route("**/records/future-dated**", (route) => route.fulfill({
    json: { expenses: [], sales: [], total: 0 },
  }));
  await page.route("**/dashboard/summary**", (route) => {
    dashboardSummaryRequests += 1;
    return route.fulfill({ json: {
      periodDays: 30,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      overview: { availableFunds: 50_000, totalExpenses: 12_000, totalSalesReference: 25_000 },
      expenseCategoryBreakdown: [{ categoryId: 100, categoryName: "Inventory", total: 12_000, percent: 100 }],
      recoveryStatus: {
        expectedMonthlyExpenses: 20_000, operatingDays: 26, dailyNeededTarget: 770,
        salesThisMonth: 25_000, remainingTarget: 0, daysInMonth: 30,
        calendarDaysLeftInMonth: 10, remainingOperatingDays: 8,
        remainingOperatingDaysIsApproximated: false, adjustedDailyTarget: 0,
        todaysTarget: 0, todaysSales: 0, todaysGap: 0, todaysStatus: "at",
        monthCoveragePercent: 100, onTrack: true,
      },
      recordsNeedingReview: 0,
      alerts: [],
      lifetime: { recordCount: 1, latestRecordDate: "2026-09-15" },
    } });
  });
  await page.route("**/insights/expense-overview**", (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    const behavior = {
      periodStart: "2026-09-01", periodEnd: "2026-09-30",
      previousPeriodStart: "2026-08-01", previousPeriodEnd: "2026-08-31", periodDays: 30,
      totals: { current: 12_000, previous: 9_000 },
      dailyTotals: [],
      categoryTrends: [{
        categoryId: 100, categoryName: "Inventory", current: 12_000, previous: 9_000,
        direction: "up", change: 3_000, percentChange: 33.3, recordCount: 4,
      }],
      unusualExpenses: [], insufficientHistoryCategories: [],
    };
    if (view === "detail") {
      detailOverviewRequests += 1;
      return route.fulfill({ json: {
        view: "detail",
        behavior: { status: "available", data: behavior },
        opportunities: { status: "available", data: {
          period: { days: 30, start: "2026-09-01", end: "2026-09-30" },
          dataQuality: { status: "sufficient", currentRecordCount: 4, previousRecordCount: 3, message: null },
          opportunities: [], detectorVersion: "e2e-fixture",
        } },
      } });
    }
    dashboardOverviewRequests += 1;
    return route.fulfill({ json: {
      view: "dashboard",
      comparison: {
        status: "available",
        data: { totals: behavior.totals, categoryTrends: behavior.categoryTrends },
      },
      topOpportunity: { status: "available", data: null },
    } });
  });
  await page.route(/\/insights\/(expense-behavior|reduction-opportunities)(?:\?|$)/, (route) => {
    legacyCoreRequests += 1;
    return route.abort("failed");
  });
  await page.route("**/records/search**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") === "6") dashboardFeedRequests += 1;
    else recordListRequests += 1;
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route("**/records/flagged/count**", (route) => route.fulfill({
    json: { expenses: 0, sales: 0, total: 0 },
  }));
  await page.route(/\/records\/flagged(?:\?|$)/, (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/insights/findings**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/insights/recurring-patterns**", (route) => route.fulfill({ json: [] }));
  await page.route("**/insights/recurring-schedules**", (route) => route.fulfill({ json: [] }));

  await loginViaUi(page);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect.poll(() => dashboardOverviewRequests).toBe(1);
  await expect.poll(() => dashboardFeedRequests).toBe(1);

  await page.getByRole("link", { name: "Records", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();
  await expect.poll(() => recordListRequests).toBe(1);

  await page.getByRole("button", { name: "Insights", exact: true }).click();
  await page.getByRole("link", { name: "Expense insight", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Expense insight", exact: true })).toBeVisible();
  await expect.poll(() => detailOverviewRequests).toBe(1);
  await expect(
    page.getByText("Composed from your records, not AI-written", { exact: true }),
  ).toBeVisible();
  for (const emptyPanelTitle of [
    "Reduction opportunities",
    "Large expense flags",
    "Unusual expenses",
    "Findings to review",
  ]) {
    await expect(page.getByRole("heading", { name: emptyPanelTitle, exact: true })).toHaveCount(0);
  }
  const reviewSection = page.locator("#expense-review");
  await expect(reviewSection.locator(":scope > *")).toHaveCount(1);
  const [reviewBox, summaryBox] = await Promise.all([
    reviewSection.boundingBox(),
    reviewSection.locator(":scope > *").boundingBox(),
  ]);
  expect(reviewBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(Math.abs(reviewBox!.width - summaryBox!.width)).toBeLessThanOrEqual(2);

  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  expect(dashboardOverviewRequests).toBe(1);
  expect(detailOverviewRequests).toBe(1);
  expect(dashboardSummaryRequests).toBe(1);
  expect(dashboardFeedRequests).toBe(1);
  expect(recordListRequests).toBe(1);
  expect(legacyCoreRequests).toBe(0);
});
