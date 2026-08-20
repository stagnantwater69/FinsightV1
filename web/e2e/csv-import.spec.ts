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
import { loginViaUi, mockBackendSession, mockSupabaseAuth } from "./mocks";

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

  await page.setInputFiles('input[type="file"]', {
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
