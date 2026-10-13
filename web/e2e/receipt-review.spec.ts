import { expect, test, type Page } from "@playwright/test";
import { chooseUpload, loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

async function expectResponsiveReceiptUpload(page: Page) {
  const viewports = [
    { width: 1900, height: 969, expectedWidth: 1152, desktop: true },
    { width: 1440, height: 900, expectedWidth: 1024, desktop: true },
    { width: 1024, height: 900, desktop: false },
    { width: 390, height: 900, desktop: false },
    { width: 200, height: 900, desktop: false },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => window.scrollTo(0, 0));

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const main = await page.locator("#main-content").boundingBox();
    const mainInnerWidth = await page.locator("#main-content").evaluate((element) => {
      const styles = getComputedStyle(element);
      return element.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight);
    });
    const setup = await page.getByRole("region", { name: "Receipt scan setup" }).boundingBox();
    const form = await page.getByRole("region", { name: "Receipt scan setup" }).locator("form").boundingBox();
    const tips = await page.getByRole("complementary", { name: "Photo tips" }).boundingBox();

    expect(main).not.toBeNull();
    expect(setup).not.toBeNull();
    expect(form).not.toBeNull();
    expect(tips).not.toBeNull();
    expect(Math.abs((setup!.x + setup!.width / 2) - (main!.x + main!.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(setup!.width - Math.min(mainInnerWidth, viewport.expectedWidth ?? 1024))).toBeLessThanOrEqual(2);

    if (viewport.desktop) {
      expect(Math.abs(setup!.width - viewport.expectedWidth!)).toBeLessThanOrEqual(2);
      expect(Math.abs(form!.y - tips!.y)).toBeLessThanOrEqual(2);
      expect(form!.y + form!.height).toBeLessThanOrEqual(viewport.height);
      expect(tips!.y + tips!.height).toBeLessThanOrEqual(viewport.height);
      expect((await page.getByRole("heading", { name: "Scan a receipt" }).boundingBox())!.x).toBeLessThan(setup!.x);
    } else {
      expect(Math.abs(form!.width - setup!.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(tips!.width - setup!.width)).toBeLessThanOrEqual(2);
      expect(tips!.y).toBeGreaterThan(form!.y + form!.height);

      const scanButton = page.getByRole("button", { name: "Scan receipt", exact: true });
      await scanButton.scrollIntoViewIfNeeded();
      const buttonBox = await scanButton.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(buttonBox!.y).toBeGreaterThanOrEqual(0);
      expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(viewport.height);
      expect(await scanButton.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return target === button || button.contains(target);
      })).toBe(true);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

test("upload, review optional details, correct and save a receipt across web layouts", async ({ page }, testInfo) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
  async function captureLightState(name: string) {
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-light-${width}x900.png`),
        fullPage: true,
      });
    }
  }
  const receipt = {
    id: 700, processingStatus: "Complete", extractedDate: "2026-09-01",
    extractedVendor: "CornerPaperShopMainBranchWholesaleCounterAndCustomerServiceDesk",
    extractedDescription: "PaperSuppliesForAllStoreLocationsIncludingTheWarehouseAndWeekendMarketStalls",
    extractedAmount: 560, ocrConfidence: 85, items: [],
    warnings: [
      { code: "AMBIGUOUS_DATE", field: "date", guidance: "Check the date before saving.", detail: "The printed date has two possible readings." },
      { code: "LOW_CONFIDENCE", guidance: "Check unclear values.", detail: "Faded print near the receipt edge." },
    ],
    receiptDetails: { currency: "PHP", transactionTime: "14:30", subtotal: 500, tax: 60, tip: null, discount: null, paymentMethod: "Cash", receiptNumber: "R-100" },
  };
  let uploadBody = "";
  let saved: unknown;
  await page.route("**/records/receipts", async (route) => {
    uploadBody = route.request().postData() ?? "";
    await route.fulfill({ json: { ...receipt, processingStatus: "Processing" } });
  });
  // The scan page asks for unfinished scans on mount and again after an upload
  // (ScanReceipt.tsx's refreshActiveReceiptHistory). A query string makes the
  // URL miss the `**/records/receipts` glob above, so it needs its own route —
  // this owner has nothing left half-scanned.
  await page.route("**/records/receipts?*", async (route) => {
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route("**/records/receipts/700", async (route) => { await route.fulfill({ json: receipt }); });
  await page.route("**/records/receipts/700/duplicate-candidates**", async (route) => {
    await route.fulfill({
      json: {
        sourceFingerprint: null,
        candidateSetHash: null,
        candidateCount: 0,
        candidatesTruncated: false,
        candidates: [],
        nextCursor: null,
      },
    });
  });
  await page.route("**/records/receipts/700/confirm", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: [{ id: 701 }] });
  });
  await page.route("**/records/search**", async (route) => { await route.fulfill({ json: { items: [], nextCursor: null } }); });
  await page.route("**/records/flagged/count**", async (route) => { await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }); });
  await page.getByRole("button", { name: "Quick add" }).click();
  await page.getByRole("menuitem", { name: /Scan receipt/ }).click();
  await expect(page).toHaveURL(/\/records\/receipts\/new$/);
  await expect(page.getByText("Checking unfinished scans…")).toHaveCount(0);
  // Deterministic, labelled synthetic receipt; no OCR accuracy is implied.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 360; canvas.height = 540;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white"; context.fillRect(0, 0, 360, 540);
    context.fillStyle = "#222"; context.font = "17px monospace";
    ["SYNTHETIC TEST RECEIPT", "Corner Paper Shop", "2026-09-01 14:30", "", "Paper supplies 500.00", "VAT             60.00", "TOTAL PHP      560.00", "", "Cash", "Receipt R-100"].forEach((line, index) => context.fillText(line, 25, 50 + index * 35));
    return canvas.toDataURL("image/png");
  });
  await chooseUpload(page, "Choose photos", { name: "synthetic-receipt.png", mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1]!, "base64") });
  await expect(page.getByRole("img", { name: "Page 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Move page 1/ })).toHaveCount(0);
  await expectResponsiveReceiptUpload(page);
  await captureLightState("receipt-upload-selected");
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
  const reviewViews = page.getByRole("tablist", { name: "Receipt review view" });
  for (const mode of ["Review", "Results", "Compact"] as const) {
    const tab = reviewViews.getByRole("tab", { name: mode, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#receipt-view-panel")).toHaveAttribute(
      "aria-labelledby",
      `receipt-view-tab-${mode.toLowerCase()}`,
    );
    await page.setViewportSize({ width: 200, height: 900 });
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll<HTMLElement>("#main-content *"))
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
          text: element.textContent?.trim().slice(0, 70),
          right: Math.round(element.getBoundingClientRect().right),
        }))
        .slice(0, 8),
    }));
    expect(layout.document, `${mode} mode should reflow at 200% zoom: ${JSON.stringify(layout.overflowing)}`).toBeLessThanOrEqual(layout.viewport);
    await captureLightState(`receipt-${mode.toLowerCase()}`);
  }
  await reviewViews.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.locator("#category")).toHaveValue("");
  await expect(page.getByText("Check the date before saving.")).toBeVisible();
  await expect(page.getByText("Faded print near the receipt edge.")).toBeHidden();
  const detailsButton = page.getByRole("button", { name: "Show more", exact: true }).first();
  await detailsButton.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Faded print near the receipt edge.")).toBeVisible();
  await page.getByRole("button", { name: "Show less", exact: true }).click();
  await expect(page.locator("#date")).toHaveValue("2026-09-01");
  for (const theme of ["classic", "light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`receipt-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.locator("#date").fill("2026-09-02");
  await page.locator("#amount").fill("570");
  await page.locator("#category").selectOption("101");
  await expect(page.getByText(/Suggested — check it$/)).toHaveCount(0);

  const navigationPrompt = page.waitForEvent("dialog");
  await page.evaluate(() => window.history.back());
  const dialog = await navigationPrompt;
  expect(dialog.message()).toContain("unsaved changes will be lost");
  await dialog.dismiss();
  await expect(page).toHaveURL(/\/records\/receipts\/new$/);
  await expect(page.locator("#date")).toHaveValue("2026-09-02");
  await expect(page.locator("#amount")).toHaveValue("570");

  await page.getByRole("button", { name: "Confirm & save expense" }).click();
  await expect(page).toHaveURL(/\/records$/);
  expect(uploadBody).toContain('name="idempotencyKey"');
  expect(saved).toMatchObject({ date: "2026-09-02", amount: 570 });
});
