import { randomUUID } from "node:crypto";
import { AccountDeletionStage, AccountStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  calls: [] as string[],
  failures: new Set<string>(),
  delayMs: 0,
  blockPath: null as string | null,
  blocked: false,
  onBlocked: null as (() => void) | null,
  release: null as Promise<void> | null,
}));

async function removeStored(path: string): Promise<boolean> {
  storage.calls.push(path);
  storage.active += 1;
  storage.maxActive = Math.max(storage.maxActive, storage.active);
  try {
    if (storage.blockPath === path && !storage.blocked) {
      storage.blocked = true;
      storage.onBlocked?.();
      if (storage.release) await storage.release;
    }
    if (storage.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, storage.delayMs));
    return !storage.failures.has(path);
  } finally {
    storage.active -= 1;
  }
}

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: { admin: { deleteUser: async () => ({ data: {}, error: null }) } },
    },
  };
});

vi.mock("../../src/services/storage.service", () => ({
  deleteReceiptImage: removeStored,
  deleteCsvFile: removeStored,
  deletePublicImageUrl: removeStored,
}));

import { prisma } from "../../src/config/prisma";
import { runAccountDeletionWorkerOnce } from "../../src/services/accountDeletion.service";
import {
  CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS,
  STAGING_UPLOAD_LEASE_MS,
} from "../../src/services/csvImport.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

beforeEach(async () => {
  await resetDb();
  storage.active = 0;
  storage.maxActive = 0;
  storage.calls.length = 0;
  storage.failures.clear();
  storage.delayMs = 0;
  storage.blockPath = null;
  storage.blocked = false;
  storage.onBlocked = null;
  storage.release = null;
});

afterAll(disconnectDb);

async function markDeletionPending(userId: number, requestedAt = new Date()) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      status: AccountStatus.DELETION_PENDING,
      deletionRequestedAt: requestedAt,
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionNextAttemptAt: requestedAt,
    },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("account deletion worker leases", () => {
  it("waits without consuming an attempt while a CSV upload reservation is live", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const fileReference = `${owner.profile.id}/staging-live.csv`;
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: owner.profile.id,
        title: "Uploading CSV",
        uploadDate: new Date(),
        status: "Needs Review",
        processingStatus: "STAGING",
        fileReference,
        stageId: randomUUID(),
        stageExpiresAt: new Date(Date.now() + 60 * 60_000),
        heartbeatAt: new Date(),
        workerId: "stage:test-live",
      },
    });
    await markDeletionPending(owner.user.id);

    expect(await runAccountDeletionWorkerOnce()).toBe(true);

    expect(storage.calls).not.toContain(fileReference);
    const waiting = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(waiting).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionWorkerId: null,
    });
    expect(waiting.deletionNextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.cSVImportBatch.count({ where: { fileReference } })).toBe(1);
  });

  it.each(["STAGING", "PROCESSING"] as const)(
    "keeps a stale %s reservation until its upload ambiguity deadline",
    async (processingStatus) => {
      const owner = await makeOwnerWithProfile({}, ["Inventory"]);
      const fileReference = `${owner.profile.id}/${processingStatus.toLowerCase()}-ambiguous.csv`;
      const activityAt = new Date(Date.now() - 3 * 60_000);
      const batch = await prisma.cSVImportBatch.create({
        data: {
          businessProfileId: owner.profile.id,
          title: `Ambiguous ${processingStatus}`,
          uploadDate: activityAt,
          createdAt: activityAt,
          status: "Needs Review",
          processingStatus,
          fileReference,
          stageId: processingStatus === "STAGING" ? randomUUID() : null,
          stageExpiresAt: processingStatus === "STAGING"
            ? new Date(Date.now() + 60 * 60_000)
            : null,
          heartbeatAt: activityAt,
          workerId: "request-that-stopped-heartbeating",
        },
      });
      await markDeletionPending(owner.user.id);

      expect(await runAccountDeletionWorkerOnce()).toBe(true);
      const waiting = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
      const expectedDeadline = activityAt.getTime()
        + STAGING_UPLOAD_LEASE_MS
        + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS;
      expect(waiting).toMatchObject({
        deletionStage: AccountDeletionStage.REQUESTED,
        deletionAttempts: 0,
        deletionStorageCheckpoint: 0,
        deletionWorkerId: null,
      });
      expect(waiting.deletionNextAttemptAt.getTime()).toBeGreaterThanOrEqual(expectedDeadline - 1_000);
      expect(storage.calls).not.toContain(fileReference);
      expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batch.id } }))
        .toMatchObject({ fileReference, processingStatus });

      await prisma.$transaction([
        prisma.cSVImportBatch.update({
          where: { id: batch.id },
          data: { heartbeatAt: new Date(Date.now() - 8 * 60_000) },
        }),
        prisma.user.update({
          where: { id: owner.user.id },
          data: { deletionNextAttemptAt: new Date(Date.now() - 1_000) },
        }),
      ]);
      expect(await runAccountDeletionWorkerOnce()).toBe(true);
      expect(storage.calls).toContain(fileReference);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).toMatchObject({
        deletionStage: AccountDeletionStage.STORAGE_CLEARED,
      });
      expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batch.id } }))
        .toMatchObject({ fileReference });
    },
  );

  it("does not retire a future purge inserted after the storage plan was verified", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const fileReference = `${owner.profile.id}/late-future-purge.csv`;
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: owner.profile.id,
        title: "Completed import with source",
        uploadDate: new Date(),
        status: "Completed",
        processingStatus: "COMPLETE",
        fileReference,
      },
    });
    await markDeletionPending(owner.user.id);
    const entered = deferred();
    const release = deferred();
    storage.blockPath = fileReference;
    storage.onBlocked = entered.resolve;
    storage.release = release.promise;

    const deletion = runAccountDeletionWorkerOnce();
    await entered.promise;
    const notBefore = new Date(Date.now() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS);
    const lateJob = await prisma.cSVSourcePurgeJob.create({
      data: {
        businessProfileId: owner.profile.id,
        sourceBatchId: 5001,
        targetHash: "f".repeat(64),
        fileReference,
        nextAttemptAt: notBefore,
      },
    });
    release.resolve();
    await expect(deletion).resolves.toBe(true);

    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionStorageCheckpoint: 0,
      deletionWorkerId: null,
    });
    expect(await prisma.cSVSourcePurgeJob.findUniqueOrThrow({ where: { id: lateJob.id } })).toMatchObject({
      status: "PENDING",
      fileReference,
    });
    expect(storage.calls.filter((value) => value === fileReference)).toHaveLength(1);
  });

  it("does not let a second worker pass claim a live lease", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const path = "https://example.test/avatar-live-lease.png";
    await prisma.user.update({ where: { id: owner.user.id }, data: { avatarUrl: path } });
    await markDeletionPending(owner.user.id);

    const entered = deferred();
    const release = deferred();
    storage.blockPath = path;
    storage.onBlocked = entered.resolve;
    storage.release = release.promise;

    const first = runAccountDeletionWorkerOnce();
    await entered.promise;
    await expect(runAccountDeletionWorkerOnce()).resolves.toBe(false);

    const leased = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(leased.deletionWorkerId).not.toBeNull();
    expect(leased.deletionClaimVersion).toBe(1);

    release.resolve();
    await expect(first).resolves.toBe(true);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).resolves.toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
      deletionWorkerId: null,
    });
  });

  it("fences an expired attempt after a newer claim finishes the stage", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const path = "https://example.test/avatar-expired-lease.png";
    await prisma.user.update({ where: { id: owner.user.id }, data: { avatarUrl: path } });
    await markDeletionPending(owner.user.id);

    const entered = deferred();
    const release = deferred();
    storage.blockPath = path;
    storage.onBlocked = entered.resolve;
    storage.release = release.promise;

    const staleAttempt = runAccountDeletionWorkerOnce();
    await entered.promise;
    await prisma.user.update({
      where: { id: owner.user.id },
      data: { deletionHeartbeatAt: new Date(Date.now() - 5 * 60_000) },
    });

    await expect(runAccountDeletionWorkerOnce()).resolves.toBe(true);
    release.resolve();
    await expect(staleAttempt).resolves.toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(user).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
      deletionAttempts: 0,
      deletionClaimVersion: 2,
      deletionWorkerId: null,
    });
    expect(storage.calls.filter((value) => value === path)).toHaveLength(2);
  });

  it("backs off a failed oldest account so the next deletion can run", async () => {
    const oldest = await makeOwnerWithProfile({ name: "Oldest" }, ["Inventory"]);
    const next = await makeOwnerWithProfile({ name: "Next" }, ["Inventory"]);
    const failedPath = "https://example.test/avatar-fails.png";
    await prisma.user.update({ where: { id: oldest.user.id }, data: { avatarUrl: failedPath } });
    const now = Date.now();
    await markDeletionPending(oldest.user.id, new Date(now - 2_000));
    await markDeletionPending(next.user.id, new Date(now - 1_000));
    storage.failures.add(failedPath);

    await expect(runAccountDeletionWorkerOnce()).resolves.toBe(true);
    const failed = await prisma.user.findUniqueOrThrow({ where: { id: oldest.user.id } });
    expect(failed.deletionAttempts).toBe(1);
    expect(failed.deletionNextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(failed.deletionWorkerId).toBeNull();

    await expect(runAccountDeletionWorkerOnce()).resolves.toBe(true);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: next.user.id } })).resolves.toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
    });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: oldest.user.id } })).resolves.toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
    });
  });

  it("checkpoints bounded Storage batches and resumes after a failed batch", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const paths = Array.from({ length: 9 }, (_, index) => `receipts/checkpoint-${index}.jpg`);
    for (const [index, path] of paths.entries()) {
      await prisma.receiptScan.create({
        data: {
          businessProfileId: owner.profile.id,
          imageFile: path,
          processingStatus: "Complete",
          pages: { create: { pageNumber: 1, imageFile: path } },
          uploadKey: randomUUID(),
          uploadHash: String(index).padStart(64, "0"),
        },
      });
    }
    await markDeletionPending(owner.user.id);
    storage.delayMs = 5;
    storage.failures.add(paths[4]!);

    await expect(runAccountDeletionWorkerOnce()).resolves.toBe(true);
    let user = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(user).toMatchObject({
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 1,
      deletionStorageCheckpoint: 4,
    });
    expect(user.deletionStorageManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.maxActive).toBeLessThanOrEqual(4);
    expect(storage.maxActive).toBeGreaterThan(1);

    storage.failures.clear();
    await prisma.user.update({
      where: { id: owner.user.id },
      data: { deletionNextAttemptAt: new Date(0) },
    });
    await expect(runAccountDeletionWorkerOnce()).resolves.toBe(true);
    user = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(user).toMatchObject({
      deletionStage: AccountDeletionStage.STORAGE_CLEARED,
      deletionStorageCheckpoint: 0,
      deletionStorageManifestHash: null,
    });
    for (const path of paths.slice(0, 4)) {
      expect(storage.calls.filter((value) => value === path)).toHaveLength(1);
    }
  });

  it("deletes queued CSV source evidence before removing its durable job", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const fileReference = `${owner.profile.id}/queued-source.csv`;
    const job = await prisma.cSVSourcePurgeJob.create({
      data: {
        businessProfileId: owner.profile.id,
        sourceBatchId: 91,
        targetHash: "a".repeat(64),
        fileReference,
      },
    });
    await markDeletionPending(owner.user.id);

    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(storage.calls).toContain(fileReference);
    expect(await prisma.cSVSourcePurgeJob.findUnique({ where: { id: job.id } })).not.toBeNull();

    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(await runAccountDeletionWorkerOnce()).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: owner.user.id } })).toBeNull();
    expect(await prisma.cSVSourcePurgeJob.findUnique({ where: { id: job.id } })).toBeNull();
  });
});
