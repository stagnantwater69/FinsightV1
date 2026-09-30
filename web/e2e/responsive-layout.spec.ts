/**
 * Reflow and reduced-motion regressions, measured in a real browser.
 *
 * Horizontal page scroll is the one layout fault that cannot be caught by a
 * jsdom unit test — it needs real layout. Each assertion here pins a fix that
 * would otherwise rot the next time a row gains a control: an unwrapping flex
 * row is invisible at 1440px and only shows up when the viewport gets narrow.
 *
 * 200px is the narrow end deliberately: it is 400px at 200% browser zoom, the
 * width the accessibility pass is measured at. As with the other specs here,
 * nothing talks to a real backend — see mocks.ts.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";
import type { RecordItem } from "../src/lib/types";

/** Long vendor and description strings, because short ones hide overflow. */
function records(count: number): RecordItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    type: i % 3 === 0 ? ("sales" as const) : ("expense" as const),
    businessProfileId: 10,
    categoryId: 100,
    receiptScanId: null,
    importBatchId: null,
    duplicateOfRecordId: null,
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    description: "Wholesale inventory restock from the Divisoria supplier, assorted canned goods",
    vendor: "Divisoria Wholesale Trading Corporation",
    amount: 1234.5 + i * 97,
    allocatedCharges: null,
    source: "manual",
    reviewStatus: "OK" as RecordItem["reviewStatus"],
    duplicateStatus: "None" as RecordItem["duplicateStatus"],
    largeExpenseFlag: false,
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
}

/** How far the document can actually be scrolled sideways, in CSS pixels. */
async function horizontalScroll(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    window.scrollTo(5000, 0);
    const x = window.scrollX;
    window.scrollTo(0, 0);
    return x;
  });
}

async function expectInsideLoginCard(page: Page, locator: Locator): Promise<void> {
  const [box, card, viewportWidth] = await Promise.all([
    locator.boundingBox(),
    page.locator("#main-content").boundingBox(),
    page.evaluate(() => window.innerWidth),
  ]);
  expect(box).not.toBeNull();
  expect(card).not.toBeNull();
  const leftEdge = Math.max(0, card!.x);
  const rightEdge = Math.min(viewportWidth, card!.x + card!.width);
  expect(box!.x).toBeGreaterThanOrEqual(leftEdge);
  expect(box!.x + box!.width).toBeLessThanOrEqual(rightEdge);
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await page.route("**/api/v1/records/search**", (route) =>
    route.fulfill({ json: { items: records(12), nextCursor: null } }),
  );
  await page.route("**/api/v1/records/flagged/count**", (route) =>
    route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }),
  );
  await page.route("**/api/v1/records/csv-imports/batches**", (route) => route.fulfill({ json: [] }));
});

const WIDTHS = [320, 400, 768, 1024, 1440];

for (const width of WIDTHS) {
  test(`Records reflows without horizontal page scroll at ${width}px`, async ({ page }) => {
    await loginViaUi(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/records");
    await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();
    expect(await horizontalScroll(page)).toBe(0);
  });
}

test("the complete login form stays reachable at 200px", async ({ page }) => {
  await page.route("**/auth/login", (route) =>
    route.fulfill({ status: 502, contentType: "text/plain", body: "" }),
  );
  await page.setViewportSize({ width: 200, height: 700 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("owner-password");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "FinSight is temporarily unavailable. Please try again in a moment.",
  );
  for (const control of [
    page.locator("#main-content"),
    page.getByLabel("Email"),
    page.locator("#password"),
    page.getByRole("link", { name: "Forgot password?" }),
    page.getByRole("button", { name: "Show password" }),
    page.getByRole("button", { name: "Log in" }),
    page.getByRole("link", { name: "Create account" }),
    page.locator('img[src="/newmascotlogo.png"]'),
    page.getByText("FinSight", { exact: true }),
  ]) {
    await expectInsideLoginCard(page, control);
  }

  const mainOverflow = await page.locator("#main-content").evaluate(
    (element) => element.scrollWidth - element.offsetWidth,
  );
  expect(mainOverflow).toBeLessThanOrEqual(0);
  const compactInputSize = await page.getByLabel("Email").evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(compactInputSize).toBeGreaterThanOrEqual(16);
  expect(await horizontalScroll(page)).toBe(0);
});

test("the app shell header wraps instead of scrolling the page at 200px", async ({ page }) => {
  await loginViaUi(page);
  await page.setViewportSize({ width: 200, height: 450 });
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();

  // Every control stays reachable: wrapping must not be achieved by hiding one.
  await expect(page.getByRole("button", { name: /quick add/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible();
  expect(await horizontalScroll(page)).toBe(0);
});

test("the dashboard period switcher wraps rather than widening the page at 200px", async ({ page }) => {
  await page.route("**/api/v1/dashboard/summary**", (route) =>
    route.fulfill({
      json: {
        periodDays: 30,
        periodStart: "2026-07-01",
        periodEnd: "2026-08-01",
        overview: { availableFunds: 50000, totalExpenses: 18000, totalSalesReference: 42000 },
        expenseCategoryBreakdown: [],
        recoveryStatus: {
          expectedMonthlyExpenses: 20000, operatingDays: 26, dailyNeededTarget: 800,
          salesThisMonth: 42000, remainingTarget: 0, daysInMonth: 31, calendarDaysLeftInMonth: 10,
          remainingOperatingDays: 8, remainingOperatingDaysIsApproximated: false, adjustedDailyTarget: 800,
          todaysTarget: 800, todaysSales: 800, todaysGap: 0, todaysStatus: "at",
          monthCoveragePercent: 100, onTrack: true,
        },
        recordsNeedingReview: 0,
        alerts: [],
        lifetime: { recordCount: 42, latestRecordDate: "2026-08-01" },
      },
    }),
  );
  await page.route("**/api/v1/insights/expense-behavior**", (route) =>
    route.fulfill({
      json: {
        periodStart: "2026-07-01", periodEnd: "2026-08-01",
        previousPeriodStart: "2026-06-01", previousPeriodEnd: "2026-07-01", periodDays: 30,
        totals: { current: 0, previous: 0 },
        dailyTotals: [], categoryTrends: [], unusualExpenses: [], insufficientHistoryCategories: [],
      },
    }),
  );
  await loginViaUi(page);
  await page.setViewportSize({ width: 200, height: 450 });
  await page.goto("/dashboard");
  const allTime = page.getByRole("button", { name: "All time" });
  await expect(allTime).toBeVisible();

  // The group as a whole, not the page: other dashboard panels have their own
  // narrow-width behaviour, and this assertion is about the switcher only.
  const box = await allTime.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(200);
});

test("the skip link moves focus to the main landmark", async ({ page }) => {
  await loginViaUi(page);
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();

  const skip = page.getByRole("link", { name: "Skip to main content" });
  await skip.focus();
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("Escape cancels a destructive confirmation without deleting", async ({ page }) => {
  let deletes = 0;
  await page.route("**/api/v1/records/expenses/*", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes += 1;
    return route.fulfill({ json: {} });
  });
  await loginViaUi(page);
  await page.setViewportSize({ width: 400, height: 900 });
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Delete /i }).first().click();
  const dialog = page.getByRole("dialog", { name: /^Delete "/ });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(deletes).toBe(0);
});

test("reduced motion leaves no long animation or transition running", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginViaUi(page);
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();

  const slow = await page.evaluate(() => {
    const toMs = (value: string) =>
      value.split(",").map((part) => {
        const n = parseFloat(part);
        return Number.isNaN(n) ? 0 : part.includes("ms") ? n : n * 1000;
      });
    return Array.from(document.querySelectorAll("body *"))
      .filter((el) => {
        const cs = getComputedStyle(el);
        return Math.max(0, ...toMs(cs.animationDuration), ...toMs(cs.transitionDuration)) > 50;
      })
      .map((el) => el.tagName.toLowerCase() + "." + String((el as HTMLElement).className).split(" ")[0])
      .slice(0, 5);
  });
  expect(slow).toEqual([]);
});
