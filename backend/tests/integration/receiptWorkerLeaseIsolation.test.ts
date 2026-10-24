import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/config/prisma";
import {
  persistReceiptProcessingOutput,
  ReceiptLeaseLostError,
  type ReceiptProcessingOutput,
} from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function blockedLockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS "count"
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND usename = current_user
      AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'
  `;
  return Number(rows[0]?.count ?? 0);
}

describe("receipt worker lease isolation", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("rejects a stale output after a newer attempt commits scan, page, and item data", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/lease-race.jpg`,
        processingStatus: "Processing",
        processingWorkerId: "old-worker",
        processingAttemptCount: 1,
        processingStartedAt: new Date("2026-09-13T00:00:00.000Z"),
        processingHeartbeatAt: new Date("2026-09-13T00:01:00.000Z"),
        pages: {
          create: {
            pageNumber: 1,
            imageFile: `${owner.profile.id}/lease-race-page.jpg`,
            rawText: "INITIAL PAGE",
          },
        },
        items: {
          create: {
            lineNumber: 1,
            name: "Initial item",
            amount: 1,
            categoryId: owner.categories.Inventory,
          },
        },
      },
    });

    const newerReady = deferred();
    const allowNewerCommit = deferred();
    // Keep the replacement attempt's transaction open after all three output
    // surfaces are written. Its scan-row lock makes the stale commit wait at
    // the lease check until the newer result is durable.
    const newerAttempt = prisma.$transaction(async (tx) => {
      const reclaimed = await tx.receiptScan.updateMany({
        where: {
          id: scan.id,
          businessProfileId: owner.profile.id,
          processingStatus: "Processing",
          processingWorkerId: "old-worker",
          processingAttemptCount: 1,
        },
        data: {
          processingWorkerId: "new-worker",
          processingAttemptCount: { increment: 1 },
          processingStartedAt: new Date("2026-09-13T00:03:00.000Z"),
          processingHeartbeatAt: new Date("2026-09-13T00:03:00.000Z"),
        },
      });
      expect(reclaimed.count).toBe(1);

      await tx.receiptScan.update({
        where: { id: scan.id },
        data: {
          extractedDate: new Date("2026-09-12T00:00:00.000Z"),
          extractedVendor: "NEW STORE",
          extractedDescription: "Purchase from NEW STORE",
          extractedAmount: 22,
          rawText: "NEW STORE\nNew item 22.00\nTOTAL 22.00",
          ocrConfidence: 96,
          vendorConfidence: 94,
          amountConfidence: 97,
          extractorVersions: { attempt: "new" },
          fieldEvidence: { amount: { sourceText: "TOTAL 22.00" } },
          warnings: [],
          receiptLikelihood: { classification: "LIKELY_RECEIPT" },
          processingErrorCode: null,
        },
      });
      await tx.receiptScanPage.updateMany({
        where: { receiptScanId: scan.id, pageNumber: 1 },
        data: {
          rawText: "NEW PAGE",
          originalRawText: "NEW ORIGINAL PAGE",
          processedRawText: null,
          ocrSource: "original",
          ocrConfidence: 96,
          originalOcrConfidence: 96,
          processedOcrConfidence: null,
          sharpness: 88,
          brightness: 132,
          tooBlurredToTrust: false,
        },
      });
      await tx.receiptScanItem.deleteMany({ where: { receiptScanId: scan.id } });
      await tx.receiptScanItem.create({
        data: {
          receiptScanId: scan.id,
          lineNumber: 1,
          name: "New item",
          amount: 22,
          categoryId: owner.categories.Inventory,
          amountConfidence: 97,
          evidence: { pageNumber: 1, sourceText: "New item 22.00", source: "ocr" },
        },
      });
      await tx.receiptScan.update({
        where: { id: scan.id },
        data: {
          processingStatus: "Complete",
          processingError: null,
          processingWorkerId: null,
          processingHeartbeatAt: null,
        },
      });

      newerReady.resolve();
      await allowNewerCommit.promise;
    }, { timeout: 15_000 });

    await newerReady.promise;

    const staleOutput: ReceiptProcessingOutput = {
      scan: {
        extractedDate: new Date("2025-01-01T00:00:00.000Z"),
        extractedVendor: "STALE STORE",
        extractedDescription: "Purchase from STALE STORE",
        extractedAmount: 999,
        rawText: "STALE RECEIPT CONTENT",
        ocrConfidence: 1,
        vendorConfidence: 1,
        amountConfidence: 1,
        extractorVersions: { attempt: "stale" },
        fieldEvidence: { amount: { sourceText: "STALE TOTAL" } },
        warnings: [{ code: "STALE_WARNING" }],
        receiptLikelihood: { classification: "NOT_A_RECEIPT" },
        processingErrorCode: "STALE_ERROR",
      },
      pages: [{
        pageNumber: 1,
        data: {
          rawText: "STALE PAGE",
          originalRawText: "STALE ORIGINAL PAGE",
          processedRawText: "STALE PROCESSED PAGE",
          ocrSource: "processed",
          ocrConfidence: 1,
          originalOcrConfidence: 1,
          processedOcrConfidence: 1,
          sharpness: 1,
          brightness: 1,
          tooBlurredToTrust: true,
        },
      }],
      items: {
        parsedItems: [{ name: "Stale item", quantity: 9, unitPrice: 111, amount: 999 }],
        vendor: "STALE STORE",
        extractedByVision: true,
        amountConfidences: [1],
        itemEvidence: [{ pageNumber: 1, sourceText: "STALE ITEM 999.00" }],
      },
    };
    const staleAttempt = persistReceiptProcessingOutput(
      scan.id,
      owner.profile.id,
      { workerId: "old-worker", attempt: 1 },
      staleOutput,
    );
    const staleRejection = expect(staleAttempt).rejects.toBeInstanceOf(ReceiptLeaseLostError);

    try {
      await vi.waitFor(async () => {
        expect(await blockedLockWaiters()).toBeGreaterThanOrEqual(1);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      allowNewerCommit.resolve();
    }

    await newerAttempt;
    await staleRejection;

    const newerState = await prisma.receiptScan.findUniqueOrThrow({
      where: { id: scan.id },
      include: {
        pages: { orderBy: { pageNumber: "asc" } },
        items: { orderBy: { lineNumber: "asc" } },
      },
    });
    expect(newerState).toMatchObject({
      processingStatus: "Complete",
      processingAttemptCount: 2,
      processingWorkerId: null,
      extractedVendor: "NEW STORE",
      extractedDescription: "Purchase from NEW STORE",
      rawText: "NEW STORE\nNew item 22.00\nTOTAL 22.00",
      ocrConfidence: 96,
      pages: [{
        rawText: "NEW PAGE",
        originalRawText: "NEW ORIGINAL PAGE",
        ocrConfidence: 96,
        sharpness: 88,
        tooBlurredToTrust: false,
      }],
      items: [{
        name: "New item",
        lineNumber: 1,
        categoryId: owner.categories.Inventory,
        amountConfidence: 97,
      }],
    });
    expect(Number(newerState.extractedAmount)).toBe(22);
    expect(Number(newerState.items[0]!.amount)).toBe(22);

    await expect(prisma.receiptScan.findUniqueOrThrow({
      where: { id: scan.id },
      include: {
        pages: { orderBy: { pageNumber: "asc" } },
        items: { orderBy: { lineNumber: "asc" } },
      },
    })).resolves.toEqual(newerState);
  }, 15_000);
});
