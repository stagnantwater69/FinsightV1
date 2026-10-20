/**
 * Layout guard across phone (portrait and landscape), tablet and desktop
 * widths. Mocked network only (see mocks.ts).
 *
 * The fixture data is deliberately hostile: a vendor name with no spaces and
 * amounts in the hundreds of thousands, because that is what broke the
 * dashboard at 320-390px (an unbreakable name widened the page, and amounts
 * split mid-number).
 */
import { expect, test, type Page } from "@playwright/test";
import type { RecordItem } from "../src/lib/types";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour, TEST_BUSINESS_PROFILE } from "./mocks";

const VIEWPORTS = [
  { name: "phone 320", width: 320, height: 568 },
  { name: "phone landscape", width: 568, height: 320 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 720 },
];

const LONG_NAME = "Averyveryverylongvendornamewithoutanyspacesatall";

function record(id: number, type: "expense" | "sales", description: string, vendor: string | null, amount: number): RecordItem {
  return {
    id, type, businessProfileId: TEST_BUSINESS_PROFILE.id, categoryId: type === "expense" ? 100 : null,
    duplicateOfRecordId: null, date: "2026-09-10T00:00:00.000Z", description, vendor, amount,
    source: "MANUAL", reviewStatus: "Reviewed", duplicateStatus: "Not a Duplicate", createdAt: "2026-09-10T00:00:00.000Z",
  } as RecordItem;
}

async function signIn(page: Page) {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  const rows = [
    record(1, "expense", LONG_NAME, LONG_NAME, 999999.99),
    record(2, "sales", "Cash sales", null, 184500),
  ];
  await page.route("**/records/search**", (r) => r.fulfill({ json: { items: rows, nextCursor: null } }));
  await page.route("**/records/flagged/count**", (r) => r.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }));
  await page.route("**/records/csv-imports/batches**", (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/dashboard/summary**", (r) => r.fulfill({ json: {
    periodDays: 30, periodStart: "2026-09-01", periodEnd: "2026-09-30",
    overview: { availableFunds: 1128300, totalExpenses: 56200, totalSalesReference: 184500 },
    expenseCategoryBreakdown: [{ categoryId: 100, categoryName: "Inventory", total: 56200, percent: 100 }],
    recoveryStatus: {
      expectedMonthlyExpenses: 600000, operatingDays: [1, 2, 3, 4, 5, 6], dailyNeededTarget: 24000, salesThisMonth: 420000,
      remainingTarget: 180000, daysInMonth: 30, calendarDaysLeftInMonth: 10, remainingOperatingDays: 8,
      remainingOperatingDaysIsApproximated: false, adjustedDailyTarget: 22500, todaysTarget: 22500, todaysSales: 8000,
      todaysGap: 14500, todaysStatus: "below", monthCoveragePercent: 70, onTrack: false,
    },
    recordsNeedingReview: 0, alerts: [], lifetime: { recordCount: 2, latestRecordDate: "2026-09-10" },
  } }));
  await loginViaUi(page);
}

/** Width the page scrolls past its own viewport, ignoring the scrollbar. */
function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function expectInsideViewport(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, `${selector} should be visible`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

for (const vp of VIEWPORTS) {
  test(`public pages do not scroll sideways on ${vp.name}`, async ({ page }) => {
    await mockSupabaseAuth(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const path of ["/", "/login", "/register", "/faqs", "/contact"]) {
      await page.goto(path);
      await expect(page.locator("#main-content")).toBeVisible();
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
    }
  });

  test(`signed-in pages do not scroll sideways on ${vp.name}`, async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const path of ["/dashboard", "/records", "/records/expenses/new", "/business-profiles/all", "/account-settings"]) {
      await page.goto(path);
      await expect(page.locator("#main-content")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
    }
  });
}

test("dashboard amounts stay whole on a 320px phone", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/dashboard");
  const funds = page.getByText("PHP 1,128,300", { exact: true }).first();
  await expect(funds).toBeVisible();
  // One line of digits: "1,128,300" never splits across lines.
  const digitsOnOneLine = await funds.evaluate((el) => {
    const range = document.createRange();
    const text = el.firstChild!;
    const start = text.textContent!.indexOf("1,128,300");
    range.setStart(text, start);
    range.setEnd(text, start + "1,128,300".length);
    return range.getClientRects().length === 1;
  });
  expect(digitsOnOneLine).toBe(true);
});

for (const vp of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
  test(`header menus stay on screen at ${vp.width}x${vp.height}`, async ({ page }) => {
    await signIn(page);
    await page.setViewportSize(vp);
    await page.goto("/dashboard");

    await page.locator("[data-tour=quick-add]").click();
    await expectInsideViewport(page, "[role=menu][aria-label='Add a record']");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Account menu/i }).click();
    const account = page.getByRole("dialog", { name: "Account" });
    await expect(account).toBeVisible();
    await expectInsideViewport(page, "[role=dialog][aria-label='Account']");
    // The panel scrolls inside itself rather than hiding Log out.
    const logOut = account.getByRole("button", { name: /Log out/i });
    await logOut.scrollIntoViewIfNeeded();
    await expect(logOut).toBeInViewport();
  });
}

test("add-expense dialog keeps its save button reachable on a phone held sideways", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto("/records");
  await page.locator("[data-tour=quick-add]").click();
  await page.getByRole("menuitem").first().click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expectInsideViewport(page, "dialog[open]");
  const save = dialog.getByRole("button", { name: /Save expense/i });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
});
