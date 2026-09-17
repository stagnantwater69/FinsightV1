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

import { createHash } from "node:crypto";

import { ReceiptPurgeMode, ReceiptPurgeReason } from "@prisma/client";

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

  it("does not fail a scan that is already scheduled for purge", async () => {
    /*
     * Every other transition in the pipeline — claimScan, storedInput,
     * persistReceiptProcessingOutput — refuses to touch a scan with a
     * DELETE_SCAN purge job or an evidenceDeletionRequestedAt. This one used
     * to write regardless, which would stamp a fresh lastActivityAt and an
     * owner-facing "could not be read" error onto a row that is on its way
     * out, putting a deleted receipt back in the owner's failed list.
     *
     * Today's enqueue paths all move the scan to Deletion Pending in the same
     * transaction, so the state below has to be built directly. That is the
     * point of pinning it: the guard is what keeps a future enqueue path, or a
     * purge that is retrying its stages, from depending on a status flip that
     * this query never checked.
     */
    const scan = await staleScan(3);
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: { evidenceDeletionRequestedAt: new Date() },
    });
    await prisma.receiptPurgeJob.create({
      data: {
        businessProfileId: scan.businessProfileId!,
        receiptScanId: scan.id,
        receiptScanBusinessProfileId: scan.businessProfileId!,
        // The table's CHECK constraint requires lowercase 64-char hex.
        requestKeyHash: createHash("sha256").update(`purge-request-${scan.id}`).digest("hex"),
        targetReferenceHash: createHash("sha256").update(`purge-target-${scan.id}`).digest("hex"),
        reason: ReceiptPurgeReason.OWNER_REQUEST,
        mode: ReceiptPurgeMode.DELETE_SCAN,
        storageObjectsExpected: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await runReceiptWorkerOnce();

    const after = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(after.processingStatus).toBe("Processing");
    expect(after.processingErrorCode).toBeNull();
  });

  it("leaves a fresh lease alone even at the ceiling", async () => {
    const scan = await staleScan(3);
    await prisma.receiptScan.update({ where: { id: scan.id }, data: { processingHeartbeatAt: new Date() } });

    await runReceiptWorkerOnce();

    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).processingStatus).toBe("Processing");
  });
});
