import { expect, test } from "@playwright/test";
import { chooseUpload, loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

test("upload, review optional details, correct and save a receipt across web layouts", async ({ page }, testInfo) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
  const receipt = {
    id: 700, processingStatus: "Complete", extractedDate: "2026-09-01", extractedVendor: "Corner Paper Shop",
    extractedDescription: "Paper supplies", extractedAmount: 560, ocrConfidence: 85, items: [],
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
  await page.route("**/records/receipts/700", async (route) => { await route.fulfill({ json: receipt }); });
  await page.route("**/records/receipts/700/confirm", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: [{ id: 701 }] });
  });
  await page.route("**/records/search**", async (route) => { await route.fulfill({ json: { items: [], nextCursor: null } }); });
  await page.route("**/records/flagged/count**", async (route) => { await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }); });
  await page.goto("/records/receipts/new");
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
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check what FinSight read" })).toBeVisible();
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
  await page.getByRole("button", { name: "Confirm & save expense" }).click();
  await expect(page).toHaveURL(/\/records$/);
  expect(uploadBody).toContain('name="idempotencyKey"');
  expect(saved).toMatchObject({ date: "2026-09-02", amount: 570 });
});
