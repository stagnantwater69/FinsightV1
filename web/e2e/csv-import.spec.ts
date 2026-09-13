/**
 * Mocked-network E2E coverage for the CSV import flow: preview -> map columns
 * -> confirm.
 *
 * As with the other new specs in this directory, no real Supabase project or
 * FinSight backend is involved — every request the app makes is intercepted
 * with `page.route()` and answered with hand-written JSON shaped to
 * `web/src/lib/types.ts` / the ImportCsv page's own response shapes. See
 * mocks.ts for the shared session/context setup.
 */
import { expect, test } from "@playwright/test";
import { chooseUpload, loginViaUi, mockBackendSession, mockSupabaseAuth } from "./mocks";

test.beforeEach(async ({ page }) => {
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
});

test("validate, preview and confirm a CSV import", async ({ page }) => {
  await page.route("**/records/csv-imports/preview", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        headers: ["Date", "Description", "Category", "Amount"],
        previewRows: [
          { Date: "2026-08-01", Description: "Rice sacks", Category: "Inventory", Amount: "850.50" },
          { Date: "2026-08-02", Description: "Electric bill", Category: "Utilities", Amount: "3200" },
        ],
        totalRows: 2,
        detectedTypeColumn: null,
        columnsWithNegatives: [],
      }),
    });
  });

  let confirmedFields: Record<string, string> = {};
  await page.route("**/records/csv-imports/confirm", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const fields = route.request().postData() ?? "";
    // multipart/form-data — good enough to assert the recordType and title
    // fields rode along, without parsing the whole body.
    confirmedFields = { raw: fields };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId: 999,
        title: "August expenses",
        status: "COMPLETE",
        totalRows: 2,
        imported: 2,
        skipped: [],
        flagged: 0,
        largeExpenseFlagged: 0,
        importedExpenses: 2,
        importedSales: 0,
        uncategorised: 0,
      }),
    });
  });

  await page.goto("/records/csv-imports/new");
  await expect(page.getByRole("heading", { name: "Import CSV records" })).toBeVisible();

  await chooseUpload(page, "Choose a file", {
    name: "expenses.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Date,Description,Category,Amount\n2026-08-01,Rice sacks,Inventory,850.50\n"),
  });
  await page.getByRole("button", { name: "Preview" }).click();

  // The mapping screen — headers matched the built-in synonyms, so every
  // dropdown should already be auto-filled from the mocked preview response.
  await expect(page.getByRole("heading", { name: "Map your columns" })).toBeVisible();
  await expect(page.getByLabel("Which CSV column holds the date?")).toHaveValue("Date");
  await expect(page.getByLabel("Which CSV column holds the description?")).toHaveValue("Description");
  await expect(page.getByLabel("Which CSV column holds the category?")).toHaveValue("Category");
  await expect(page.getByLabel("Which CSV column holds the amount?")).toHaveValue("Amount");

  await page.getByLabel("Batch title").fill("August expenses");
  await page.getByRole("button", { name: /^Import 2 rows$/ }).click();

  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByText("2 records imported")).toBeVisible();
  expect(confirmedFields.raw).toContain('name="recordType"');
  /*
   * The replay token has to ride along on every confirm, including retries —
   * it is what makes a second click return the SAME import instead of a second
   * copy of the owner's records. Nothing about it is visible in the UI, which
   * is exactly why it is asserted at the HTTP boundary here as well as in the
   * component test.
   */
  expect(confirmedFields.raw).toContain('name="idempotencyKey"');
});

test("reviews skipped and duplicate rows before importing and keeps result details optional", async ({ page }, testInfo) => {
  const preview = {
    headers: ["Date", "Description", "Category", "Amount"],
    previewRows: [{ Date: "2026-09-01", Description: "Paper supplies", Category: "Inventory", Amount: "500" }],
    totalRows: 3, dateFormatAmbiguous: false, detectedDateFormat: "iso",
    validation: { validRows: 2, invalidRows: 1, skipped: [{ row: 4, reason: "Invalid amount" }], skippedTruncated: false, possibleDuplicateRows: 1, duplicateRows: [3] },
  };
  await page.route("**/records/csv-imports/preview", async (route) => { await route.fulfill({ json: preview }); });
  let confirms = 0;
  await page.route("**/records/csv-imports/confirm", async (route) => {
    confirms += 1;
    await route.fulfill({ json: { batchId: 800, title: "September expenses", status: "COMPLETE", totalRows: 3, imported: 2, skipped: [{ row: 4, reason: "Invalid amount" }], flagged: 1, largeExpenseFlagged: 0 } });
  });
  await page.goto("/records/csv-imports/new");
  await chooseUpload(page, "Choose a file", { name: "expenses.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Description,Category,Amount\n2026-09-01,Paper supplies,Inventory,500\n") });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Check all rows", exact: true }).click();
  await expect(page.getByText("File check: 2 valid, 1 skipped.")).toBeVisible();
  await expect(page.getByText("1 possible duplicate will be included and flagged for review.")).toBeVisible();
  expect(confirms).toBe(0);
  await expect(page.getByText("Row 4: Invalid amount")).toBeHidden();
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.getByText("Row 4: Invalid amount")).toBeVisible();
  await page.getByRole("button", { name: "Import 2 of 3 rows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  expect(confirms).toBe(1);
  await expect(page.getByText("Row 4: Invalid amount")).toBeHidden();
  await expect(page.getByRole("link", { name: "Review them now →" })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`csv-result-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.getByText("Row 4: Invalid amount")).toBeVisible();
  await page.getByRole("button", { name: "Show less", exact: true }).click();
  await expect(page.getByText("Row 4: Invalid amount")).toBeHidden();
});

test("a terminal import failure reports saved rows and directs recovery to the batch", async ({ page }, testInfo) => {
  await page.route("**/records/csv-imports/preview", async (route) => {
    await route.fulfill({ json: {
      headers: ["Date", "Description", "Category", "Amount"],
      previewRows: [{ Date: "2026-09-01", Description: "Paper", Category: "Inventory", Amount: "500" }],
      totalRows: 1000, dateFormatAmbiguous: false,
      validation: { validRows: 1000, invalidRows: 0, skipped: [], skippedTruncated: false },
    } });
  });
  let confirms = 0;
  await page.route("**/records/csv-imports/confirm", async (route) => {
    confirms += 1;
    await route.fulfill({ status: 202, json: { batchId: 801, title: "September expenses", status: "Pending Review", processingStatus: "PENDING", totalRows: 1000, imported: 0, skipped: [], flagged: 0 } });
  });
  await page.route("**/records/csv-imports/batches/801/status", async (route) => {
    await route.fulfill({ json: { batchId: 801, status: "Pending Review", processingStatus: "FAILED", totalRows: 1000, processedRows: 400, importedRows: 380, skippedRows: 20, flaggedRows: 0, failureStage: "insert", resultSummary: { skipped: [{ row: 4, reason: "Invalid amount" }], skippedTruncated: true } } });
  });
  await page.goto("/records/csv-imports/new");
  await chooseUpload(page, "Choose a file", { name: "expenses.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Description,Category,Amount\n2026-09-01,Paper,Inventory,500\n") });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Import 1000 rows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import stopped" })).toBeVisible();
  await expect(page.getByText("380", { exact: true })).toBeVisible();
  await expect(page.getByText("20", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review saved records" })).toHaveAttribute("href", "/records?source=CSV_UPLOAD&importBatchId=801");
  await expect(page.getByRole("button", { name: /^Import/ })).toHaveCount(0);
  expect(confirms).toBe(1);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("csv-stopped-390.png"), fullPage: true });
});
