/**
 * Receipt review drafts across a real page reload. Mocked network only (see
 * mocks.ts): the scan, its unfinished-scans row and the confirm call are
 * synthetic fixtures, and the draft itself lives in the browser's
 * sessionStorage exactly as the app writes it.
 */
import { expect, test, type Dialog, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour, TEST_PROFILE } from "./mocks";

// Each test reloads the authenticated app several times on a dev server.
test.describe.configure({ timeout: 120_000 });

const SCAN_ID = 730;
const DRAFT_KEY = `finsight.receiptReviewDraft.${TEST_PROFILE.id}.10.${SCAN_ID}`;

const READ = { vendor: "Draft merchant", description: "Paper supplies", date: "2026-09-13", amount: "100" };
const EDITED = { vendor: "Corrected merchant", description: "Paper and ink", date: "2026-09-14", amount: "125.5", category: "101" };

const scan = {
  id: SCAN_ID,
  receiptBatchId: null,
  receiptOrdinal: null,
  scanRevision: 0,
  processingStatus: "Complete",
  confirmationStatus: "Pending",
  processingError: null,
  processingErrorCode: null,
  extractedDate: `${READ.date}T00:00:00.000Z`,
  extractedVendor: READ.vendor,
  extractedDescription: READ.description,
  extractedAmount: Number(READ.amount),
  ocrConfidence: 91,
  items: [],
  warnings: [],
  pageQualities: [],
  pageProcessing: [],
  pageEvidence: [],
};

interface Harness {
  dialogs: { type: string; message: string }[];
  confirmed: unknown[];
}

async function setUp(page: Page): Promise<Harness> {
  const harness: Harness = { dialogs: [], confirmed: [] };
  // Leaving through a reload is accepted; an in-app leave prompt is refused so the test stays on the review.
  page.on("dialog", (dialog: Dialog) => {
    harness.dialogs.push({ type: dialog.type(), message: dialog.message() });
    void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  });
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  // The row stays listed even after confirm, so only a leftover draft could bring the notice back.
  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    await route.fulfill({
      json: {
        items: [{
          ...scan,
          businessProfileId: 10,
          createdAt: "2026-09-13T08:30:00.000Z",
          pageCount: 1,
          allowedActions: { retryProcessing: false, reviewResult: true },
        }],
        nextCursor: null,
      },
    });
  });
  await page.route(`**/records/receipts/${SCAN_ID}`, async (route) => { await route.fulfill({ json: scan }); });
  await page.route(`**/records/receipts/${SCAN_ID}/duplicate-candidates**`, async (route) => {
    await route.fulfill({
      json: { sourceFingerprint: null, candidateSetHash: null, candidateCount: 0, candidatesTruncated: false, candidates: [], nextCursor: null },
    });
  });
  await page.route(`**/records/receipts/${SCAN_ID}/confirm`, async (route) => {
    harness.confirmed.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: [{ id: 801 }] });
  });
  await page.route("**/records/search**", async (route) => { await route.fulfill({ json: { items: [], nextCursor: null } }); });
  await page.route("**/records/flagged/count**", async (route) => { await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }); });
  await loginViaUi(page);
  return harness;
}

const draftNotice = (page: Page) => page.getByRole("region", { name: "Unsaved review changes" });
const restoredNotice = (page: Page) => page.getByRole("status").filter({ hasText: "Your unsaved changes to this receipt were restored." });
const storedDraft = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), DRAFT_KEY);
const draftKeys = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("finsight.receiptReviewDraft.")));

async function openScanFromUnfinishedList(page: Page) {
  await page.getByRole("button", { name: `Review result, ${READ.vendor}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
}

async function expectFields(page: Page, values: { vendor: string; description: string; date: string; amount: string; category: string }) {
  await expect(page.locator("#vendor")).toHaveValue(values.vendor);
  await expect(page.locator("#description")).toHaveValue(values.description);
  await expect(page.locator("#date")).toHaveValue(values.date);
  await expect(page.locator("#amount")).toHaveValue(values.amount);
  await expect(page.locator("#category")).toHaveValue(values.category);
}

async function editReview(page: Page) {
  await page.locator("#vendor").fill(EDITED.vendor);
  await page.locator("#description").fill(EDITED.description);
  await page.locator("#date").fill(EDITED.date);
  await page.locator("#amount").fill(EDITED.amount);
  await page.locator("#category").selectOption(EDITED.category);
  await expect.poll(async () => JSON.parse((await storedDraft(page)) ?? "null")?.edits?.vendor).toBe(EDITED.vendor);
}

async function reloadToUploadScreen(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Scan a receipt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Continue an unfinished scan" })).toBeVisible();
}

test("a reload keeps review edits, and Discard changes returns to what was read", async ({ page }) => {
  const harness = await setUp(page);
  await page.goto("/records/receipts/new");
  await openScanFromUnfinishedList(page);
  await expectFields(page, { ...READ, category: "" });

  // Untouched review: no leave prompt on reload, and nothing stored.
  await reloadToUploadScreen(page);
  expect(harness.dialogs).toEqual([]);
  await expect(draftNotice(page)).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);

  await openScanFromUnfinishedList(page);
  await editReview(page);

  await reloadToUploadScreen(page);
  expect(harness.dialogs.map((dialog) => dialog.type)).toEqual(["beforeunload"]);

  await expect(draftNotice(page)).toBeVisible();
  await expect(draftNotice(page)).toContainText(`You have unsaved changes to ${READ.vendor}.`);
  await draftNotice(page).getByRole("button", { name: "Continue reviewing" }).click();
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
  await expect(restoredNotice(page)).toBeVisible();
  await expectFields(page, EDITED);

  // With edits on screen, an in-app link asks first; refusing keeps the review and its values.
  await page.getByRole("navigation").getByRole("link", { name: "Dashboard", exact: true }).first().click();
  expect(harness.dialogs.at(-1)).toEqual({ type: "confirm", message: "Leave this receipt review? Your unsaved changes will be lost." });
  await expect(page).toHaveURL(/\/records\/receipts\/new$/);
  await expectFields(page, EDITED);

  await restoredNotice(page).getByRole("button", { name: "Discard changes" }).click();
  const confirmDialog = page.getByRole("dialog", { name: "Discard your restored changes?" });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(page.getByText("Restored changes discarded.")).toBeVisible();
  await expect(restoredNotice(page)).toHaveCount(0);
  await expectFields(page, { ...READ, category: "" });
  expect(await storedDraft(page)).toBeNull();

  // Back to an untouched review: neither the reload prompt nor the kept-draft notice returns.
  const dialogsBefore = harness.dialogs.length;
  await reloadToUploadScreen(page);
  expect(harness.dialogs.length).toBe(dialogsBefore);
  await expect(draftNotice(page)).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);
});

test("an untouched review leaves through an in-app link without a prompt", async ({ page }) => {
  const harness = await setUp(page);
  await page.goto("/records/receipts/new");
  await openScanFromUnfinishedList(page);
  await page.getByRole("navigation").getByRole("link", { name: "Records", exact: true }).first().click();
  await expect(page).toHaveURL(/\/records$/);
  expect(harness.dialogs).toEqual([]);
});

test("confirming a restored review saves the edits and removes the draft", async ({ page }) => {
  const harness = await setUp(page);
  await page.goto("/records/receipts/new");
  await openScanFromUnfinishedList(page);
  await editReview(page);

  await reloadToUploadScreen(page);
  await draftNotice(page).getByRole("button", { name: "Continue reviewing" }).click();
  await expect(restoredNotice(page)).toBeVisible();
  await expectFields(page, EDITED);

  await page.getByRole("button", { name: "Confirm & save expense" }).click();
  await expect(page).toHaveURL(/\/records$/);
  expect(harness.confirmed).toHaveLength(1);
  expect(harness.confirmed[0]).toMatchObject({
    date: EDITED.date,
    vendor: EDITED.vendor,
    description: EDITED.description,
    amount: Number(EDITED.amount),
  });
  expect(await draftKeys(page)).toEqual([]);

  const dialogsBefore = harness.dialogs.length;
  await page.goto("/records/receipts/new");
  await expect(page.getByRole("heading", { name: "Continue an unfinished scan" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Continue an unfinished scan" })).toBeVisible();
  expect(harness.dialogs.length).toBe(dialogsBefore);
  await expect(draftNotice(page)).toHaveCount(0);

  await openScanFromUnfinishedList(page);
  await expect(restoredNotice(page)).toHaveCount(0);
  await expectFields(page, { ...READ, category: "" });
});
