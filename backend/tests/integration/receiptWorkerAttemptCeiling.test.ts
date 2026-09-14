import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A worker that crashes mid-OCR never reaches recordProcessingFailure, so the
 * attempt ceiling has to be enforced at claim time too. A stale-lease scan
 * with a full attempt counter becomes Failed for the owner instead of being
 * reclaimed forever.
 */
vi.mock("../../src/services/storage.service", () => ({
  uploadReceiptImage: vi.fn(),
  deleteReceiptImage: vi.fn(),
  inspectReceiptImage: vi.fn().mockRejectedValue(new Error("evidence store offline")),
  downloadReceiptImageBounded: vi.fn().mockRejectedValue(new Error("evidence store offline")),
  signedReceiptImageUrl: vi.fn(),
}));

import { prisma } from "../../src/config/prisma";
import { runReceiptWorkerOnce } from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const STALE = new Date("2026-09-13T00:00:00.000Z");

describe("receipt worker attempt ceiling", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  async function staleScan(processingAttemptCount: number) {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    return prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/crash-loop.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        processingWorkerId: "crashed-worker",
        processingAttemptCount,
        processingStartedAt: STALE,
        processingHeartbeatAt: STALE,
        nextProcessingAttemptAt: STALE,
        pages: { create: { pageNumber: 1, imageFile: `${owner.profile.id}/crash-loop-page.jpg` } },
      },
    });
  }

  it("does not reclaim a stale scan that already used every attempt, and fails it for the owner", async () => {
    const scan = await staleScan(3);

    await runReceiptWorkerOnce();

    const after = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(after.processingStatus).toBe("Failed");
    expect(after.processingAttemptCount).toBe(3);
    expect(after.processingWorkerId).toBeNull();
    expect(after.processingErrorCode).toBe("RECEIPT_PROCESSING_FAILED");
    expect(after.processingError).not.toContain("crash-loop");

    // A second pass has nothing left to do with it.
    expect(await runReceiptWorkerOnce()).toBe(false);
  });

  it("still reclaims a stale scan with attempts remaining", async () => {
    const scan = await staleScan(1);

    expect(await runReceiptWorkerOnce()).toBe(true);

    const after = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(after.processingAttemptCount).toBe(2);
  });

  it("leaves a fresh lease alone even at the ceiling", async () => {
    const scan = await staleScan(3);
    await prisma.receiptScan.update({ where: { id: scan.id }, data: { processingHeartbeatAt: new Date() } });

    await runReceiptWorkerOnce();

    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).processingStatus).toBe("Processing");
  });
});
