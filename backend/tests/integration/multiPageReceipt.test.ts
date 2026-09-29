import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/*
 * Storage is mocked the same way receiptScan.test.ts mocks it, except the
 * upload mock returns a DIFFERENT path per call — the real function already
 * does this (a random UUID per upload), and a test asserting page ORDER needs
 * distinguishable paths to assert against.
 */
const {
  uploadCallCount,
  uploadFailureAt,
  deletedReceiptPaths,
  sourceOcrResults,
  storedOcrResults,
  downloadedOcrResults,
} = vi.hoisted(() => ({
  uploadCallCount: { value: 0 },
  uploadFailureAt: { value: null as number | null },
  deletedReceiptPaths: [] as string[],
  sourceOcrResults: new WeakMap<Buffer, { text: string; confidence: number }>(),
  storedOcrResults: new Map<string, { text: string; confidence: number }>(),
  downloadedOcrResults: new WeakMap<Buffer, { text: string; confidence: number }>(),
}));
vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    uploadReceiptImage: vi.fn(async (_businessProfileId: number, buffer: Buffer) => {
      const call = ++uploadCallCount.value;
      if (uploadFailureAt.value === call) throw new Error("storage upload failed");
      const path = `1/mock-page-${call}.jpg`;
      const ocrResult = sourceOcrResults.get(buffer);
      if (ocrResult) storedOcrResults.set(path, ocrResult);
      return path;
    }),
    inspectReceiptImage: vi.fn(async () => ({ sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn(async (path: string) => {
      const buffer = Buffer.from(storedBytes);
      const ocrResult = storedOcrResults.get(path);
      if (ocrResult) downloadedOcrResults.set(buffer, ocrResult);
      return buffer;
    }),
    uploadCsvFile: vi.fn(async () => "1/mock.csv"),
    signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed.jpg"),
    deleteReceiptImage: vi.fn(async (path: string) => (deletedReceiptPaths.push(path), true)),
  };
});

vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractReceipt: async (buffer: Buffer) => {
      const next = downloadedOcrResults.get(buffer) ?? { text: "", confidence: 95 };
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
import {
  deleteReceiptImage,
  downloadReceiptImageBounded,
  uploadReceiptImage,
} from "../../src/services/storage.service";
import {
  confirmReceipt,
  getScan,
  uploadAndScan,
  MAX_PAGES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
  runReceiptWorkerOnce,
} from "../../src/services/receiptScan.service";
import {
  disconnectDb,
  makeOwnerWithProfile,
  resetDb,
  runReceiptWorkerAndWait,
  utcDayString,
} from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 }, [
    "Inventory",
  ]);
  uploadCallCount.value = 0;
  uploadFailureAt.value = null;
  deletedReceiptPaths.length = 0;
  storedOcrResults.clear();
  vi.mocked(uploadReceiptImage).mockReset().mockImplementation(async (_businessProfileId, buffer) => {
    const call = ++uploadCallCount.value;
    if (uploadFailureAt.value === call) throw new Error("storage upload failed");
    const path = `1/mock-page-${call}.jpg`;
    const ocrResult = sourceOcrResults.get(buffer);
    if (ocrResult) storedOcrResults.set(path, ocrResult);
    return path;
  });
  vi.mocked(deleteReceiptImage).mockReset().mockImplementation(async (path: string) => (
    deletedReceiptPaths.push(path), true
  ));
  categoriseMock.mockReset();
  categoriseMock.mockResolvedValue([]);
  visionMock.mockReset();
  visionMock.mockResolvedValue(null);
  vi.mocked(downloadReceiptImageBounded).mockClear();
});

afterAll(disconnectDb);

function page(source: string, ocrResult: { text: string; confidence?: number } = { text: source }) {
  const buffer = Buffer.from(`fake-bytes-${source}`);
  sourceOcrResults.set(buffer, { text: ocrResult.text, confidence: ocrResult.confidence ?? 95 });
  return { buffer, mimetype: "image/jpeg", originalname: "page.jpg" };
}

/**
 * Uploads pages and returns the scan once its background read has finished —
 * see runReceiptWorkerAndWait. Polling mirrors what both clients do, so these
 * assertions exercise the real upload-then-poll contract.
 */
async function uploadPages(texts: { text: string; confidence?: number }[]) {
  const created = await uploadAndScan(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    pages: texts.map((result, index) => page(`page-${index + 1}`, result)),
  });
  await runReceiptWorkerAndWait(created.id);
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
    const storedScan = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(storedScan.imageFile).toBe(pages[0]!.imageFile);
    expect(scan).not.toHaveProperty("imageFile");
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

  it("removes already-uploaded variants when a later storage write fails", async () => {
    uploadFailureAt.value = 2;
    await expect(uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [{
        ...page("original"),
        processed: { ...page("processed") },
      }],
    })).rejects.toThrow("storage upload failed");
    expect(deletedReceiptPaths).toEqual(["1/mock-page-1.jpg"]);
    expect(await prisma.receiptScan.count()).toBe(0);
  });

  it("stores at most two variants concurrently without changing page order or fingerprints", async () => {
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    vi.mocked(uploadReceiptImage).mockImplementation(async (businessProfileId, _buffer, _mimetype, originalname) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(originalname, resolve));
      active -= 1;
      return `${businessProfileId}/${originalname}`;
    });
    const pages = [
      {
        buffer: Buffer.from("source-one"),
        mimetype: "image/jpeg",
        originalname: "source-1.jpg",
        processed: {
          buffer: Buffer.from("derived-one"),
          mimetype: "image/jpeg",
          originalname: "derived-1.jpg",
        },
        metadata: { captureMode: "long" as const },
      },
      { buffer: Buffer.from("source-two"), mimetype: "image/jpeg", originalname: "source-2.jpg" },
      { buffer: Buffer.from("source-three"), mimetype: "image/jpeg", originalname: "source-3.jpg" },
    ];

    const pending = uploadAndScan(ctx.user.id, { businessProfileId: ctx.profile.id, pages });
    await vi.waitFor(() => expect(uploadReceiptImage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(uploadReceiptImage).mock.calls.map((call) => call[3])).toEqual([
      "source-1.jpg",
      "derived-1.jpg",
    ]);
    releases.get("derived-1.jpg")!();
    await vi.waitFor(() => expect(uploadReceiptImage).toHaveBeenCalledTimes(3));
    releases.get("source-2.jpg")!();
    await vi.waitFor(() => expect(uploadReceiptImage).toHaveBeenCalledTimes(4));
    releases.get("source-3.jpg")!();
    releases.get("source-1.jpg")!();
    const created = await pending;

    const storedPages = await prisma.receiptScanPage.findMany({
      where: { receiptScanId: created.id },
      orderBy: { pageNumber: "asc" },
    });
    expect(maxActive).toBe(2);
    expect(storedPages.map((stored) => [stored.imageFile, stored.processedImageFile])).toEqual([
      [`${ctx.profile.id}/source-1.jpg`, `${ctx.profile.id}/derived-1.jpg`],
      [`${ctx.profile.id}/source-2.jpg`, null],
      [`${ctx.profile.id}/source-3.jpg`, null],
    ]);

    const uploadFingerprint = createHash("sha256");
    const sourceFingerprint = createHash("sha256");
    sourceFingerprint.update("finsight-source-image-v1\0");
    sourceFingerprint.update(`${pages.length}\0`);
    for (const [index, uploadedPage] of pages.entries()) {
      uploadFingerprint.update(JSON.stringify({
        mimetype: uploadedPage.mimetype,
        size: uploadedPage.buffer.length,
        processedType: uploadedPage.processed?.mimetype ?? null,
        processedSize: uploadedPage.processed?.buffer.length ?? 0,
        metadata: uploadedPage.metadata ?? null,
      }));
      sourceFingerprint.update(`${index}:${uploadedPage.buffer.length}\0`);
      uploadFingerprint.update(uploadedPage.buffer);
      sourceFingerprint.update(uploadedPage.buffer);
      if (uploadedPage.processed) uploadFingerprint.update(uploadedPage.processed.buffer);
    }
    const storedScan = await prisma.receiptScan.findUniqueOrThrow({ where: { id: created.id } });
    expect(storedScan.uploadHash).toBe(uploadFingerprint.digest("hex"));
    expect(storedScan.sourceImageHash).toBe(sourceFingerprint.digest("hex"));
  });

  it("waits for an in-flight upload and cleans it after a sibling upload fails", async () => {
    let releaseSlow!: () => void;
    const slowUpload = new Promise<void>((resolve) => { releaseSlow = resolve; });
    vi.mocked(uploadReceiptImage).mockImplementation(async (businessProfileId, _buffer, _mimetype, originalname) => {
      if (originalname === "slow.jpg") {
        await slowUpload;
        return `${businessProfileId}/slow.jpg`;
      }
      if (originalname === "failure.jpg") throw new Error("storage upload failed");
      return `${businessProfileId}/${originalname}`;
    });
    const outcome = uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [
        { buffer: Buffer.from("slow"), mimetype: "image/jpeg", originalname: "slow.jpg" },
        { buffer: Buffer.from("failure"), mimetype: "image/jpeg", originalname: "failure.jpg" },
        { buffer: Buffer.from("not-started"), mimetype: "image/jpeg", originalname: "not-started.jpg" },
      ],
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let settled = false;
    void outcome.then(() => { settled = true; });

    await vi.waitFor(() => expect(uploadReceiptImage).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSlow();

    const result = await outcome;
    expect(result).toMatchObject({ status: "rejected", error: { message: "storage upload failed" } });
    expect(vi.mocked(uploadReceiptImage).mock.calls.map((call) => call[3])).toEqual(["slow.jpg", "failure.jpg"]);
    expect(deletedReceiptPaths).toEqual([`${ctx.profile.id}/slow.jpg`]);
    expect(await prisma.receiptScan.count()).toBe(0);
  });

  it("accepts the exact 10 MiB object and 80 MiB aggregate boundaries", async () => {
    const exactObject = Buffer.alloc(RECEIPT_UPLOAD_MAX_OBJECT_BYTES);
    await expect(uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [{ buffer: exactObject, mimetype: "image/jpeg", originalname: "exact-object.jpg" }],
    })).resolves.toMatchObject({ processingStatus: "Processing" });

    await resetDb();
    ctx = await makeOwnerWithProfile({}, ["Inventory"]);
    uploadCallCount.value = 0;
    const fiveMiB = Buffer.alloc(5 * 1024 * 1024);
    const pages = Array.from({ length: MAX_PAGES }, (_, index) => ({
      buffer: fiveMiB,
      mimetype: "image/jpeg",
      originalname: `original-${index + 1}.jpg`,
      processed: {
        buffer: fiveMiB,
        mimetype: "image/jpeg",
        originalname: `processed-${index + 1}.jpg`,
      },
    }));
    expect(pages.length * 2 * fiveMiB.length).toBe(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES);
    await expect(uploadAndScan(ctx.user.id, { businessProfileId: ctx.profile.id, pages }))
      .resolves.toMatchObject({ processingStatus: "Processing" });
    expect(uploadCallCount.value).toBe(MAX_PAGES * 2);
  });

  it("rejects one byte above either byte boundary before storing anything", async () => {
    await expect(uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [{
        buffer: Buffer.alloc(RECEIPT_UPLOAD_MAX_OBJECT_BYTES + 1),
        mimetype: "image/jpeg",
        originalname: "too-large.jpg",
      }],
    })).rejects.toMatchObject({ status: 400 });
    expect(uploadCallCount.value).toBe(0);

    const fiveMiB = Buffer.alloc(5 * 1024 * 1024);
    const fiveMiBAndOne = Buffer.alloc(5 * 1024 * 1024 + 1);
    const pages = Array.from({ length: MAX_PAGES }, (_, index) => ({
      buffer: fiveMiB,
      mimetype: "image/jpeg",
      originalname: `original-${index + 1}.jpg`,
      processed: {
        buffer: index === MAX_PAGES - 1 ? fiveMiBAndOne : fiveMiB,
        mimetype: "image/jpeg",
        originalname: `processed-${index + 1}.jpg`,
      },
    }));
    expect(pages.reduce((sum, item) => sum + item.buffer.length + item.processed.buffer.length, 0))
      .toBe(RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES + 1);
    await expect(uploadAndScan(ctx.user.id, { businessProfileId: ctx.profile.id, pages }))
      .rejects.toMatchObject({ status: 413 });
    expect(uploadCallCount.value).toBe(0);
    expect(await prisma.receiptScan.count()).toBe(0);
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
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("pollable", { text: "Date: 2026-07-20\nItem A 10.00\nTOTAL 10.00", confidence: 95 })],
    });

    // The row exists and is addressable immediately — that is what makes
    // polling possible at all.
    expect(created.id).toBeGreaterThan(0);
    expect(created.confirmationStatus).toBe("Pending");
    // Its page rows exist too, so the client can show what it uploaded while
    // it waits.
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: created.id } })).toBe(1);

    await runReceiptWorkerAndWait(created.id);
  });

  it("reaches Complete, and only then carries the extracted fields", async () => {
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("complete", {
        text: "ABC STORE\nDate: 2026-07-20\nRice 25kg 1220.00\nTOTAL 1220.00",
        confidence: 95,
      })],
    });

    expect(await runReceiptWorkerAndWait(created.id)).toBe("Complete");

    const done = await getScan(ctx.user.id, created.id);
    expect(done.processingStatus).toBe("Complete");
    expect(done.processingError).toBeNull();
    expect(done.extractedAmount).toBe(1220);
  });

  it("allows concurrent workers to claim the queued scan only once", async () => {
    const extractSpy = vi.spyOn(ocrService, "extractReceipt");
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("one-claim", { text: "ABC STORE\nItem A 10.00\nTOTAL 10.00", confidence: 95 })],
    });

    const claims = await Promise.all([runReceiptWorkerOnce(), runReceiptWorkerOnce()]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claimed) => !claimed)).toHaveLength(1);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect((await getScan(ctx.user.id, created.id)).processingStatus).toBe("Complete");
    extractSpy.mockRestore();
  });

  it("records a failed attempt and durably retries it from Storage", async () => {
    const boom = new Error("tesseract exploded");
    const spy = vi.spyOn(ocrService, "extractReceipt").mockRejectedValueOnce(boom);

    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("retry", { text: "ABC STORE\nItem A 10.00\nTOTAL 10.00", confidence: 95 })],
    });

    expect(await runReceiptWorkerOnce()).toBe(true);

    let queued = await getScan(ctx.user.id, created.id);
    for (let i = 0; i < 50 && !queued.processingError; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      queued = await getScan(ctx.user.id, created.id);
    }
    expect(queued.processingStatus).toBe("Processing");
    expect(queued.processingError).toBe("The receipt could not be read. Try again or enter the values manually.");
    expect(queued.processingErrorCode).toBe("RECEIPT_PROCESSING_FAILED");
    expect(JSON.stringify(queued)).not.toContain("tesseract exploded");

    // Make the backoff due now. The next worker has no request buffer, so its
    // success proves the page was reconstructed from durable Storage.
    await prisma.receiptScan.update({ where: { id: created.id }, data: { nextProcessingAttemptAt: new Date(0) } });
    expect(await runReceiptWorkerOnce()).toBe(true);
    expect((await getScan(ctx.user.id, created.id)).processingStatus).toBe("Complete");
    expect(downloadReceiptImageBounded).toHaveBeenCalledTimes(2);
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
    const created = await uploadAndScan(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      pages: [page("owner-isolation", { text: "TOTAL 10.00", confidence: 95 })],
    });
    await runReceiptWorkerAndWait(created.id);

    // 404 rather than 403, matching the non-disclosure rule used everywhere
    // else — a poller must not be able to confirm a scan id even exists.
    await expect(getScan(other.user.id, created.id)).rejects.toMatchObject({ status: 404 });
  });

  /*
   * The worst page drives this local diagnostic: average(95, 60) is above
   * the threshold, while min(95, 60) is below it. External rescue is tested
   * separately through the consent-and-budget gate.
   */
  it("attributes the local-review trigger to the worst page without calling the legacy vision path", async () => {
    const scan = await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00\nTOTAL 30.00", confidence: 95 },
      { text: "Item B   20.00", confidence: 60 }, // reconciles, so only confidence can trigger this
    ]);

    expect(visionMock).not.toHaveBeenCalled();
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect((stored.extractorVersions as { visionTrigger: string | null }).visionTrigger).toBe("low-confidence");
  });

  it("leaves no trigger and makes no provider call when every page reads well and reconciles", async () => {
    const scan = await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00", confidence: 92 },
      { text: "Item B   20.00\nTOTAL 30.00", confidence: 90 },
    ]);

    expect(visionMock).not.toHaveBeenCalled();
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect((stored.extractorVersions as { visionTrigger: string | null }).visionTrigger).toBeNull();
  });

  it("does not bypass the provider gate through the legacy multi-page vision function", async () => {
    const scan = await uploadPages([
      { text: "Date: 2026-07-20\nItem A   10.00" },
      { text: "Item B   20.00\nTOTAL 999.00" },
    ]);

    expect(visionMock).not.toHaveBeenCalled();
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.extractorVersions).toMatchObject({
      provider: null,
      providerGateCode: "PROVIDER_NOT_REQUESTED",
    });
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
