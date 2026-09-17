import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authByToken, storage } = vi.hoisted(() => ({
  authByToken: new Map<string, string>(),
  storage: {
    sequence: 0,
    uploadReceiptImage: vi.fn(),
    deleteReceiptImage: vi.fn(),
    inspectReceiptImage: vi.fn(),
    downloadReceiptImageBounded: vi.fn(),
    signedReceiptImageUrl: vi.fn(),
  },
}));

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        admin: {
          deleteUser: async () => ({ data: {}, error: null }),
        },
        getUser: async (token: string) => {
          const authId = authByToken.get(token);
          return authId
            ? { data: { user: { id: authId } }, error: null }
            : { data: { user: null }, error: new Error("bad token") };
        },
      },
    },
  };
});

vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadReceiptImage: storage.uploadReceiptImage,
    deleteReceiptImage: storage.deleteReceiptImage,
    inspectReceiptImage: storage.inspectReceiptImage,
    downloadReceiptImageBounded: storage.downloadReceiptImageBounded,
    signedReceiptImageUrl: storage.signedReceiptImageUrl,
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import {
  ABANDONED_SCAN_RETENTION_MS,
  ABANDONED_SCAN_SWEEP_BATCH_SIZE,
  runReceiptPurgeWorkerOnce,
  sweepAbandonedReceiptScans,
} from "../../src/services/receiptPurge.service";
import {
  RECEIPT_VIEW_ACTIVITY_THROTTLE_MS,
  uploadAndScan,
} from "../../src/services/receiptScan/queue";
import {
  persistReceiptProcessingOutput,
  runReceiptWorkerOnce,
} from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const RECEIPTS = "/api/v1/records/receipts";
const auth = (token: string) => ["Authorization", `Bearer ${token}`] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  owner = await makeOwnerWithProfile({}, ["Inventory"]);
  other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
  authByToken.clear();
  authByToken.set("owner-token", owner.user.authId);
  authByToken.set("other-token", other.user.authId);

  storage.sequence = 0;
  storage.uploadReceiptImage.mockReset().mockImplementation(async (businessProfileId: number) => (
    `${businessProfileId}/abandoned-${++storage.sequence}.jpg`
  ));
  storage.deleteReceiptImage.mockReset().mockResolvedValue(true);
  storage.inspectReceiptImage.mockReset().mockResolvedValue({ sizeBytes: 128, mimetype: "image/jpeg" });
  storage.downloadReceiptImageBounded.mockReset().mockResolvedValue(Buffer.from("unused"));
  storage.signedReceiptImageUrl.mockReset().mockResolvedValue("https://example.test/receipt.jpg");
});

afterAll(disconnectDb);

// Whole milliseconds only: the column is timestamp(3), so a sub-millisecond
// offset would round and blur the boundary the tests are pinning down.
const NOW = new Date("2026-09-14T12:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - ABANDONED_SCAN_RETENTION_MS);

async function makeScan(input: {
  businessProfileId?: number;
  processingStatus?: "Complete" | "Failed" | "Processing" | "Pending";
  confirmationStatus?: "Pending" | "Confirmed";
  lastActivityAt: Date;
  label?: string;
  evidenceDeletionRequestedAt?: Date | null;
  captureBatchId?: number;
  receiptOrdinal?: number;
}) {
  const businessProfileId = input.businessProfileId ?? owner.profile.id;
  const label = input.label ?? `scan-${Math.random().toString(36).slice(2, 8)}`;
  const path = `${businessProfileId}/${label}-source.jpg`;
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      captureBatchId: input.captureBatchId,
      receiptOrdinal: input.receiptOrdinal,
      imageFile: path,
      extractedDate: new Date("2026-09-01T00:00:00.000Z"),
      extractedVendor: "Owner Store",
      extractedDescription: "Rice purchase",
      extractedAmount: 100,
      processingStatus: input.processingStatus ?? "Complete",
      confirmationStatus: input.confirmationStatus ?? "Pending",
      lastActivityAt: input.lastActivityAt,
      evidenceDeletionRequestedAt: input.evidenceDeletionRequestedAt ?? null,
      pages: {
        create: [{
          pageNumber: 1,
          imageFile: path,
          processedImageFile: `${businessProfileId}/${label}-derived.jpg`,
        }],
      },
      items: {
        create: [{ lineNumber: 1, name: "Rice", amount: 100, amountConfidence: 82 }],
      },
    },
    include: { items: true, pages: true },
  });
}

async function activityOf(scanId: number): Promise<Date> {
  const scan = await prisma.receiptScan.findUniqueOrThrow({
    where: { id: scanId },
    select: { lastActivityAt: true },
  });
  return scan.lastActivityAt;
}

async function purgeJobsFor(scanId: number) {
  return prisma.receiptPurgeJob.findMany({ where: { receiptScanId: scanId }, orderBy: { id: "asc" } });
}

describe("abandoned-scan sweep: seven-day boundary", () => {
  it("sweeps only Pending scans whose last activity is strictly older than seven days", async () => {
    const justInside = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() + 1), label: "inside" });
    const exactly = await makeScan({ lastActivityAt: CUTOFF, label: "exactly" });
    const justPast = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - 1), label: "past" });
    const failedPast = await makeScan({
      processingStatus: "Failed",
      lastActivityAt: new Date(CUTOFF.getTime() - 1),
      label: "failed-past",
    });

    const result = await sweepAbandonedReceiptScans({ now: NOW });
    expect(result).toMatchObject({ enqueued: 2, alreadyScheduled: 0, skipped: 0 });

    expect(await purgeJobsFor(justInside.id)).toHaveLength(0);
    expect(await purgeJobsFor(exactly.id)).toHaveLength(0);
    for (const swept of [justPast, failedPast]) {
      const jobs = await purgeJobsFor(swept.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        businessProfileId: owner.profile.id,
        receiptScanBusinessProfileId: owner.profile.id,
        reason: "ABANDONED_SCAN",
        mode: "DELETE_SCAN",
        status: "PENDING",
        stage: "STORAGE",
        storageObjectsExpected: 2,
      });
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: swept.id } })).toMatchObject({
        confirmationStatus: "Deletion Pending",
        processingStatus: "Failed",
        evidenceDeletionRequestedAt: expect.any(Date),
      });
    }
    for (const untouched of [justInside, exactly]) {
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: untouched.id } })).toMatchObject({
        confirmationStatus: "Pending",
        evidenceDeletionRequestedAt: null,
      });
    }
  });

  it("hands the swept scan to the existing purge pipeline, which removes evidence and the scan rows", async () => {
    const abandoned = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - DAY_MS), label: "purged" });

    await sweepAbandonedReceiptScans({ now: NOW });
    expect(storage.deleteReceiptImage).not.toHaveBeenCalled();

    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);

    expect(await prisma.receiptScan.findUnique({ where: { id: abandoned.id } })).toBeNull();
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: abandoned.id } })).toBe(0);
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: abandoned.id } })).toBe(0);
    expect(storage.deleteReceiptImage).toHaveBeenCalledWith(`${owner.profile.id}/purged-source.jpg`);
    expect(storage.deleteReceiptImage).toHaveBeenCalledWith(`${owner.profile.id}/purged-derived.jpg`);
    const [job] = await prisma.receiptPurgeJob.findMany({ where: { reason: "ABANDONED_SCAN" } });
    expect(job).toMatchObject({
      receiptScanId: null,
      businessProfileId: owner.profile.id,
      status: "COMPLETE",
      stage: "COMPLETE",
      storageObjectsDeleted: 2,
    });
  });

  it("is idempotent across repeated and concurrent sweeps", async () => {
    const abandoned = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - DAY_MS) });

    const [first, second] = await Promise.all([
      sweepAbandonedReceiptScans({ now: NOW }),
      sweepAbandonedReceiptScans({ now: NOW }),
    ]);
    expect(first.enqueued + second.enqueued).toBe(1);
    expect(await purgeJobsFor(abandoned.id)).toHaveLength(1);

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ enqueued: 0 });
    await expect(sweepAbandonedReceiptScans({ now: new Date(NOW.getTime() + DAY_MS) })).resolves.toMatchObject({
      enqueued: 0,
    });
    expect(await purgeJobsFor(abandoned.id)).toHaveLength(1);
  });

  it("bounds each pass to the batch size and picks up the remainder next tick", async () => {
    expect(ABANDONED_SCAN_SWEEP_BATCH_SIZE).toBeGreaterThan(0);
    const scans = [];
    for (let index = 0; index < 3; index++) {
      scans.push(await makeScan({
        lastActivityAt: new Date(CUTOFF.getTime() - (3 - index) * MINUTE_MS),
        label: `batch-${index}`,
      }));
    }

    await expect(sweepAbandonedReceiptScans({ now: NOW, batchSize: 2 })).resolves.toMatchObject({ enqueued: 2 });
    expect(await purgeJobsFor(scans[0]!.id)).toHaveLength(1);
    expect(await purgeJobsFor(scans[1]!.id)).toHaveLength(1);
    expect(await purgeJobsFor(scans[2]!.id)).toHaveLength(0);

    await expect(sweepAbandonedReceiptScans({ now: NOW, batchSize: 2 })).resolves.toMatchObject({ enqueued: 1 });
    expect(await purgeJobsFor(scans[2]!.id)).toHaveLength(1);
  });
});

describe("abandoned-scan sweep: protected states", () => {
  it("leaves confirmed, still-processing, queued, deletion-requested, and already-scheduled scans alone", async () => {
    const stale = new Date(CUTOFF.getTime() - 3 * DAY_MS);
    const confirmed = await makeScan({ confirmationStatus: "Confirmed", lastActivityAt: stale });
    // Pending/Processing belong to the processing pipeline; the clock only
    // matters once the worker reaches Complete or Failed.
    const processing = await makeScan({ processingStatus: "Processing", lastActivityAt: stale });
    const queued = await makeScan({ processingStatus: "Pending", lastActivityAt: stale });
    const deletionRequested = await makeScan({ lastActivityAt: stale, evidenceDeletionRequestedAt: stale });
    const alreadyScheduled = await makeScan({ lastActivityAt: stale });
    await prisma.receiptPurgeJob.create({
      data: {
        businessProfileId: owner.profile.id,
        receiptScanId: alreadyScheduled.id,
        receiptScanBusinessProfileId: owner.profile.id,
        requestKeyHash: "a".repeat(64),
        targetReferenceHash: "b".repeat(64),
        reason: "OWNER_REQUEST",
        mode: "DELETE_SCAN",
        status: "RETRY",
        storageObjectsExpected: 2,
        // Pinned to this suite's clock, not left to default to the real one:
        // the ExpiresAt > RequestedAt constraint compares the two, so a
        // default real `now()` made this row unsatisfiable the moment the
        // wall clock passed NOW + 1 day.
        requestedAt: NOW,
        expiresAt: new Date(NOW.getTime() + DAY_MS),
      },
    });

    const result = await sweepAbandonedReceiptScans({ now: NOW });
    expect(result).toMatchObject({ enqueued: 0 });

    for (const scan of [confirmed, processing, queued, deletionRequested]) {
      expect(await purgeJobsFor(scan.id)).toHaveLength(0);
      const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
      expect(stored.confirmationStatus).toBe(scan.confirmationStatus);
      expect(stored.processingStatus).toBe(scan.processingStatus);
      expect(stored.lastActivityAt).toEqual(stale);
    }
    expect(await purgeJobsFor(alreadyScheduled.id)).toHaveLength(1);
  });

  it("answers an owner delete that arrives after the sweep with a plain conflict and no key instructions", async () => {
    const abandoned = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - DAY_MS) });
    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ enqueued: 1 });

    const conflict = await request(app)
      .delete(`${RECEIPTS}/${abandoned.id}`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "owner-deletes-after-sweep");
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("This receipt is already being deleted.");
    expect(conflict.body.code).toBe("PURGE_IN_PROGRESS");
    expect(JSON.stringify(conflict.body)).not.toMatch(/idempotency|key/i);
    expect(await purgeJobsFor(abandoned.id)).toHaveLength(1);
  });

  it("leaves a scan the owner deleted first to the owner's own job", async () => {
    const abandoned = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - DAY_MS) });
    const accepted = await request(app)
      .delete(`${RECEIPTS}/${abandoned.id}`)
      .set(...auth("owner-token"))
      .set("Idempotency-Key", "owner-deletes-first");
    expect(accepted.status).toBe(202);

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ enqueued: 0 });
    expect(await purgeJobsFor(abandoned.id)).toHaveLength(1);
    expect((await purgeJobsFor(abandoned.id))[0]).toMatchObject({ reason: "OWNER_REQUEST" });
  });

  it("skips a scan the owner came back to between sweeps", async () => {
    const sixDaysAgo = new Date(NOW.getTime() - 6 * DAY_MS);
    const scan = await makeScan({ lastActivityAt: sixDaysAgo });

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ enqueued: 0 });

    const viewed = await request(app).get(`${RECEIPTS}/${scan.id}`).set(...auth("owner-token"));
    expect(viewed.status).toBe(200);
    const resumedAt = await activityOf(scan.id);
    expect(resumedAt.getTime()).toBeGreaterThan(sixDaysAgo.getTime());

    await expect(sweepAbandonedReceiptScans({ now: new Date(NOW.getTime() + 2 * DAY_MS) })).resolves.toMatchObject({
      enqueued: 0,
    });
    expect(await purgeJobsFor(scan.id)).toHaveLength(0);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Pending",
    });

    // Eight days of silence after the visit, and it is swept.
    await expect(
      sweepAbandonedReceiptScans({ now: new Date(resumedAt.getTime() + ABANDONED_SCAN_RETENTION_MS + 1) }),
    ).resolves.toMatchObject({ enqueued: 1 });
  });
});

describe("abandoned-scan sweep: cross-profile isolation", () => {
  it("enqueues one correctly scoped job per profile", async () => {
    const stale = new Date(CUTOFF.getTime() - DAY_MS);
    const ownerScan = await makeScan({ lastActivityAt: stale, label: "owner-old" });
    const otherScan = await makeScan({ businessProfileId: other.profile.id, lastActivityAt: stale, label: "other-old" });

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ enqueued: 2 });

    expect((await purgeJobsFor(ownerScan.id))[0]).toMatchObject({
      businessProfileId: owner.profile.id,
      receiptScanBusinessProfileId: owner.profile.id,
      reason: "ABANDONED_SCAN",
    });
    expect((await purgeJobsFor(otherScan.id))[0]).toMatchObject({
      businessProfileId: other.profile.id,
      receiptScanBusinessProfileId: other.profile.id,
      reason: "ABANDONED_SCAN",
    });
  });

  it("never lets another owner's request move a scan's activity clock", async () => {
    const stale = new Date(NOW.getTime() - 6 * DAY_MS);
    const scan = await makeScan({ lastActivityAt: stale });
    const failed = await makeScan({ processingStatus: "Failed", lastActivityAt: stale });
    const item = scan.items[0]!;

    const foreign = [
      request(app).get(`${RECEIPTS}/${scan.id}`).set(...auth("other-token")),
      request(app).get(`${RECEIPTS}/${scan.id}/pages/1/image/source`).set(...auth("other-token")),
      request(app).get(`${RECEIPTS}/${scan.id}/duplicate-candidates`).set(...auth("other-token")),
      request(app).post(`${RECEIPTS}/${failed.id}/retry`).set(...auth("other-token")),
      request(app)
        .patch(`${RECEIPTS}/${scan.id}/items/${item.id}`)
        .set(...auth("other-token"))
        .send({ name: "Rice", amount: 90, expectedScanRevision: scan.scanRevision }),
      request(app).delete(`${RECEIPTS}/${scan.id}/items/${item.id}`).set(...auth("other-token")),
    ];
    for (const response of await Promise.all(foreign)) {
      expect(response.status).toBe(404);
    }

    expect(await activityOf(scan.id)).toEqual(stale);
    expect(await activityOf(failed.id)).toEqual(stale);
  });
});

describe("owner activity stamps", () => {
  it("throttles view stamps so polling does not write on every request", async () => {
    const beyondWindow = new Date(Date.now() - RECEIPT_VIEW_ACTIVITY_THROTTLE_MS - MINUTE_MS);
    const withinWindow = new Date(Date.now() - MINUTE_MS);
    const stale = await makeScan({ lastActivityAt: beyondWindow });
    const fresh = await makeScan({ lastActivityAt: withinWindow });

    const before = Date.now();
    expect((await request(app).get(`${RECEIPTS}/${stale.id}`).set(...auth("owner-token"))).status).toBe(200);
    const stamped = await activityOf(stale.id);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before - 1);

    expect((await request(app).get(`${RECEIPTS}/${stale.id}`).set(...auth("owner-token"))).status).toBe(200);
    expect((await request(app).get(`${RECEIPTS}/${stale.id}/pages/1/image/source`).set(...auth("owner-token"))).status).toBe(200);
    expect((await request(app).get(`${RECEIPTS}/${stale.id}/duplicate-candidates`).set(...auth("owner-token"))).status).toBe(200);
    expect(await activityOf(stale.id)).toEqual(stamped);

    expect((await request(app).get(`${RECEIPTS}/${fresh.id}`).set(...auth("owner-token"))).status).toBe(200);
    expect(await activityOf(fresh.id)).toEqual(withinWindow);
  });

  it("stamps a page image view and a duplicate-candidates view once the window has passed", async () => {
    const beyondWindow = new Date(Date.now() - RECEIPT_VIEW_ACTIVITY_THROTTLE_MS - MINUTE_MS);
    const pageViewed = await makeScan({ lastActivityAt: beyondWindow });
    const candidatesViewed = await makeScan({ lastActivityAt: beyondWindow });

    expect((await request(app).get(`${RECEIPTS}/${pageViewed.id}/pages/1/image/source`).set(...auth("owner-token"))).status).toBe(200);
    expect((await activityOf(pageViewed.id)).getTime()).toBeGreaterThan(beyondWindow.getTime());

    expect((await request(app).get(`${RECEIPTS}/${candidatesViewed.id}/duplicate-candidates`).set(...auth("owner-token"))).status).toBe(200);
    expect((await activityOf(candidatesViewed.id)).getTime()).toBeGreaterThan(beyondWindow.getTime());
  });

  it("stamps retry, item update, and item delete in the same transaction as the change", async () => {
    const stale = new Date(NOW.getTime() - 6 * DAY_MS);
    const failed = await makeScan({ processingStatus: "Failed", lastActivityAt: stale });
    const edited = await makeScan({ lastActivityAt: stale });
    const trimmed = await makeScan({ lastActivityAt: stale });

    const retried = await request(app).post(`${RECEIPTS}/${failed.id}/retry`).set(...auth("owner-token"));
    expect(retried.status).toBe(202);
    expect((await activityOf(failed.id)).getTime()).toBeGreaterThan(stale.getTime());

    const updated = await request(app)
      .patch(`${RECEIPTS}/${edited.id}/items/${edited.items[0]!.id}`)
      .set(...auth("owner-token"))
      .send({ name: "Rice 5kg", amount: 95, expectedScanRevision: edited.scanRevision });
    expect(updated.status).toBe(200);
    expect((await activityOf(edited.id)).getTime()).toBeGreaterThan(stale.getTime());

    const removed = await request(app)
      .delete(`${RECEIPTS}/${trimmed.id}/items/${trimmed.items[0]!.id}`)
      .set(...auth("owner-token"));
    expect(removed.status).toBe(200);
    expect((await activityOf(trimmed.id)).getTime()).toBeGreaterThan(stale.getTime());

    // A rejected edit (stale revision) must not move the clock.
    const conflicted = await makeScan({ lastActivityAt: stale });
    const rejected = await request(app)
      .patch(`${RECEIPTS}/${conflicted.id}/items/${conflicted.items[0]!.id}`)
      .set(...auth("owner-token"))
      .send({ name: "Rice", amount: 90, expectedScanRevision: conflicted.scanRevision + 5 });
    expect(rejected.status).toBe(409);
    expect(await activityOf(conflicted.id)).toEqual(stale);
  });

  it("stamps an idempotent upload replay as activity", async () => {
    const submission = {
      businessProfileId: owner.profile.id,
      idempotencyKey: "replayed-upload-key",
      pages: [{
        source: "buffer" as const,
        buffer: Buffer.from("replayed-upload"),
        mimetype: "image/jpeg",
        originalname: "replayed.jpg",
      }],
    };
    const created = await uploadAndScan(owner.user.id, submission);
    const stale = new Date(NOW.getTime() - 6 * DAY_MS);
    await prisma.receiptScan.update({ where: { id: created.id }, data: { lastActivityAt: stale } });

    const replayed = await uploadAndScan(owner.user.id, submission);
    expect(replayed.id).toBe(created.id);
    expect((await activityOf(created.id)).getTime()).toBeGreaterThan(stale.getTime());
    expect(storage.uploadReceiptImage).toHaveBeenCalledTimes(1);
  });
});

describe("worker activity stamps", () => {
  it("stamps claim, heartbeat, and failure recording", async () => {
    const stale = new Date(NOW.getTime() - 10 * DAY_MS);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/two-page-1.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        nextProcessingAttemptAt: new Date(0),
        lastActivityAt: stale,
        pages: {
          create: [
            { pageNumber: 1, imageFile: `${owner.profile.id}/two-page-1.jpg` },
            { pageNumber: 2, imageFile: `${owner.profile.id}/two-page-2.jpg` },
          ],
        },
      },
    });

    const observed: Date[] = [];
    storage.inspectReceiptImage.mockReset().mockImplementation(async (path: string) => {
      observed.push(await activityOf(scan.id));
      if (path.endsWith("two-page-1.jpg")) {
        // Wind the clock back after the claim so the page heartbeat that
        // follows this inspect is the only thing that can move it again.
        await prisma.receiptScan.update({ where: { id: scan.id }, data: { lastActivityAt: stale } });
        return { sizeBytes: 128, mimetype: "image/jpeg" };
      }
      throw new Error("storage outage");
    });

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(observed).toHaveLength(2);
    // Page 1 inspect ran right after claimScan stamped the clock.
    expect(observed[0]!.getTime()).toBeGreaterThan(stale.getTime());
    // Page 2 inspect ran right after the heartbeat re-stamped it.
    expect(observed[1]!.getTime()).toBeGreaterThan(stale.getTime());

    await prisma.receiptScan.update({ where: { id: scan.id }, data: { lastActivityAt: stale } });
    storage.inspectReceiptImage.mockReset().mockRejectedValue(new Error("storage outage"));
    await prisma.receiptScan.update({ where: { id: scan.id }, data: { nextProcessingAttemptAt: new Date(0) } });
    expect(await runReceiptWorkerOnce()).toBe(true);
    const afterFailure = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(afterFailure.processingErrorCode).toBe("RECEIPT_EVIDENCE_UNAVAILABLE");
    expect(afterFailure.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("stamps a completed processing commit", async () => {
    const stale = new Date(NOW.getTime() - 10 * DAY_MS);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/committed.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        processingWorkerId: "sweep-test-worker",
        processingAttemptCount: 1,
        lastActivityAt: stale,
        pages: { create: [{ pageNumber: 1, imageFile: `${owner.profile.id}/committed.jpg` }] },
      },
    });

    await persistReceiptProcessingOutput(
      scan.id,
      owner.profile.id,
      { workerId: "sweep-test-worker", attempt: 1 },
      {
        scan: { rawText: "TOTAL 100.00", extractedAmount: 100 },
        pages: [{ pageNumber: 1, data: { rawText: "TOTAL 100.00" } }],
        items: {
          parsedItems: [],
          vendor: null,
          extractedByVision: false,
          amountConfidences: [],
          itemEvidence: [],
        },
      },
    );

    const committed = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(committed.processingStatus).toBe("Complete");
    expect(committed.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime());
  });
});

describe("abandoned-scan sweep: adversarial states", () => {
  it("skips a stale scan whose business profile is gone, without throwing", async () => {
    const stale = new Date(CUTOFF.getTime() - DAY_MS);
    const orphaned = await makeScan({ lastActivityAt: stale, label: "orphaned" });
    // ReceiptScan.businessProfileId is SetNull on profile deletion; the sweep
    // reads businessProfileId: { not: null } and the enqueue re-checks it.
    await prisma.receiptScan.update({ where: { id: orphaned.id }, data: { businessProfileId: null } });

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({
      candidates: 0,
      enqueued: 0,
    });
    expect(await purgeJobsFor(orphaned.id)).toHaveLength(0);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: orphaned.id } })).toMatchObject({
      businessProfileId: null,
      confirmationStatus: "Pending",
      evidenceDeletionRequestedAt: null,
      lastActivityAt: stale,
    });
  });

  it("skips a stale Pending scan that already has an expense record linked to it", async () => {
    const stale = new Date(CUTOFF.getTime() - DAY_MS);
    const halfConfirmed = await makeScan({ lastActivityAt: stale, label: "half-confirmed" });
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: owner.profile.id,
        categoryId: owner.categories.Inventory!,
        receiptScanId: halfConfirmed.id,
        date: new Date("2026-09-01T00:00:00.000Z"),
        description: "Rice purchase",
        amount: 100,
        source: "RECEIPT_SCAN",
      },
    });

    // Never a candidate: the read excludes it so it cannot occupy a batch
    // slot every tick; the locked re-check still refuses it in a race.
    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({
      candidates: 0,
      enqueued: 0,
      skipped: 0,
    });
    expect(await purgeJobsFor(halfConfirmed.id)).toHaveLength(0);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: halfConfirmed.id } })).toMatchObject({
      confirmationStatus: "Pending",
      evidenceDeletionRequestedAt: null,
    });
    expect(await prisma.expenseRecord.count({ where: { receiptScanId: halfConfirmed.id } })).toBe(1);
  });

  it("a sweep racing the owner's own delete leaves exactly one DELETE_SCAN job", async () => {
    const abandoned = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - DAY_MS), label: "raced" });

    const [sweep, deleted] = await Promise.all([
      sweepAbandonedReceiptScans({ now: NOW }),
      request(app)
        .delete(`${RECEIPTS}/${abandoned.id}`)
        .set(...auth("owner-token"))
        .set("Idempotency-Key", "owner-deletes-during-sweep"),
    ]);

    expect([202, 409]).toContain(deleted.status);
    const jobs = await purgeJobsFor(abandoned.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      businessProfileId: owner.profile.id,
      receiptScanBusinessProfileId: owner.profile.id,
      mode: "DELETE_SCAN",
    });
    expect(["OWNER_REQUEST", "ABANDONED_SCAN"]).toContain(jobs[0]!.reason);
    expect(sweep.enqueued + (jobs[0]!.reason === "OWNER_REQUEST" ? 1 : 0)).toBe(1);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({
      confirmationStatus: "Deletion Pending",
      evidenceDeletionRequestedAt: expect.any(Date),
    });

    // Neither party enqueues a second job once the row is Deletion Pending.
    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ enqueued: 0 });
    expect(await purgeJobsFor(abandoned.id)).toHaveLength(1);
  });
});

describe("abandoned-scan sweep: head-of-list starvation", () => {
  it("does not let older permanently ineligible rows fill the batch and hide a younger abandoned scan", async () => {
    const older = new Date(CUTOFF.getTime() - 3 * DAY_MS);
    const halfConfirmed = [];
    for (let index = 0; index < 3; index++) {
      const scan = await makeScan({ lastActivityAt: new Date(older.getTime() + index), label: `half-${index}` });
      await prisma.expenseRecord.create({
        data: {
          businessProfileId: owner.profile.id,
          categoryId: owner.categories.Inventory!,
          receiptScanId: scan.id,
          date: new Date("2026-09-01T00:00:00.000Z"),
          description: "Rice purchase",
          amount: 100,
          source: "RECEIPT_SCAN",
        },
      });
      halfConfirmed.push(scan);
    }
    const younger = await makeScan({ lastActivityAt: new Date(CUTOFF.getTime() - DAY_MS), label: "younger" });

    // Batch of two: the three older rows would otherwise be the whole read,
    // every tick, and the younger scan would never be reached.
    await expect(sweepAbandonedReceiptScans({ now: NOW, batchSize: 2 })).resolves.toMatchObject({
      candidates: 1,
      enqueued: 1,
      skipped: 0,
    });
    expect(await purgeJobsFor(younger.id)).toHaveLength(1);
    for (const scan of halfConfirmed) {
      expect(await purgeJobsFor(scan.id)).toHaveLength(0);
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
        confirmationStatus: "Pending",
      });
    }
  });
});

describe("abandoned-scan sweep: capture batches", () => {
  async function makeBatch(expectedReceiptCount: number, businessProfileId = owner.profile.id) {
    return prisma.receiptCaptureBatch.create({
      data: {
        businessProfileId,
        clientBatchKey: `sweep-batch-${Math.random().toString(36).slice(2, 10)}`,
        expectedReceiptCount,
      },
    });
  }

  it("leaves a batch alone while a sibling is still under review, then sweeps it whole", async () => {
    const batch = await makeBatch(2);
    const stale = new Date(CUTOFF.getTime() - DAY_MS);
    const recent = new Date(NOW.getTime() - 2 * DAY_MS);
    const abandonedChild = await makeScan({ lastActivityAt: stale, captureBatchId: batch.id, receiptOrdinal: 1, label: "child-1" });
    const reviewedChild = await makeScan({ lastActivityAt: recent, captureBatchId: batch.id, receiptOrdinal: 2, label: "child-2" });

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ candidates: 0, enqueued: 0 });
    expect(await purgeJobsFor(abandonedChild.id)).toHaveLength(0);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "COLLECTING",
      finishedAt: null,
    });
    const batchView = await request(app)
      .get(`/api/v1/records/receipt-batches/${batch.id}`)
      .set(...auth("owner-token"));
    expect(batchView.status).toBe(200);
    expect(batchView.body.status).not.toBe("CANCELLED");
    expect(batchView.body.receipts).toHaveLength(2);

    // Once the reviewed sibling has also gone quiet for a week, the batch is
    // abandoned as a whole: both children go and the batch is cancelled.
    const later = new Date(recent.getTime() + ABANDONED_SCAN_RETENTION_MS + MINUTE_MS);
    await expect(sweepAbandonedReceiptScans({ now: later })).resolves.toMatchObject({ enqueued: 2 });
    expect(await purgeJobsFor(abandonedChild.id)).toHaveLength(1);
    expect(await purgeJobsFor(reviewedChild.id)).toHaveLength(1);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "CANCELLED",
      finishedAt: expect.any(Date),
    });
  });

  it("treats a sibling still owned by the processing pipeline as live", async () => {
    const batch = await makeBatch(2);
    const stale = new Date(CUTOFF.getTime() - DAY_MS);
    const finished = await makeScan({ lastActivityAt: stale, captureBatchId: batch.id, receiptOrdinal: 1 });
    await makeScan({ processingStatus: "Processing", lastActivityAt: stale, captureBatchId: batch.id, receiptOrdinal: 2 });

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ candidates: 0, enqueued: 0 });
    expect(await purgeJobsFor(finished.id)).toHaveLength(0);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "COLLECTING",
    });
  });

  it("sweeps a stale child whose only sibling is already confirmed, and cancels the batch", async () => {
    const batch = await makeBatch(2);
    const stale = new Date(CUTOFF.getTime() - DAY_MS);
    const abandonedChild = await makeScan({ lastActivityAt: stale, captureBatchId: batch.id, receiptOrdinal: 1 });
    const confirmedChild = await makeScan({
      confirmationStatus: "Confirmed",
      lastActivityAt: new Date(NOW.getTime() - MINUTE_MS),
      captureBatchId: batch.id,
      receiptOrdinal: 2,
    });

    await expect(sweepAbandonedReceiptScans({ now: NOW })).resolves.toMatchObject({ candidates: 1, enqueued: 1 });
    expect(await purgeJobsFor(abandonedChild.id)).toHaveLength(1);
    expect(await purgeJobsFor(confirmedChild.id)).toHaveLength(0);
    expect(await prisma.receiptCaptureBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      status: "CANCELLED",
    });

    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await runReceiptPurgeWorkerOnce()).toBe(true);
    expect(await prisma.receiptScan.findUnique({ where: { id: abandonedChild.id } })).toBeNull();
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: confirmedChild.id } })).toMatchObject({
      confirmationStatus: "Confirmed",
    });
  });
});
