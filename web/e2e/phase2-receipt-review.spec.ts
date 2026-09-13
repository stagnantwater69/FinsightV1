import { expect, test, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function receiptFile(name: string) {
  return { name, mimeType: "image/png", buffer: ONE_PIXEL_PNG };
}

function scanResult(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    receiptBatchId: null,
    receiptOrdinal: null,
    scanRevision: 0,
    processingStatus: "Complete",
    confirmationStatus: "Pending",
    processingError: null,
    processingErrorCode: null,
    extractedDate: "2026-09-13T00:00:00.000Z",
    extractedVendor: `Test merchant ${id}`,
    extractedDescription: `Receipt ${id}`,
    extractedAmount: 100,
    ocrConfidence: 91,
    items: [],
    warnings: [],
    pageQualities: [],
    pageProcessing: [],
    pageEvidence: [],
    ...overrides,
  };
}

function multipartField(body: string, name: string): string | null {
  return new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]+)`).exec(body)?.[1] ?? null;
}

async function chooseReceiptPhotos(page: Page, names: string[]) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Choose photos", { exact: true }).click(),
  ]);
  await chooser.setFiles(names.map(receiptFile));
}

async function mockReceiptHistory(page: Page) {
  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
      return;
    }
    await route.fallback();
  });
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
  // Signed evidence URLs are intentionally http(s)-only. Serve their image
  // bytes locally so this browser test never reaches a storage provider.
  await page.route("https://storage.example.test/**", async (route) => {
    await route.fulfill({ contentType: "image/png", body: ONE_PIXEL_PNG });
  });
  await mockReceiptHistory(page);
  await page.route(/\/records\/receipts\/\d+\/duplicate-candidates(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: { sourceFingerprint: null, candidateSetHash: null, candidates: [], nextCursor: null },
    });
  });
});

test("accepts a durable batch in ordinal order before opening the first review", async ({ page }) => {
  const events: string[] = [];
  const uploads: Array<{ batchId: string | null; ordinal: string | null }> = [];
  let uploadNumber = 0;
  let confirmed = 0;

  await page.route("**/records/receipt-batches", async (route) => {
    const body = route.request().postDataJSON();
    events.push("batch");
    expect(body).toMatchObject({ businessProfileId: 10, expectedReceiptCount: 2 });
    expect(body.clientBatchKey).toEqual(expect.any(String));
    await route.fulfill({
      status: 201,
      json: {
        id: 900,
        businessProfileId: 10,
        expectedReceiptCount: 2,
        status: "COLLECTING",
        uploadedReceiptCount: 0,
        createdAt: "2026-09-13T00:00:00.000Z",
        finishedAt: null,
        receipts: [],
      },
    });
  });
  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadNumber += 1;
    const body = route.request().postData() ?? "";
    events.push(`upload-${uploadNumber}`);
    uploads.push({
      batchId: multipartField(body, "receiptBatchId"),
      ordinal: multipartField(body, "receiptOrdinal"),
    });
    await route.fulfill({
      status: 202,
      json: scanResult(700 + uploadNumber, {
        receiptBatchId: 900,
        receiptOrdinal: uploadNumber,
        extractedVendor: `Batch merchant ${uploadNumber}`,
      }),
    });
  });
  await page.route(/\/records\/receipts\/70[12]\/confirm$/, async (route) => {
    confirmed += 1;
    await route.fulfill({ status: 201, json: [{ id: 800 + confirmed }] });
  });
  await page.route("**/records/search**", async (route) => {
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route("**/records/flagged/count**", async (route) => {
    await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["receipt-one.png", "receipt-two.png"]);
  await expect(page.getByText("2 separate receipts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan 2 receipts", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Check what FinSight read" })).toBeVisible();
  await expect(page.locator("#vendor")).toHaveValue("Batch merchant 1");
  expect(events).toEqual(["batch", "upload-1", "upload-2"]);
  expect(uploads).toEqual([
    { batchId: "900", ordinal: "1" },
    { batchId: "900", ordinal: "2" },
  ]);

  await page.locator("#category").selectOption("100");
  await page.getByRole("button", { name: "Confirm & save expense" }).click();
  await expect(page.locator("#vendor")).toHaveValue("Batch merchant 2");
  expect(events).toEqual(["batch", "upload-1", "upload-2"]);
  expect(uploads).toEqual([
    { batchId: "900", ordinal: "1" },
    { batchId: "900", ordinal: "2" },
  ]);

  await page.locator("#category").selectOption("100");
  await page.getByRole("button", { name: "Confirm & save expense" }).click();
  await expect(page).toHaveURL(/\/records$/);
  expect(confirmed).toBe(2);
});

test("rediscovers an accepted scan after reload and resumes review from stored evidence", async ({ page }) => {
  let historyRequests = 0;
  let sourceRequests = 0;
  let uploadRequests = 0;
  const stored = scanResult(710, {
    extractedVendor: "Reloaded merchant",
    pageEvidence: [{
      pageNumber: 1,
      captureMode: "standard",
      processingMode: "original",
      ocrInput: "source",
      source: { variant: "source", label: "Source", width: 1200, height: 1800 },
      derived: null,
    }],
  });

  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      uploadRequests += 1;
      await route.abort();
      return;
    }
    historyRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("businessProfileId")).toBe("10");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("take")).toBe("20");
    await route.fulfill({
      json: {
        items: [{
          id: 710,
          businessProfileId: 10,
          receiptBatchId: 900,
          receiptOrdinal: 2,
          scanRevision: 0,
          processingStatus: "Complete",
          confirmationStatus: "Pending",
          processingError: null,
          processingErrorCode: null,
          extractedDate: "2026-09-13T00:00:00.000Z",
          extractedVendor: "Reloaded merchant",
          extractedDescription: "Receipt 710",
          extractedAmount: 100,
          createdAt: "2026-09-13T08:30:00.000Z",
          pageCount: 1,
          allowedActions: { retryProcessing: false, reviewResult: true },
        }],
        nextCursor: null,
      },
    });
  });
  await page.route("**/records/receipts/710", async (route) => {
    await route.fulfill({ json: stored });
  });
  await page.route("**/records/receipts/710/pages/1/image/source", async (route) => {
    sourceRequests += 1;
    await route.fulfill({
      json: {
        pageNumber: 1,
        variant: "source",
        label: "Source",
        width: 1200,
        height: 1800,
        url: "https://storage.example.test/receipt-710?token=short-lived",
        expiresInSeconds: 600,
      },
    });
  });

  await page.goto("/records/receipts/new");
  await expect(page.getByRole("heading", { name: "Continue an unfinished scan" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Reloaded merchant", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review result", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Check what FinSight read" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Source, receipt page 1 of 1" })).toBeVisible();
  expect(historyRequests).toBeGreaterThanOrEqual(2);
  expect(sourceRequests).toBeGreaterThanOrEqual(1);
  expect(uploadRequests).toBe(0);
});

test("reload after the first batch review exposes later receipts that were already accepted", async ({ page }) => {
  let uploads = 0;
  const accepted = [
    scanResult(720, { receiptBatchId: 901, receiptOrdinal: 1, extractedVendor: "First accepted merchant" }),
    scanResult(721, { receiptBatchId: 901, receiptOrdinal: 2, extractedVendor: "Later accepted merchant" }),
  ];

  await page.route("**/records/receipt-batches", async (route) => {
    await route.fulfill({
      status: 201,
      json: {
        id: 901, businessProfileId: 10, expectedReceiptCount: 2, status: "COLLECTING",
        uploadedReceiptCount: 0, createdAt: "2026-09-13T00:00:00.000Z", finishedAt: null, receipts: [],
      },
    });
  });
  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const scan = accepted[uploads]!;
      uploads += 1;
      await route.fulfill({ status: 202, json: scan });
      return;
    }
    await route.fulfill({
      json: {
        items: accepted.map((scan) => ({
          ...scan,
          businessProfileId: 10,
          createdAt: "2026-09-13T08:30:00.000Z",
          pageCount: 0,
          allowedActions: { retryProcessing: false, reviewResult: true },
        })),
        nextCursor: null,
      },
    });
  });
  for (const scan of accepted) {
    await page.route(`**/records/receipts/${scan.id}`, async (route) => {
      await route.fulfill({ json: scan });
    });
  }

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["first-accepted.png", "later-accepted.png"]);
  await page.getByRole("button", { name: "Scan 2 receipts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check what FinSight read" })).toBeVisible();
  expect(uploads).toBe(2);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Continue an unfinished scan" })).toBeVisible();
  await expect(page.getByText("First accepted merchant", { exact: true })).toBeVisible();
  await expect(page.getByText("Later accepted merchant", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review result", exact: true }).nth(1).click();
  await expect(page.locator("#vendor")).toHaveValue("Later accepted merchant");
  expect(uploads).toBe(2);
});

test("keeps long-receipt pages separate and loads signed derived evidence for zoom", async ({ page }) => {
  let uploadBody = "";
  let derivedRequests = 0;
  const evidence = [1, 2].map((pageNumber) => ({
    pageNumber,
    captureMode: "long",
    processingMode: "enhanced_grayscale",
    ocrInput: "derived",
    source: { variant: "source", label: "Composite source", width: 1200, height: 1800 },
    derived: { variant: "derived", label: "Enhanced grayscale", width: 1000, height: 1600 },
  }));

  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadBody = route.request().postData() ?? "";
    await route.fulfill({
      status: 202,
      json: scanResult(720, {
        pageEvidence: evidence,
        pageProcessing: evidence.map((entry) => ({
          pageNumber: entry.pageNumber,
          source: "processed",
          hasProcessedVariant: true,
          captureMetadata: { captureMode: "long" },
        })),
      }),
    });
  });
  await page.route("**/records/receipts/720/pages/2/image/derived", async (route) => {
    derivedRequests += 1;
    await route.fulfill({
      json: {
        pageNumber: 2,
        variant: "derived",
        label: "Enhanced grayscale",
        width: 1000,
        height: 1600,
        url: "https://storage.example.test/receipt-720-derived?token=short-lived",
        expiresInSeconds: 600,
      },
    });
  });
  await page.route("**/records/receipts/720/pages/*/image/source", async (route) => {
    const pageNumber = Number(new URL(route.request().url()).pathname.split("/").at(-3));
    await route.fulfill({
      json: {
        pageNumber,
        variant: "source",
        label: "Composite source",
        width: 1200,
        height: 1800,
        url: `https://storage.example.test/receipt-720-source-${pageNumber}?token=short-lived`,
        expiresInSeconds: 600,
      },
    });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["long-top.png", "long-bottom.png"]);
  await page.getByText("One long receipt (2 pages)", { exact: true }).click();
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();

  const pages = page.getByRole("tablist", { name: "Receipt pages" });
  await expect(pages.getByRole("tab")).toHaveCount(2);
  await pages.getByRole("tab", { name: "View page 2 of 2" }).click();
  await expect(page.getByRole("button", { name: "Composite source", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Enhanced grayscale", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enhanced grayscale", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(derivedRequests).toBe(1);

  await page.getByRole("button", { name: "Enlarge enhanced grayscale, receipt page 2 of 2" }).click();
  const dialog = page.getByRole("dialog", { name: "Enlarged enhanced grayscale, receipt page 2 of 2" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  expect((uploadBody.match(/name="files"/g) ?? [])).toHaveLength(2);
  expect(uploadBody).not.toContain('name="receiptBatchId"');
  expect(uploadBody).not.toContain('name="receiptOrdinal"');
});

test("retries failed processing from the accepted scan without uploading the image again", async ({ page }) => {
  let uploadRequests = 0;
  let retryRequests = 0;

  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadRequests += 1;
    await route.fulfill({
      status: 202,
      json: scanResult(730, {
        processingStatus: "Failed",
        processingError: "The stored receipt could not be read.",
      }),
    });
  });
  await page.route("**/records/receipts/730/retry", async (route) => {
    retryRequests += 1;
    expect(route.request().postData()).toBeNull();
    await route.fulfill({ status: 202, json: scanResult(730) });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["failed.png"]);
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Receipt needs another try" })).toBeVisible();

  await page.getByRole("button", { name: "Retry processing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check what FinSight read" })).toBeVisible();
  expect(uploadRequests).toBe(1);
  expect(retryRequests).toBe(1);
});

test("shows possible duplicates before save and sends an explicit Save anyway decision", async ({ page }) => {
  const candidateSetHash = "a".repeat(64);
  const confirmBodies: unknown[] = [];

  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 202, json: scanResult(733) });
  });
  await page.route("**/records/receipts/733/duplicate-candidates**", async (route) => {
    await route.fulfill({
      json: {
        sourceFingerprint: "b".repeat(64),
        candidateSetHash,
        candidates: [{
          id: 91,
          target: { kind: "expense", id: 410 },
          vendor: "Earlier merchant",
          date: "2026-09-13T00:00:00.000Z",
          total: 100,
          scoreBand: "EXACT",
          reasons: ["SAME_VENDOR", "SAME_DATE", "SAME_TOTAL"],
        }],
        nextCursor: null,
      },
    });
  });
  await page.route("**/records/receipts/733/confirm", async (route) => {
    confirmBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: [{ id: 411 }] });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["possible-duplicate.png"]);
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Possible duplicate receipt" })).toBeVisible();
  await expect(page.getByText("Earlier merchant", { exact: true })).toBeVisible();
  await expect(page.getByText(/same merchant, same date, same total/i)).toBeVisible();
  await page.locator("#category").selectOption("100");
  const saveAnyway = page.getByRole("button", { name: "Save anyway", exact: true });
  await expect(saveAnyway).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed these matches/ }).check();
  await expect(saveAnyway).toBeEnabled();
  await saveAnyway.click();

  await expect(page).toHaveURL(/\/records$/);
  expect(confirmBodies).toHaveLength(1);
  expect(confirmBodies[0]).toMatchObject({
    duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash },
  });
});

test("confirms deletion and reuses the cleanup idempotency key after a network failure", async ({ page }) => {
  const deleteKeys: string[] = [];
  let deleteAttempts = 0;

  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 202,
      json: scanResult(735, {
        processingStatus: "Failed",
        processingError: "The stored receipt could not be read.",
      }),
    });
  });
  await page.route("**/records/receipts/735", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleteAttempts += 1;
    deleteKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (deleteAttempts === 1) {
      await route.abort("connectionfailed");
      return;
    }
    await route.fulfill({
      status: 202,
      json: {
        id: 501,
        receiptScanId: 735,
        reason: "OWNER_REQUEST",
        status: "PENDING",
        stage: "STORAGE",
        storageObjectsExpected: 1,
        storageObjectsDeleted: 0,
        requestedAt: "2026-09-13T00:00:00.000Z",
        completedAt: null,
        lastErrorCode: null,
      },
    });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["failed-delete.png"]);
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Receipt needs another try" })).toBeVisible();

  for (const attempt of [1, 2]) {
    await page.getByRole("button", { name: "Delete scan", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Test merchant 735?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete scan", exact: true }).click();
    if (attempt === 1) await expect(page.getByRole("alert")).toBeVisible();
  }

  await expect(page.getByRole("heading", { name: "Scan a receipt" })).toBeVisible();
  expect(deleteKeys).toHaveLength(2);
  expect(deleteKeys[0]).not.toBe("");
  expect(deleteKeys[1]).toBe(deleteKeys[0]);
});

test("refreshes a stale scan revision while preserving the owner's item draft", async ({ page }) => {
  const rice = {
    id: 41,
    lineNumber: 1,
    name: "Rice",
    quantity: 1,
    unitPrice: 100,
    amount: 100,
    categoryId: 100,
    amountConfidence: 90,
  };
  const oil = {
    id: 42,
    lineNumber: 2,
    name: "Oil",
    quantity: 1,
    unitPrice: 50,
    amount: 50,
    categoryId: 100,
    amountConfidence: 90,
  };
  const initial = scanResult(740, { extractedAmount: 150, items: [rice, oil] });
  const latest = scanResult(740, {
    scanRevision: 1,
    extractedAmount: 150,
    items: [{ ...rice, name: "Rice from another request" }, oil],
  });
  const patchBodies: unknown[] = [];

  await page.route(/\/records\/receipts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 202, json: initial });
  });
  await page.route("**/records/receipts/740", async (route) => {
    await route.fulfill({ json: latest });
  });
  await page.route("**/records/receipts/740/items/41", async (route) => {
    const body = route.request().postDataJSON();
    patchBodies.push(body);
    if (patchBodies.length === 1) {
      await route.fulfill({ status: 409, json: { error: "Receipt scan changed" } });
      return;
    }
    await route.fulfill({
      json: scanResult(740, {
        scanRevision: 2,
        extractedAmount: 170.5,
        items: [{ ...rice, name: "Premium rice", amount: 120.5, ownerEditedFields: ["name", "amount"] }, oil],
      }),
    });
  });

  await page.goto("/records/receipts/new");
  await chooseReceiptPhotos(page, ["editable.png"]);
  await page.getByRole("button", { name: "Scan receipt", exact: true }).click();
  await page.getByRole("button", { name: "Edit Rice", exact: true }).click();
  await page.getByLabel("Item name").fill("Premium rice");
  await page.getByLabel("Item amount").fill("120.5");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText(/receipt changed in another request/i)).toBeVisible();
  await expect(page.getByLabel("Item name")).toHaveValue("Premium rice");
  await expect(page.getByLabel("Item amount")).toHaveValue("120.5");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("button", { name: "Edit Premium rice", exact: true })).toBeVisible();
  await expect(page.getByText("Corrected by you", { exact: true })).toBeVisible();
  expect(patchBodies).toEqual([
    { name: "Premium rice", amount: 120.5, expectedScanRevision: 0 },
    { name: "Premium rice", amount: 120.5, expectedScanRevision: 1 },
  ]);
});
