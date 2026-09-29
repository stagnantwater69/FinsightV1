import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/storage.service", () => ({
  deleteReceiptImage: vi.fn(),
  downloadReceiptImageBounded: vi.fn().mockRejectedValue(new Error("evidence store offline")),
  inspectReceiptImage: vi.fn().mockRejectedValue(new Error("evidence store offline")),
  RECEIPT_URL_TTL_SECONDS: 60,
  signedReceiptImageUrl: vi.fn(),
  uploadReceiptImage: vi.fn(),
}));

import { prisma } from "../../src/config/prisma";
import { getScan, retryScan } from "../../src/services/receiptScan/queue";
import {
  persistReceiptProcessingOutput,
  ReceiptLeaseLostError,
  runReceiptWorkerOnce,
} from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

describe("receipt processing timing", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("persists queue wait and service time when the owning lease completes", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const createdAt = new Date(Date.now() - 10_000);
    const processingStartedAt = new Date(createdAt.getTime() + 6_000);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/timed-success.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        processingWorkerId: "timing-worker",
        processingAttemptCount: 1,
        processingStartedAt,
        processingHeartbeatAt: processingStartedAt,
        createdAt,
        pages: {
          create: { pageNumber: 1, imageFile: `${owner.profile.id}/timed-success.jpg` },
        },
      },
    });
    const output = {
      scan: { rawText: "TOTAL 10.00", extractedAmount: 10 },
      pages: [{ pageNumber: 1, data: { rawText: "TOTAL 10.00" } }],
      items: {
        parsedItems: [],
        vendor: null,
        extractedByVision: false,
        amountConfidences: [],
        itemEvidence: [],
      },
      providerRead: false,
    };

    await expect(
      persistReceiptProcessingOutput(
        scan.id,
        owner.profile.id,
        { workerId: "stale-worker", attempt: 1 },
        output,
      ),
    ).rejects.toBeInstanceOf(ReceiptLeaseLostError);
    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).processingCompletedAt).toBeNull();

    await persistReceiptProcessingOutput(
      scan.id,
      owner.profile.id,
      { workerId: "timing-worker", attempt: 1 },
      output,
    );

    const completed = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(completed.processingStatus).toBe("Complete");
    expect(completed.processingCompletedAt).not.toBeNull();
    expect(completed.processingStartedAt!.getTime() - completed.createdAt.getTime()).toBe(6_000);
    expect(completed.processingCompletedAt!.getTime() - completed.processingStartedAt!.getTime()).toBeGreaterThanOrEqual(0);
    expect(completed.lastActivityAt).toEqual(completed.processingCompletedAt);
    expect(await getScan(owner.user.id, scan.id)).not.toHaveProperty("processingCompletedAt");
  });

  it("sets completion only on the final failure and clears both timings on owner retry", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/timed-failure.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        nextProcessingAttemptAt: new Date(0),
        pages: {
          create: { pageNumber: 1, imageFile: `${owner.profile.id}/timed-failure.jpg` },
        },
      },
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await runReceiptWorkerOnce()).toBe(true);
      const state = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
      expect(state.processingAttemptCount).toBe(attempt);
      if (attempt < 3) {
        expect(state.processingStatus).toBe("Processing");
        expect(state.processingCompletedAt).toBeNull();
        await prisma.receiptScan.update({
          where: { id: scan.id },
          data: { nextProcessingAttemptAt: new Date(0) },
        });
      }
    }

    const failed = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(failed.processingStatus).toBe("Failed");
    expect(failed.processingStartedAt).not.toBeNull();
    expect(failed.processingCompletedAt).not.toBeNull();
    expect(failed.processingCompletedAt!.getTime() - failed.processingStartedAt!.getTime()).toBeGreaterThanOrEqual(0);

    const retryDto = await retryScan(owner.user.id, scan.id);
    const retried = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(retried).toMatchObject({
      processingStatus: "Processing",
      processingAttemptCount: 0,
      processingStartedAt: null,
      processingCompletedAt: null,
    });
    expect(retryDto).not.toHaveProperty("processingCompletedAt");
  });

  it("timestamps the reconciliation path that fails an exhausted stale lease", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const processingStartedAt = new Date(Date.now() - 120_000);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/timed-exhausted.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        processingWorkerId: "crashed-worker",
        processingAttemptCount: 3,
        processingStartedAt,
        processingHeartbeatAt: processingStartedAt,
        nextProcessingAttemptAt: new Date(0),
        pages: {
          create: { pageNumber: 1, imageFile: `${owner.profile.id}/timed-exhausted.jpg` },
        },
      },
    });

    expect(await runReceiptWorkerOnce()).toBe(false);

    const reconciled = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(reconciled.processingStatus).toBe("Failed");
    expect(reconciled.processingCompletedAt).not.toBeNull();
    expect(reconciled.processingCompletedAt!.getTime() - processingStartedAt.getTime()).toBeGreaterThanOrEqual(120_000);
  });
});
