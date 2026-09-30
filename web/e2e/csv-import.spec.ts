/** Mocked-network coverage for Upload -> Map columns -> Review and import. */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { chooseUpload, loginViaUi, mockBackendSession, mockSupabaseAuth } from "./mocks";

async function expectNoHorizontalOverflow(page: Page, state: string) {
  for (const width of [200, 390, 1024, 1440, 1900]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${state} should fit a ${width}px viewport`,
    ).toBe(true);
  }
}

async function expectUploadSizedToViewport(page: Page) {
  for (const viewport of [
    { width: 1440, height: 900, minimumFormWidth: 1000 },
    { width: 1900, height: 969, minimumFormWidth: 1120 },
  ]) {
    await page.setViewportSize(viewport);
    const main = await page.locator("#main-content").boundingBox();
    const uploadForm = await page.locator("form:has(#csv-file)").boundingBox();
    const pageHeading = await page
      .getByRole("heading", { name: "Import CSV records" })
      .boundingBox();

    expect(main).not.toBeNull();
    expect(uploadForm).not.toBeNull();
    expect(pageHeading).not.toBeNull();
    const mainCenter = main!.x + main!.width / 2;
    const formCenter = uploadForm!.x + uploadForm!.width / 2;
    expect(
      Math.abs(mainCenter - formCenter),
      `Upload workspace should be centered at ${viewport.width}px`,
    ).toBeLessThanOrEqual(2);
    expect(
      uploadForm!.width,
      `Upload workspace should use the available width at ${viewport.width}px`,
    ).toBeGreaterThanOrEqual(viewport.minimumFormWidth);
    expect(
      uploadForm!.x - pageHeading!.x,
      "Only the upload workflow should be centered, not the page heading",
    ).toBeGreaterThan(24);
  }
}

async function expectSelectedUploadToFitDesktop(page: Page) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1900, height: 969 },
  ]) {
    await page.setViewportSize(viewport);
    const nextSteps = await page.locator("[aria-labelledby='csv-next-title']").boundingBox();
    expect(nextSteps).not.toBeNull();
    expect(
      nextSteps!.y + nextSteps!.height,
      `Selected-file workflow should fit a ${viewport.width}x${viewport.height} viewport`,
    ).toBeLessThanOrEqual(viewport.height);
  }
}

async function captureVisualAudit(page: Page, testInfo: TestInfo, stage: string, includeDark = false) {
  if (!process.env.CSV_VISUAL_AUDIT) return;
  const themes = includeDark ? ["light", "dark"] : ["light"];
  const viewports = stage === "upload"
    ? [{ width: 1900, height: 969 }, { width: 1440, height: 900 }, { width: 390, height: 900 }]
    : [{ width: 1440, height: 900 }, { width: 390, height: 900 }];
  for (const theme of themes) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: testInfo.outputPath(`csv-${stage}-${theme}-${viewport.width}.png`), fullPage: true });
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.beforeEach(async ({ page }) => {
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
});

test("keeps upload and mapping state through Back and confirms only from final review", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  let previewRequests = 0;
  let fileUploadRequests = 0;
  const csvFileName = "september-expenses-from-the-main-store-and-all-market-stalls-with-adjustments.csv";
  await page.route("**/records/csv-imports/preview", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    previewRequests += 1;
    if (((await route.request().headerValue("content-type")) ?? "").includes("multipart/form-data")) {
      fileUploadRequests += 1;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        stagedUploadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        headers: ["Date", "Description", "Category", "Amount", "Gross Total"],
        previewRows: [
          { Date: "2026-08-01", Description: "Rice sacks", Category: "Inventory", Amount: "850.50", "Gross Total": "850.50" },
          { Date: "2026-08-02", Description: "Electric bill", Category: "Utilities", Amount: "3200", "Gross Total": "3200" },
        ],
        totalRows: 2,
        detectedTypeColumn: null,
        columnsWithNegatives: [],
        validation: {
          validRows: 2,
          invalidRows: 0,
          skipped: [],
          skippedTruncated: false,
          possibleDuplicateRows: 0,
        },
      }),
    });
  });

  let confirmRequests = 0;
  let confirmedBody: Record<string, unknown> = {};
  await page.route("**/records/csv-imports/confirm", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    confirmRequests += 1;
    confirmedBody = route.request().postDataJSON() as Record<string, unknown>;
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
  await expectNoHorizontalOverflow(page, "Upload");
  await expectUploadSizedToViewport(page);

  const sampleLink = page.getByRole("link", { name: "Download an example CSV" });
  await expect(sampleLink).toHaveAttribute("href", "/sample-import.csv");
  const downloadPromise = page.waitForEvent("download");
  await sampleLink.click();
  const sampleDownload = await downloadPromise;
  expect(sampleDownload.suggestedFilename()).toBe("sample-import.csv");

  await chooseUpload(page, "Choose CSV file", {
    name: csvFileName,
    mimeType: "text/csv",
    buffer: Buffer.from("Date,Description,Category,Amount\n2026-08-01,Rice sacks,Inventory,850.50\n"),
  });
  await expect(page.getByText(csvFileName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove file" }).click();
  await expect(page.getByText(csvFileName, { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Preview file" })).toBeDisabled();

  await chooseUpload(page, "Choose CSV file", {
    name: csvFileName,
    mimeType: "text/csv",
    buffer: Buffer.from("Date,Description,Category,Amount\n2026-08-01,Rice sacks,Inventory,850.50\n"),
  });
  await expect(page.getByText(csvFileName, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, "Selected CSV upload with a long filename");
  await expectSelectedUploadToFitDesktop(page);
  await captureVisualAudit(page, testInfo, "upload", true);
  await page.getByRole("button", { name: "Preview file" }).click();

  await expect(page.getByRole("heading", { name: "Map and review columns" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "Map columns");
  await expect(page.getByLabel("Which CSV column holds the date?")).toHaveValue("Date");
  await expect(page.getByLabel("Which CSV column holds the description?")).toHaveValue("Description");
  await expect(page.getByLabel("Which CSV column holds the category?")).toHaveValue("Category");
  await expect(page.getByLabel("Which CSV column holds the amount?")).toHaveValue("Amount");
  await captureVisualAudit(page, testInfo, "map");

  await page.getByLabel("Batch title").fill("August expenses");
  await page.getByLabel("Which CSV column holds the amount?").selectOption("Gross Total");

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import CSV records" })).toBeVisible();
  await expect(page.getByText(csvFileName, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to column mapping" })).toBeVisible();
  expect(previewRequests).toBe(1);
  expect(confirmRequests).toBe(0);

  await page.getByRole("button", { name: "Continue to column mapping" }).click();
  await expect(page.getByRole("heading", { name: "Map and review columns" })).toBeVisible();
  await expect(page.getByLabel("Batch title")).toHaveValue("August expenses");
  await expect(page.getByLabel("Which CSV column holds the amount?")).toHaveValue("Gross Total");

  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(page.getByRole("heading", { name: "Review and import" })).toBeVisible();
  await expect(page.getByText("August expenses", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, "Review and import");
  await captureVisualAudit(page, testInfo, "review", true);
  expect(previewRequests).toBe(2);
  expect(fileUploadRequests).toBe(1);
  expect(confirmRequests).toBe(0);

  await page.getByRole("button", { name: "Back to mapping" }).click();
  await expect(page.getByRole("heading", { name: "Map and review columns" })).toBeVisible();
  await expect(page.getByLabel("Batch title")).toHaveValue("August expenses");
  await expect(page.getByLabel("Which CSV column holds the amount?")).toHaveValue("Gross Total");
  expect(confirmRequests).toBe(0);

  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(page.getByRole("heading", { name: "Review and import" })).toBeVisible();
  expect(previewRequests).toBe(2);
  expect(confirmRequests).toBe(0);

  await page.getByRole("button", { name: "Import 2 of 2 rows" }).click();

  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByText("2 records imported")).toBeVisible();
  expect(confirmRequests).toBe(1);
  expect(confirmedBody.recordType).toBe("expense");
  expect(confirmedBody.idempotencyKey).toEqual(expect.any(String));
  expect(confirmedBody.stagedUploadId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  expect(confirmedBody.columnMapping).toMatchObject({ amount: "Gross Total" });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("reviews skipped and duplicate rows before importing and keeps result details optional", async ({ page }, testInfo) => {
  const preview = {
    stagedUploadId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
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
  await chooseUpload(page, "Choose CSV file", { name: "expenses.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Description,Category,Amount\n2026-09-01,Paper supplies,Inventory,500\n") });
  await page.getByRole("button", { name: "Preview file", exact: true }).click();
  await page.getByRole("button", { name: "Continue to review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review and import" })).toBeVisible();
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
  await expect(page.getByRole("link", { name: "Review them now" })).toBeVisible();
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
      stagedUploadId: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
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
  await chooseUpload(page, "Choose CSV file", { name: "expenses.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Description,Category,Amount\n2026-09-01,Paper,Inventory,500\n") });
  await page.getByRole("button", { name: "Preview file", exact: true }).click();
  await page.getByRole("button", { name: "Continue to review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review and import" })).toBeVisible();
  await page.getByRole("button", { name: "Import 1,000 of 1,000 rows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import stopped" })).toBeVisible();
  await expect(page.getByText("380", { exact: true })).toBeVisible();
  await expect(page.getByText("20", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review saved records" })).toHaveAttribute("href", "/records?source=CSV_UPLOAD&importBatchId=801");
  await expect(page.getByRole("button", { name: /^Import/ })).toHaveCount(0);
  expect(confirms).toBe(1);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("csv-stopped-390.png"), fullPage: true });
});
