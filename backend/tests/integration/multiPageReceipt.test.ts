import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Storage is mocked the same way receiptScan.test.ts mocks it, except the
 * upload mock returns a DIFFERENT path per call — the real function already
 * does this (a random UUID per upload), and a test asserting page ORDER needs
 * distinguishable paths to assert against.
 */
const { uploadCallCount } = vi.hoisted(() => ({ uploadCallCount: { value: 0 } }));
vi.mock("../../src/services/storage.service", () => ({
  uploadReceiptImage: vi.fn(async () => `1/mock-page-${++uploadCallCount.value}.jpg`),
  downloadReceiptImage: vi.fn(async () => Buffer.from("stored-page")),
  uploadCsvFile: vi.fn(async () => "1/mock.csv"),
  signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed.jpg"),
}));

/*
 * extractReceipt is driven by a QUEUE of {text, confidence} results consumed
 * one per call — one call happens per page, in page order — so a test can
 * give page 1 and page 2 different text and different confidence, which is
 * exactly what the concatenation and worst-page-confidence behaviour this
 * file tests need to control independently.
 */
const { pageQueue } = vi.hoisted(() => ({
  pageQueue: [] as { text: string; confidence: number }[],
}));
vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractReceipt: async () => {
      const next = pageQueue.shift() ?? { text: "", confidence: 95 };
      return { text: next.text, confidence: next.confidence, lines: [] };
    },
  };
});

const { categoriseMock } = vi.hoisted(() => ({ categoriseMock: vi.fn() }));
vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, categoriseReceiptItems: categoriseMock };
});

const { visionMock } = vi.hoisted(() => ({ visionMock: vi.fn() }));
vi.mock("../../src/services/visionOcr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/visionOcr.service")>();
  return { ...actual, extractReceiptWithVision: visionMock };
});

import { prisma } from "../../src/config/prisma";
import * as ocrService from "../../src/services/ocr.service";
import { confirmReceipt, getScan, uploadAndScan, MAX_PAGES, runReceiptWorkerOnce } from "../../src/services/receiptScan.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString, waitForScanProcessing } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 }, [
    "Inventory",
  ]);
  uploadCallCount.value = 0;
  pageQueue.length = 0;
  categoriseMock.mockReset();
  categoriseMock.mockResolvedValue([]);
  visionMock.mockReset();
  visionMock.mockResolvedValue(null);
});

afterAll(disconnectDb);

function page(text: string, confidence = 95) {
  return { buffer: Buffer.from(`fake-bytes-${text.length}`), mimetype: "image/jpeg", originalname: "page.jpg" };
}

/**
 * Uploads pages and returns the scan once its background read has finished —
 * see waitForScanProcessing. Polling mirrors what both clients do, so these
 * assertions exercise the real upload-then-poll contract.
 */
async function uploadPages(texts: { text: string; confidence?: number }[]) {
  for (const t of texts) pageQueue.push({ text: t.text, confidence: t.confidence ?? 95 });
  const created = await uploadAndScan(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    pages: texts.map((t) => page(t.text)),
  });
  await waitForScanProcessing(created.id);
  return getScan(ctx.user.id, created.id);
}

describe("multi-page receipt upload", () => {
  it("reconciles items spanning one page against a total printed on another", async () => {
    // The exact shape a long receipt takes: items on page 1, the total only
    // appears once everything has been rung up, on page 2.
    const scan = await uploadPages([
      { text: ["ABC STORE", "Date: 2026-07-20", "Rice 25kg    1220.00", "Cooking oil   180.00"].join("\n") },
      { text: ["TOTAL   1400.00"].join("\n") },
    ]);

    expect(scan.extractedAmount).toBe(1400);
    // Both items were read even though neither page contains BOTH of them
    // plus the total — proof the parser saw one concatenated document, not
    // two independent ones.
    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(items.map((i) => i.name).sort()).toEqual(["Cooking oil", "Rice 25kg"]);
  });

  it("stores one ReceiptScanPage row per page, in order, with the cover as page 1", async () => {
    const scan = await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00" },
      { text: "Item B   20.00" },
      { text: "TOTAL   30.00" },
    ]);

    const pages = await prisma.receiptScanPage.findMany({
      where: { receiptScanId: scan.id },
      orderBy: { pageNumber: "asc" },
    });
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(pages.map((p) => p.imageFile)).toEqual(["1/mock-page-1.jpg", "1/mock-page-2.jpg", "1/mock-page-3.jpg"]);
    expect(scan.imageFile).toBe(pages[0]!.imageFile);
  });

  it("rejects more than MAX_PAGES photographs", async () => {
    const texts = Array.from({ length: MAX_PAGES + 1 }, (_, i) => ({ text: `Item ${i}   1.00` }));
    await expect(uploadPages(texts)).rejects.toMatchObject({ status: 400 });
  });

  it("accepts exactly MAX_PAGES photographs", async () => {
    const texts = Array.from({ length: MAX_PAGES }, (_, i) => ({ text: `Item ${i}   1.00` }));
    await expect(uploadPages(texts)).resolves.toMatchObject({ confirmationStatus: "Pending" });
  });

  it("rejects an upload with no pages", async () => {
    await expect(
      uploadAndScan(ctx.user.id, { businessProfileId: ctx.profile.id, pages: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/**
 * The read now finishes AFTER the response. These pin the states that
 * behaviour introduces — a client that polls has to be able to tell "still
 * working" from "finished" from "gave up", and must never be handed a
 * half-written scan as though it were done.
 */
describe("background processing", () => {
  it("returns before the read has finished, with the scan already pollable", async () => {
    pageQueue.push({ text: "Date: 2026-07-20\nItem A 10.00\nTOTAL 10.00", confidence: 95 });
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("x")],
    });

    // The row exists and is addressable immediately — that is what makes
    // polling possible at all.
    expect(created.id).toBeGreaterThan(0);
    expect(created.confirmationStatus).toBe("Pending");
    // Its page rows exist too, so the client can show what it uploaded while
    // it waits.
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: created.id } })).toBe(1);

    await waitForScanProcessing(created.id);
  });

  it("reaches Complete, and only then carries the extracted fields", async () => {
    pageQueue.push({ text: "ABC STORE\nDate: 2026-07-20\nRice 25kg 1220.00\nTOTAL 1220.00", confidence: 95 });
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("x")],
    });

    expect(await waitForScanProcessing(created.id)).toBe("Complete");

    const done = await getScan(ctx.user.id, created.id);
    expect(done.processingStatus).toBe("Complete");
    expect(done.processingError).toBeNull();
    expect(done.extractedAmount).toBe(1220);
  });

  it("records a failed attempt and durably retries it from Storage", async () => {
    const boom = new Error("tesseract exploded");
    const spy = vi.spyOn(ocrService, "extractReceipt").mockRejectedValueOnce(boom);

    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("x")],
    });

    let queued = await getScan(ctx.user.id, created.id);
    for (let i = 0; i < 50 && !queued.processingError; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      queued = await getScan(ctx.user.id, created.id);
    }
    expect(queued.processingStatus).toBe("Processing");
    expect(queued.processingError).toContain("tesseract exploded");

    // Make the backoff due now. The next worker has no request buffer, so its
    // success proves the page was reconstructed from durable Storage.
    pageQueue.push({ text: "ABC STORE\nItem A 10.00\nTOTAL 10.00", confidence: 95 });
    await prisma.receiptScan.update({ where: { id: created.id }, data: { nextProcessingAttemptAt: new Date(0) } });
    expect(await runReceiptWorkerOnce()).toBe(true);
    expect((await getScan(ctx.user.id, created.id)).processingStatus).toBe("Complete");
    spy.mockRestore();
  });

  it("refuses to confirm a receipt that is still being read", async () => {
    // Not reachable through the clients, which only show the confirm screen
    // once polling reports Complete — but confirming mid-read would race the
    // background write and could validate a split against items that do not
    // exist yet.
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: ctx.profile.id,
        imageFile: "1/mid-read.jpg",
        confirmationStatus: "Pending",
        processingStatus: "Processing",
      },
    });

    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(0),
        description: "Anything",
        amount: 100,
        splits: [{ categoryId: ctx.categories.Inventory!, amount: 100 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to confirm a receipt whose read failed", async () => {
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: ctx.profile.id,
        imageFile: "1/failed.jpg",
        confirmationStatus: "Pending",
        processingStatus: "Failed",
        processingError: "could not be read",
      },
    });

    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(0),
        description: "Anything",
        amount: 100,
        splits: [{ categoryId: ctx.categories.Inventory!, amount: 100 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not hand another owner's scan to a poller", async () => {
    const other = await makeOwnerWithProfile();
    pageQueue.push({ text: "TOTAL 10.00", confidence: 95 });
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("x")],
    });
    await waitForScanProcessing(created.id);

    // 404 rather than 403, matching the non-disclosure rule used everywhere
    // else — a poller must not be able to confirm a scan id even exists.
    await expect(getScan(other.user.id, created.id)).rejects.toMatchObject({ status: 404 });
  });

  /**
   * The design decision rescueWithVision's own comment states: the WORST
   * page decides whether the model gets asked, not an average. Chosen so the
   * two readings actually disagree — average(95, 60) is 77.5, ABOVE
   * LOW_CONFIDENCE (75), so an average-based trigger would stay silent here;
   * min(95, 60) is 60, below it. If this test passes under both an average
   * and a minimum implementation, it is not testing the claim at all.
   */
  it("triggers the vision rescue on the worst page even when the average would look fine", async () => {
    await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00\nTOTAL 30.00", confidence: 95 },
      { text: "Item B   20.00", confidence: 60 }, // reconciles, so only confidence can trigger this
    ]);

    expect(visionMock).toHaveBeenCalledTimes(1);
  });

  it("does not trigger the vision rescue when every page reads well and reconciles", async () => {
    await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00", confidence: 92 },
      { text: "Item B   20.00\nTOTAL 30.00", confidence: 90 },
    ]);

    expect(visionMock).not.toHaveBeenCalled();
  });

  it("sends every page to the vision model in a single call, not one call per page", async () => {
    // does-not-add-up trigger: forces the rescue so the call shape can be
    // inspected.
    await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00" },
      { text: "Item B   20.00\nTOTAL 999.00" },
    ]);

    expect(visionMock).toHaveBeenCalledTimes(1);
    const [pagesArg] = visionMock.mock.calls[0]!;
    expect(pagesArg).toHaveLength(2);
  });

  it("flags adjacent pages that look like the same page shot twice", async () => {
    const scan = await uploadPages([
      { text: "ABC STORE\nDate: 2026-07-20\nItem A   10.00\nTOTAL 10.00" },
      // A near-identical re-photograph of the SAME page (one OCR noise line).
      { text: "ABC STORE\nDate: 2026-07-2O\nItem A   10.00\nTOTAL 10.00" },
    ]);

    expect(scan.duplicatePages).toEqual([2]);
  });

  it("does not flag genuinely different pages of one receipt", async () => {
    const scan = await uploadPages([
      { text: "ABC STORE\nDate: 2026-07-20\nItem A   10.00" },
      { text: "Item B   20.00\nTOTAL 30.00" },
    ]);

    expect(scan.duplicatePages).toEqual([]);
  });

  it("returns one quality reading per page", async () => {
    const scan = await uploadPages([{ text: "Item A 1.00" }, { text: "Item B 2.00" }, { text: "TOTAL 3.00" }]);
    expect(scan.pageQualities).toHaveLength(3);
  });
});

/**
 * Overlapping sections — the shape the receipt camera actually produces.
 *
 * The capture guide asks the owner to re-photograph the last 15-25% of the
 * previous section so they can see where to continue, which means a few item
 * lines are read twice. These assert the rule the pipeline settles that with:
 * the de-overlapped reading is used ONLY when the plain one fails to account
 * for the receipt's printed total and the de-overlapped one does. Everything
 * else keeps the full reading and lets the owner see it.
 */
describe("sections photographed with an overlap", () => {
  it("counts an overlapping item once when that is what makes the total work", async () => {
    const scan = await uploadPages([
      { text: ["ABC STORE", "Date: 2026-07-20", "Rice 25kg   1220.00", "Cooking oil   180.00"].join("\n") },
      // Photographed starting from the previous section's last line, exactly
      // as the overlap guide asks.
      { text: ["Cooking oil   180.00", "Sugar 1kg   75.00", "TOTAL   1475.00"].join("\n") },
    ]);

    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(items.filter((i) => i.name === "Cooking oil")).toHaveLength(1);
    // And the arithmetic that earned the removal actually holds.
    const summed = items.reduce((total, i) => total + Number(i.amount), 0);
    expect(summed).toBe(1475);
    expect(scan.extractedAmount).toBe(1475);
  });

  it("reports the overlap so the confirm screen can explain the repeated lines", async () => {
    const scan = await uploadPages([
      { text: ["ABC STORE", "Date: 2026-07-20", "Rice 25kg   1220.00", "Cooking oil   180.00"].join("\n") },
      { text: ["Cooking oil   180.00", "Sugar 1kg   75.00", "TOTAL   1475.00"].join("\n") },
    ]);

    expect(scan.overlappingPages).toEqual([2]);
    // Distinct from a page shot twice by mistake, which is a different
    // sentence with a different remedy.
    expect(scan.duplicatePages).toEqual([]);
  });

  it("says nothing about sections that do not overlap", async () => {
    const scan = await uploadPages([
      { text: "ABC STORE\nDate: 2026-07-20\nItem A   10.00" },
      { text: "Item B   20.00\nTOTAL 30.00" },
    ]);

    expect(scan.overlappingPages).toEqual([]);
  });

  /**
   * THE ONE THAT PROTECTS MONEY.
   *
   * Where removing the overlap does NOT make the arithmetic work — here a
   * middle section was never photographed, so the items fall short of the
   * total either way — there is no evidence the removal helped. The full
   * reading has to stand and the gap has to reach the owner, because a
   * duplicate they can see and delete beats a real purchase deleted quietly.
   */
  it("keeps every line when dropping the overlap does not settle the total", async () => {
    const scan = await uploadPages([
      { text: ["ABC STORE", "Date: 2026-07-20", "Rice 25kg   1220.00", "Cooking oil   180.00"].join("\n") },
      // Overlaps page 1, but a whole section of purchases is missing between
      // this and the printed total.
      { text: ["Cooking oil   180.00", "TOTAL   9999.00"].join("\n") },
    ]);

    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(items.filter((i) => i.name === "Cooking oil")).toHaveLength(2);
    expect(scan.overlappingPages).toEqual([2]);
  });

  /**
   * The audit trail must never lose a line this chose not to count. rawText
   * is what the origin panel shows and what any later correction reads.
   */
  it("stores the full unedited text even when it counted fewer items", async () => {
    const scan = await uploadPages([
      { text: ["ABC STORE", "Date: 2026-07-20", "Rice 25kg   1220.00", "Cooking oil   180.00"].join("\n") },
      { text: ["Cooking oil   180.00", "Sugar 1kg   75.00", "TOTAL   1475.00"].join("\n") },
    ]);

    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.rawText!.match(/Cooking oil/g)).toHaveLength(2);
  });
});
