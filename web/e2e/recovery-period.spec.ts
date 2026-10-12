import { expect, test, type Page } from "@playwright/test";
import type { RecoveryInsight } from "../src/lib/types";
import {
  loginViaUi,
  mockBackendSession,
  mockSupabaseAuth,
  skipTour,
} from "./mocks";

function recoveryFor(period: "week" | "month", month = "2026-10"): RecoveryInsight {
  const isWeek = period === "week";
  const historical = !isWeek && month === "2026-09";
  const start = isWeek ? "2026-09-28" : `${month}-01`;
  const end = isWeek ? "2026-10-04" : historical ? "2026-09-30" : "2026-10-31";
  const target = isWeek ? 5_000 : 20_000;
  const sales = isWeek ? 2_400 : historical ? 21_000 : 10_000;

  return {
    expectedMonthlyExpenses: 20_000,
    operatingDays: 26,
    dailyNeededTarget: 769.23,
    salesThisMonth: sales,
    remainingTarget: Math.max(target - sales, 0),
    daysInMonth: historical ? 30 : 31,
    calendarDaysLeftInMonth: historical ? 0 : 30,
    remainingOperatingDays: historical ? 0 : isWeek ? 3 : 20,
    remainingOperatingDaysIsApproximated: false,
    adjustedDailyTarget: historical ? 0 : isWeek ? 866.67 : 500,
    todaysTarget: 769.23,
    todaysSales: 500,
    todaysGap: -269.23,
    todaysStatus: "below",
    monthCoveragePercent: (sales / target) * 100,
    onTrack: historical,
    status: historical ? "covered" : "behind",
    monthStart: `${month}-01T00:00:00.000Z`,
    today: "2026-10-01T00:00:00.000Z",
    asOfDate: historical ? end : "2026-10-01",
    timezone: "Asia/Manila",
    coverageDays: 31,
    dailyCoverage: [],
    weeklyCheckpoints: [],
    changeSincePreviousDay: null,
    reportingPeriod: {
      kind: period,
      month: isWeek ? null : month,
      start,
      end,
      asOfDate: historical ? end : "2026-10-01",
      timezone: "Asia/Manila",
      isCurrent: !historical,
      isComplete: historical,
      targetBasis: isWeek ? "prorated_monthly_expenses" : "monthly_expenses",
      target,
      sales,
      confirmedSales: sales,
      provisionalSales: 0,
      remainingTarget: Math.max(target - sales, 0),
      coveragePercent: (sales / target) * 100,
      dailyTarget: 769.23,
      adjustedDailyTarget: historical ? null : isWeek ? 866.67 : 500,
      operatingDays: isWeek ? 5.9 : 26,
      elapsedOperatingDays: historical ? 26 : isWeek ? 2.3 : 1,
      remainingOperatingDays: historical ? 0 : isWeek ? 3.6 : 25,
      operatingScheduleConfigured: !isWeek,
      operatingDaysIsApproximated: isWeek,
      expectedSalesToDate: isWeek ? 1_538.46 : historical ? 20_000 : 769.23,
      paceVarianceAmount: isWeek ? 861.54 : historical ? 1_000 : 9_230.77,
      status: historical ? "covered" : "behind",
      confidence: "strong",
      recordCount: 1,
      dataWarnings: [],
    },
  };
}

async function horizontalScroll(page: Page): Promise<number> {
  return page.evaluate(() => {
    window.scrollTo(5_000, 0);
    const offset = window.scrollX;
    window.scrollTo(0, 0);
    return offset;
  });
}

test("Recovery Target switches between its supported periods at narrow width", async ({
  page,
}) => {
  const recoveryRequests: string[] = [];

  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await page.route("**/records/months**", (route) =>
    route.fulfill({ json: { months: ["2026-10", "2026-09"] } }),
  );
  await page.route("**/business-profiles/10/recovery-plans**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/insights/recovery**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/insights/recovery")) return route.fallback();

    recoveryRequests.push(url.search);
    const period = url.searchParams.get("period") === "week" ? "week" : "month";
    const month = url.searchParams.get("month") ?? "2026-10";
    await route.fulfill({ json: recoveryFor(period, month) });
  });

  await loginViaUi(page);
  await page.goto("/insights/recovery");

  await expect(page.getByText("Month-to-date pace", { exact: true })).toBeVisible();
  await expect(page.getByText("View last month's summary", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Manage notifications", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All time" })).toHaveCount(0);
  await expect.poll(() => recoveryRequests.at(-1)).toContain(
    "period=month&month=2026-10",
  );
  expect(await horizontalScroll(page)).toBe(0);

  await page.setViewportSize({ width: 320, height: 900 });

  await page.getByRole("button", { name: "This week" }).click();
  await expect(page.getByText("This week's pace", { exact: true })).toBeVisible();
  await expect.poll(() => recoveryRequests.at(-1)).toContain("period=week");

  await page.getByRole("combobox", { name: "Month" }).selectOption("2026-09");
  await expect(page.getByText("September 2026 result", { exact: true })).toBeVisible();
  await expect.poll(() => recoveryRequests.at(-1)).toContain(
    "period=month&month=2026-09",
  );
  expect(await horizontalScroll(page)).toBe(0);
});
