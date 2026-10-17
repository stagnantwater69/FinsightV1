import { expect, test, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function conversation(id: number, title: string) {
  return { id, title, originModule: "Dashboard", createdAt: "2026-10-13T00:00:00Z", lastMessageAt: "2026-10-13T00:00:00Z" };
}
function message(id: number, content: string, role = "assistant") {
  return { id, content, role, createdAt: "2026-10-13T00:00:00Z", feedback: null };
}
async function target(locator: Locator, name: string, measurements: unknown[]) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds, name).not.toBeNull();
  expect(bounds!.width, `${name} width`).toBeGreaterThanOrEqual(44);
  expect(bounds!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  measurements.push({ name, ...bounds });
}

for (const width of [320, 1440]) for (const theme of ["classic", "light", "dark"] as const) {
  test(`development recovery and history controls at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const measurements: unknown[] = [];
    const external: string[] = [];
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.fallback();
      external.push(`${route.request().method()} ${url.hostname}${url.pathname}`);
      await route.abort("blockedbyclient");
    });
    await page.addInitScript((chosen) => localStorage.setItem("finsight.theme", chosen), theme);
    await skipTour(page); await mockSupabaseAuth(page); await mockBackendSession(page);
    let failFindings = true;
    let failSearch = true;
    const importQueries: Record<string, string>[] = [];
    const expenseRows = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, type: "expense", businessProfileId: 10, categoryId: 100, description: `Synthetic expense ${index + 1}`, date: "2026-10-13T00:00:00Z", amount: 12.34, source: "MANUAL_ENTRY", reviewStatus: "Reviewed", duplicateStatus: "Not Duplicate" }));
    await page.route("**/records/search**", async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("limit") === "6") {
        if (failSearch) return route.fulfill({ status: 503, json: { error: "Synthetic record search unavailable." } });
        return route.fulfill({ json: { items: [{ ...expenseRows[0], description: "Inventory supplier result" }], nextCursor: null } });
      }
      await route.fulfill({ json: { items: expenseRows, nextCursor: null } });
    });
    await page.route("**/records/flagged/count**", (route) => route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }));
    await page.route(/\/api\/v1\/records\/flagged(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.route("**/insights/findings**", (route) => route.fulfill(failFindings ? { status: 503, json: { error: "Synthetic spending checks unavailable." } } : { json: { items: [], nextCursor: null } }));
    await page.route("**/records/csv-imports/batches**", async (route) => {
      const query = Object.fromEntries(new URL(route.request().url()).searchParams); importQueries.push(query);
      await route.fulfill({ json: query.search ? { items: [{ id: 3, title: "March sales", uploadDate: "2026-03-01T00:00:00Z" }], nextCursor: null }
        : query.cursor ? { items: [{ id: 2, title: "Earlier import", uploadDate: "2026-09-01T00:00:00Z" }], nextCursor: null }
        : { items: [{ id: 1, title: "Newest import", uploadDate: "2026-10-13T00:00:00Z" }], nextCursor: "older-import" } });
    });
    await loginViaUi(page);
    await page.route(/\/ai\/conversations(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/records?source=CSV_UPLOAD&importBatchId=999");
    await expect(page.getByLabel("Which import")).toHaveValue("999");
    await page.getByRole("button", { name: "Older imports" }).click();
    await expect(page.getByRole("option", { name: /Earlier import/ })).toHaveCount(1);
    await page.getByLabel("Find an import").fill("March");
    await expect(page.getByRole("option", { name: /March sales/ })).toHaveCount(1);
    await expect(page.getByLabel("Which import")).toHaveValue("999");
    expect(importQueries.some((query) => query.pageSize === "50" && query.cursor === "older-import")).toBe(true);
    expect(importQueries.some((query) => query.search === "March" && !query.cursor)).toBe(true);
    await target(page.getByRole("button", { name: "Next page", exact: true }), "pagination next", measurements);
    if (width >= 640) await target(page.getByRole("button", { name: "Page 2", exact: true }), "pagination number", measurements);
    const edit = page.getByRole("button", { name: "Edit Synthetic expense 1", exact: true }).filter({ visible: true });
    await target(edit, "record edit", measurements);
    await target(page.getByRole("button", { name: "Duplicate Synthetic expense 1", exact: true }).filter({ visible: true }), "record duplicate", measurements);
    await target(page.getByRole("button", { name: "Delete Synthetic expense 1", exact: true }).filter({ visible: true }), "record delete", measurements);
    const rowBoxes = measurements.filter((item) => (item as { name: string }).name.startsWith("record ")) as { x: number; y: number; width: number; height: number }[];
    for (let first = 0; first < rowBoxes.length; first++) for (let second = first + 1; second < rowBoxes.length; second++) {
      const a = rowBoxes[first]!; const b = rowBoxes[second]!;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "record controls do not overlap").toBe(true);
    }
    await page.getByRole("button", { name: "+ Add expense", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add expense" });
    await target(dialog.getByRole("button", { name: "Close", exact: true }), "modal close", measurements);
    await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();

    await page.goto("/records/flagged");
    await expect(page.getByText("Review checks are incomplete", { exact: true })).toBeVisible();
    await expect(page.getByText("Nothing needs review", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Some spending checks couldn't load" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("incomplete-review.png"), fullPage: true });
    failFindings = false;
    await page.getByRole("button", { name: "Retry review checks" }).click();
    await expect(page.getByText("Nothing needs review", { exact: true })).toBeVisible();
    if (width < 768) await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByRole("combobox", { name: "Search FinSight" }).filter({ visible: true });
    await search.fill("Inventory");
    await expect(page.getByRole("alert").filter({ hasText: "Synthetic record search unavailable." })).toBeVisible();
    await expect(page.getByRole("option", { name: /Inventory View its records/ })).toBeVisible();
    failSearch = false;
    await page.getByRole("button", { name: "Retry record search" }).click();
    await expect(page.getByRole("option", { name: /Inventory supplier result/ })).toBeVisible();
    await search.fill("ask");
    await expect(page.getByRole("option", { name: /Ask FinSight/ })).toBeVisible();
    await search.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Ask FinSight" });
    await expect(drawer).toBeVisible();
    await page.getByRole("button", { name: "Close Ask FinSight" }).click();

    const latest = conversation(1, "Latest chat"); const older = conversation(2, "Older chat");
    let questionBody: Record<string, unknown> | null = null;
    let sends = 0; let checks = 0;
    await page.route(/\/ai\/conversations(?:\?.*)?$/, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      await route.fulfill({ json: { items: cursor ? [older] : [latest], nextCursor: cursor ? null : "older-chat" } });
    });
    await page.route(/\/ai\/conversations\/\d+(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url()); const id = Number(url.pathname.split("/").pop());
      await route.fulfill({ json: { ...(id === 1 ? latest : older), messages: url.searchParams.get("cursor") ? [message(20, "Earlier saved answer")] : [message(21, "Latest saved answer")], nextCursor: url.searchParams.get("cursor") ? null : "older-message" } });
    });
    await page.route(/\/ai\/conversations\/2\/messages$/, async (route) => {
      sends++; questionBody = route.request().postDataJSON(); await route.abort("failed");
    });
    await page.route("**/ai/send-requests/**", async (route) => {
      checks++;
      expect(new URL(route.request().url()).searchParams.get("businessProfileId")).toBe("10");
      expect(route.request().url()).toContain(String(questionBody?.idempotencyKey));
      await route.fulfill({ json: { status: "COMPLETE", result: { conversation: older, userMessage: message(31, "Original browser question", "user"), assistantMessage: message(32, "Recovered browser answer"), provider: "gemini", detectedAmount: null }, error: null } });
    });
    // Reload starts a fresh provider so the earlier search-open cannot cache an unmocked history error.
    await page.reload();
    if (width < 768) await page.getByRole("button", { name: "Search", exact: true }).click();
    const assistantSearch = page.getByRole("combobox", { name: "Search FinSight" }).filter({ visible: true });
    await assistantSearch.fill("ask"); await assistantSearch.press("Enter");
    await page.getByRole("button", { name: "Chat history", exact: true }).click();
    await page.getByRole("button", { name: "Older conversations", exact: true }).click();
    const options = page.getByRole("button", { name: "More options for Older chat", exact: true });
    await target(options, "conversation menu", measurements);
    await target(page.getByRole("button", { name: "Close chat history", exact: true }), "history close", measurements);
    await options.click();
    await target(page.getByRole("menuitem", { name: "Rename", exact: true }), "conversation rename", measurements);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat history", exact: true }).click();
    await page.getByRole("button", { name: "Older chat", exact: true }).click();
    await page.getByRole("button", { name: "Older messages", exact: true }).click();
    await expect(page.getByText("Earlier saved answer", { exact: true })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Ask about your numbers" });
    await composer.fill("Original browser question"); await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Check answer status", exact: true })).toBeVisible();
    await composer.fill("New draft after response loss");
    await page.getByRole("button", { name: "Check answer status", exact: true }).click();
    await expect(page.getByText("Recovered browser answer", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("New draft after response loss");
    expect(sends).toBe(1); expect(checks).toBe(1);
    await page.keyboard.press("Escape");

    const scan = { id: 720, scanRevision: 0, processingStatus: "Complete", confirmationStatus: "Pending", processingError: null, processingErrorCode: null,
      extractedDate: "2026-10-13T00:00:00Z", extractedVendor: "Synthetic shop", extractedDescription: "Synthetic supplies", extractedAmount: 22.34, ocrConfidence: 91,
      items: [{ id: 1, lineNumber: 1, name: "Synthetic rice", quantity: 1, unitPrice: 12.34, amount: 12.34, categoryId: 100 }, { id: 2, lineNumber: 2, name: "Synthetic oil", quantity: 1, unitPrice: 10, amount: 10, categoryId: 100 }], itemsSubtotal: 22.34, warnings: [], pageQualities: [], pageProcessing: [], pageEvidence: [] };
    await page.route(/\/records\/receipts(?:\?.*)?$/, (route) => route.fulfill(route.request().method() === "GET" ? { json: { items: [], nextCursor: null } } : { status: 202, json: scan }));
    await page.route(/\/records\/receipts\/720\/duplicate-candidates(?:\?.*)?$/, (route) => route.fulfill({ json: { sourceFingerprint: null, candidateSetHash: null, candidateCount: 0, candidatesTruncated: false, candidates: [], nextCursor: null } }));
    await page.goto("/records/receipts/new");
    await page.getByLabel(/Receipt photo/).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: PNG });
    await target(page.getByRole("button", { name: "Remove page 1", exact: true }), "receipt thumbnail remove", measurements);
    await page.getByRole("button", { name: "Remove page 1", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove page 1", exact: true })).toHaveCount(0);
    await page.getByLabel(/Receipt photo/).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: /^Scan receipt/ }).click();
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await target(page.getByRole("button", { name: /^Remove Synthetic rice/ }), "receipt row remove", measurements);
    await page.getByRole("button", { name: /^Remove Synthetic rice/ }).click();
    await expect(page.getByRole("heading", { name: 'Remove "Synthetic rice"?' })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Remove Synthetic rice/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("receipt-review.png"), fullPage: true });
    await page.route("**/api/v1/dashboard/**", (route) => route.fulfill({ status: 503, json: { error: "Synthetic dashboard unavailable." } }));
    await page.goto("/account-settings");
    await page.getByRole("button", { name: "Start Guided Tour", exact: true }).click();
    await target(page.getByRole("button", { name: "Close tour", exact: true }), "tour close", measurements);
    await page.getByRole("button", { name: "Close tour", exact: true }).click();
    await page.getByRole("button", { name: "Skip tour", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(external).toEqual([]);
    await writeFile(testInfo.outputPath("target-measurements.json"), JSON.stringify(measurements, null, 2));
    await testInfo.attach("target-measurements", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("tour-dismissed.png"), fullPage: true });
  });
}
