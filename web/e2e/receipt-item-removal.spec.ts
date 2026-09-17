import { expect, test, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

/*
 * Removing a scanned line changes what gets written — the expense is saved
 * from whatever is left in the table — and the DELETE has no undo, so the
 * confirm step is the only way back. Three things have to hold: nothing is
 * sent until the owner says yes, dismissing sends nothing at all, and a
 * removal in flight locks every other row's × (each carries the revision it
 * was rendered with, so a second click returns 409 for the owner's own edit).
 *
 * The third is a real-browser question about whether `disabled` lands before
 * the next click can, which is why these are here and not in a component test.
 */

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function item(id: number, lineNumber: number, name: string, amount: number) {
  return { id, lineNumber, name, quantity: 1, unitPrice: amount, amount, categoryId: null };
}

/** The scan the review screen opens on: three read lines totalling 100. */
function scanWithItems(items: ReturnType<typeof item>[], scanRevision = 0) {
  return {
    id: 720,
    receiptBatchId: null,
    receiptOrdinal: null,
    scanRevision,
    processingStatus: "Complete",
    confirmationStatus: "Pending",
    processingError: null,
    processingErrorCode: null,
    extractedDate: "2026-09-13T00:00:00.000Z",
    extractedVendor: "Corner Sari-Sari",
    extractedDescription: "Weekly stock",
    extractedAmount: 100,
    ocrConfidence: 91,
    items,
    itemsSubtotal: items.reduce((sum, line) => sum + line.amount, 0),
    warnings: [],
    pageQualities: [],
    pageProcessing: [],
    pageEvidence: [],
  };
}

const ALL_ITEMS = [item(1, 1, "Rice 5kg", 60), item(2, 2, "Cooking oil", 25), item(3, 3, "Soy sauce", 15)];

async function chooseReceiptPhoto(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Choose photos", { exact: true }).click(),
  ]);
  await chooser.setFiles([{ name: "receipt.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG }]);
}

/** Uploads one receipt and lands on the review screen with ALL_ITEMS showing. */
async function openReview(page: Page) {
  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
      return;
    }
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 202, json: scanWithItems(ALL_ITEMS) });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhoto(page);
  await page.getByRole("button", { name: /^Scan/ }).click();
  await expect(page.getByRole("heading", { name: "Check what FinSight read" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Remove Rice 5kg/ })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
  await page.route("https://storage.example.test/**", async (route) => {
    await route.fulfill({ contentType: "image/png", body: ONE_PIXEL_PNG });
  });
  await page.route(/\/records\/receipts\/\d+\/duplicate-candidates(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: { sourceFingerprint: null, candidateSetHash: null, candidates: [], nextCursor: null },
    });
  });
  await page.route("**/records/search**", async (route) => {
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route("**/records/flagged/count**", async (route) => {
    await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } });
  });
});

test("dismissing the confirm leaves the line, and sends nothing", async ({ page }) => {
  const deletes: string[] = [];
  await page.route(/\/records\/receipts\/720\/items\/\d+/, async (route) => {
    deletes.push(route.request().url());
    await route.fulfill({ status: 200, json: scanWithItems(ALL_ITEMS.slice(1), 1) });
  });

  await openReview(page);
  await page.getByRole("button", { name: /^Remove Rice 5kg/ }).click();

  // The question names the line, because "are you sure?" does not tell an
  // owner which of three rows they are about to lose.
  await expect(page.getByRole("heading", { name: 'Remove "Rice 5kg"?' })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(page.getByRole("heading", { name: 'Remove "Rice 5kg"?' })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Remove Rice 5kg/ })).toBeVisible();
  // The assertion that matters: no irreversible server call was made.
  expect(deletes).toEqual([]);
});

test("confirming removes the line once, with the revision it was rendered with", async ({ page }) => {
  const deletes: Array<{ path: string; revision: string | null }> = [];
  await page.route(/\/records\/receipts\/720\/items\/\d+/, async (route) => {
    const url = new URL(route.request().url());
    deletes.push({ path: url.pathname, revision: url.searchParams.get("expectedScanRevision") });
    await route.fulfill({ status: 200, json: scanWithItems(ALL_ITEMS.slice(1), 1) });
  });

  await openReview(page);
  await page.getByRole("button", { name: /^Remove Rice 5kg/ }).click();
  await page.getByRole("button", { name: "Remove item", exact: true }).click();

  await expect(page.getByRole("button", { name: /^Remove Rice 5kg/ })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Remove Cooking oil/ })).toBeVisible();
  expect(deletes).toEqual([{ path: "/api/v1/records/receipts/720/items/1", revision: "0" }]);
});

test("a removal in flight locks every other row's remove, not just its own", async ({ page }) => {
  const deletes: string[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(/\/records\/receipts\/720\/items\/\d+/, async (route) => {
    deletes.push(new URL(route.request().url()).pathname);
    // Hold the first delete open so the second click happens while it is in
    // flight — the exact window in which the old code let a stale revision go.
    await held;
    await route.fulfill({ status: 200, json: scanWithItems(ALL_ITEMS.slice(1), 1) });
  });

  await openReview(page);
  await page.getByRole("button", { name: /^Remove Rice 5kg/ }).click();
  await page.getByRole("button", { name: "Remove item", exact: true }).click();

  const other = page.getByRole("button", { name: /^Remove Cooking oil/ });
  await expect(other).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Edit Cooking oil/ })).toBeDisabled();

  release?.();
  await expect(page.getByRole("button", { name: /^Remove Rice 5kg/ })).toBeHidden();
  // One request, from the one row the owner actually confirmed.
  expect(deletes).toEqual(["/api/v1/records/receipts/720/items/1"]);
  await expect(other).toBeEnabled();
});
