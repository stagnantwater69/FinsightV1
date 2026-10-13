import { expect, test } from "@playwright/test";
import { mockBackendSession, mockSupabaseAuth, skipTour, TEST_CATEGORIES, TEST_PROFILE } from "./mocks";

for (const viewport of [{ width: 320, height: 800 }, { width: 1440, height: 900 }]) {
  for (const theme of ["classic", "light", "dark"] as const) {
    test(`recovers from rejected requests at ${viewport.width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((chosenTheme) => localStorage.setItem("finsight.theme", chosenTheme), theme);
      await skipTour(page);
      await mockSupabaseAuth(page);
      await mockBackendSession(page);

      let loginRequests = 0;
      await page.route("**/auth/login", async (route) => {
        if (++loginRequests > 1) return route.fallback();
        await route.fulfill({ status: 429, json: { retryAfterSeconds: 17 } });
      });
      await page.goto("/login");
      await page.getByLabel("Email").fill(TEST_PROFILE.email);
      await page.locator("#password").fill("correct-horse-battery");
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Try again in 17s.");
      await expect(page.getByLabel("Email")).toHaveValue(TEST_PROFILE.email);
      await expect(page.locator("#password")).toHaveValue("correct-horse-battery");
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page.waitForURL("**/business-profiles");

      let categoriesAvailable = false;
      await page.route("**/records/categories**", async (route) => {
        if (route.request().resourceType() === "document") return route.continue();
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill(categoriesAvailable
          ? { status: 200, json: TEST_CATEGORIES }
          : { status: 503, json: { error: "Categories are temporarily unavailable." } });
      });
      await page.goto("/records/categories");
      await expect(page.getByRole("alert")).toContainText("Categories are temporarily unavailable.");
      await expect(page.getByText("No categories yet", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("category-load-error.png"), fullPage: true });
      categoriesAvailable = true;
      await page.getByRole("button", { name: "Retry loading categories" }).click();
      const classification = page.locator('select[aria-label="Cost behavior for Inventory"]:visible');
      await expect(classification).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await page.route("**/records/categories/100", async (route) => {
        await route.fulfill({ status: 429, json: { retryAfterSeconds: 11 } });
      });
      await classification.selectOption("FIXED");
      await expect(page.getByRole("alert").filter({ visible: true })).toContainText("Try again in 11s.");
      await expect(classification).toHaveValue("UNCLASSIFIED");
      await expect(classification).toBeEnabled();

      await page.route("**/notifications**", async (route) => {
        if (route.request().resourceType() === "document") return route.continue();
        if (route.request().method() === "PATCH") {
          await route.fulfill({ status: 429, json: { retryAfterSeconds: 9 } });
          return;
        }
        await route.fulfill({ status: 200, json: [{
          id: 501, businessProfileId: 10, expenseRecordId: null, type: "Import complete",
          message: "Synthetic import completed.", dateCreated: "2026-10-12T08:00:00Z", readStatus: false,
        }] });
      });
      await page.goto("/notifications");
      const markRead = page.getByRole("button", { name: /^Mark read\s*[:—]\s*Synthetic import completed\.$/ });
      await expect(markRead).toBeVisible();
      await markRead.click();
      await expect(page.getByRole("alert")).toContainText("Try again in 9s.");
      await expect(markRead).toBeVisible();
      await expect(page.getByRole("button", { name: "Unread (1)", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("notification-rollback.png"), fullPage: true });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
