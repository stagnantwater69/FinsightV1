import { expect, test, type Page } from "@playwright/test";
import {
  loginViaUi,
  mockBackendSession,
  mockSupabaseAuth,
  skipTour,
} from "./mocks";

function expenseOverview(period: "week" | "month", month = "2026-10") {
  const isWeek = period === "week";
  const start = isWeek ? "2026-09-28" : `${month}-01`;
  const end = isWeek
    ? "2026-10-04"
    : month === "2026-10"
      ? "2026-10-31"
      : "2026-09-30";
  const previousStart = isWeek
    ? "2026-09-21"
    : month === "2026-10"
      ? "2026-09-01"
      : "2026-08-01";
  const previousEnd = isWeek
    ? "2026-09-27"
    : month === "2026-10"
      ? "2026-09-30"
      : "2026-08-31";
  const total = isWeek ? 1_200 : month === "2026-09" ? 9_000 : 10_000;

  return {
    view: "detail",
    behavior: {
      status: "available",
      data: {
        periodStart: start,
        periodEnd: end,
        previousPeriodStart: previousStart,
        previousPeriodEnd: previousEnd,
        periodDays: isWeek ? 7 : month === "2026-10" ? 31 : 30,
        period: {
          kind: period,
          month: isWeek ? null : month,
          start,
          end,
          days: isWeek ? 7 : month === "2026-10" ? 31 : 30,
          elapsedDays: isWeek ? 4 : month === "2026-10" ? 31 : 30,
          previous: { start: previousStart, end: previousEnd },
        },
        totals: { current: total, previous: total / 2 },
        dailyTotals: [{ date: start, total, count: 1 }],
        categoryTrends: [{
          categoryId: 100,
          categoryName: "Inventory",
          current: total,
          previous: total / 2,
          direction: "up",
          change: total / 2,
          percentChange: 100,
          recordCount: 1,
        }],
        unusualExpenses: [],
        insufficientHistoryCategories: [],
        latestExpenseDate: start,
      },
    },
    opportunities: {
      status: "available",
      data: {
        period: {
          days: isWeek ? 7 : month === "2026-10" ? 31 : 30,
          start,
          end,
        },
        dataQuality: {
          status: "sufficient",
          currentRecordCount: 1,
          previousRecordCount: 1,
          message: null,
        },
        opportunities: [],
        detectorVersion: "e2e-fixture",
      },
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

test("Expense Insight offers only This week and Month at narrow width", async ({
  page,
}) => {
  const overviewRequests: string[] = [];

  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await page.route("**/records/months**", (route) =>
    route.fulfill({ json: { months: ["2026-10", "2026-09"] } }),
  );
  await page.route("**/insights/expense-overview**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") !== "detail") return route.fallback();
    overviewRequests.push(url.search);
    const period = url.searchParams.get("period") === "week" ? "week" : "month";
    await route.fulfill({
      json: expenseOverview(period, url.searchParams.get("month") ?? "2026-10"),
    });
  });
  await page.route("**/records/flagged/count**", (route) =>
    route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }),
  );
  await page.route(/\/records\/flagged(?:\?|$)/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/insights/findings**", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/insights/recurring-patterns**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/insights/recurring-schedules**", (route) =>
    route.fulfill({ json: [] }),
  );

  await loginViaUi(page);
  await page.goto("/insights/expense-behavior");

  await expect(page.getByRole("heading", { name: "Expense insight", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All time" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show all time" })).toHaveCount(0);
  await expect.poll(() => overviewRequests.at(-1)).toContain(
    "period=month&month=2026-10",
  );

  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "This week" }).click();
  await expect(page.getByRole("button", { name: "This week" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => overviewRequests.at(-1)).toContain("period=week");

  for (const width of [320, 375, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("combobox", { name: "Month" }).click();
    await expect.poll(async () => {
      const popup = await page.getByRole("listbox", { name: "Months with records" }).boundingBox();
      return Boolean(popup && popup.x >= 0 && popup.x + popup.width <= width);
    }, { message: `The open month calendar fits a ${width}px viewport` }).toBe(true);
    await page.getByRole("option", { name: "September 2026", exact: true }).click();
  }
  await expect(page.getByRole("combobox", { name: "Month" })).toHaveText(/September|Sep/);
  await expect.poll(() => overviewRequests.at(-1)).toContain(
    "period=month&month=2026-09",
  );
  expect(overviewRequests.some((query) => query.includes("period=all"))).toBe(false);
  expect(await horizontalScroll(page)).toBe(0);
});
