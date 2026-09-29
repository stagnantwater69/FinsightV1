import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  AccountDeletionStage,
  AccountStatus,
  CsvImportProcessingStatus,
  Prisma,
} from "@prisma/client";
import { supabaseAdmin } from "../config/supabase";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { securityEvent } from "../lib/securityLog";
import { deleteCsvFile, deletePublicImageUrl, deleteReceiptImage } from "./storage.service";
import {
  CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS,
  STAGING_UPLOAD_LEASE_MS,
} from "./csvImport.service";

/**
 * Draining an account that asked to be deleted, one resumable stage at a time.
 *
 * THE ORDER IS THE DESIGN, and it is the reverse of the obvious one. Objects in
 * Storage can only be found through the rows that name them, so the rows have
 * to outlive the objects: deleting the database first would orphan every
 * receipt image permanently, invisible to us and undeletable by anyone. So the
 * relational graph — the only map of what to delete — goes last.
 *
 *   REQUESTED        → storage objects removed        → STORAGE_CLEARED
 *   STORAGE_CLEARED  → Supabase Auth identity removed → AUTH_DELETED
 *   AUTH_DELETED     → relational rows cascade-deleted → (gone)
 *
 * The stage is written AFTER the work it names succeeds, and each stage is
 * idempotent, so a process killed anywhere in here resumes at the stage that
 * was in flight and repeats at worst one already-completed step. Deleting an
 * object that is already gone, or an auth user that is already deleted, is a
 * no-op — which is what makes the repeat safe.
 *
 * Access does NOT depend on any of this. It ended when the request came in:
 * `deleteAccount` moves the account to DELETION_PENDING, which bans the auth
 * identity and is refused by both login and requireAuth. Everything here is
 * about destroying data, not about denying access, and it is therefore allowed
 * to take as long as it takes.
 */

/**
 * Stop retrying after this many failed passes and wait for a human.
 *
 * Not infinite: a permanently failing deletion — a bucket that no longer
 * exists, a revoked key — would otherwise retry every five seconds forever,
 * burying the actual cause under identical log lines. It surfaces on
 * /health/ready as `stalledAccountDeletions` instead.
 */
const MAX_DELETION_ATTEMPTS = 10;
const DELETION_WORKER_ID = `account-delete:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const DELETION_LEASE_MS = 2 * 60_000;
const STORAGE_DELETE_CONCURRENCY = 4;
const LIVE_CSV_UPLOAD_RETRY_MS = 5_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** How long an unconfirmed registration holds its email address before being purged. */
const UNVERIFIED_TTL_MS = 72 * 60 * 60 * 1000;

class AccountDeletionLeaseLostError extends Error {
  constructor(userId: number) {
    super(`Account deletion lease for user ${userId} was reclaimed`);
    this.name = "AccountDeletionLeaseLostError";
  }
}

type ClaimedDeletion = {
  id: number;
  authId: string;
  stage: AccountDeletionStage;
  deletionAttempts: number;
  claimVersion: number;
};

type StorageDeletionTask = {
  key: string;
  remove: () => Promise<boolean>;
};

function leaseGuard(job: ClaimedDeletion) {
  return {
    id: job.id,
    status: AccountStatus.DELETION_PENDING,
    deletionStage: job.stage,
    deletionWorkerId: DELETION_WORKER_ID,
    deletionClaimVersion: job.claimVersion,
  };
}

function storageManifestHash(tasks: StorageDeletionTask[]): string {
  const hash = createHash("sha256");
  hash.update("account-deletion-storage-v1\0");
  for (const task of tasks) hash.update(`${Buffer.byteLength(task.key)}:`).update(task.key);
  return hash.digest("hex");
}

async function loadStoragePlan(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      avatarUrl: true,
      deletionStorageManifestHash: true,
      deletionStorageCheckpoint: true,
      businessProfiles: {
        select: {
          id: true,
          logoUrl: true,
          receiptScans: {
            select: {
              imageFile: true,
              pages: { select: { imageFile: true, processedImageFile: true } },
            },
          },
          csvImportBatches: {
            select: {
              fileReference: true,
              processingStatus: true,
              heartbeatAt: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  if (!user) throw new AccountDeletionLeaseLostError(userId);
  const profileIds = user.businessProfiles.map((profile) => profile.id);
  const queuedCsvPurges = profileIds.length > 0
    ? await prisma.cSVSourcePurgeJob.findMany({
        where: { businessProfileId: { in: profileIds } },
        select: { fileReference: true, nextAttemptAt: true },
      })
    : [];

  const byKey = new Map<string, StorageDeletionTask>();
  const liveUploadCutoff = Date.now() - STAGING_UPLOAD_LEASE_MS;
  let hasLiveCsvUpload = false;
  let csvUploadNotBefore: Date | null = null;
  const add = (kind: "receipt" | "csv" | "public", value: string | null, remove: () => Promise<boolean>) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (!byKey.has(key)) byKey.set(key, { key, remove });
  };

  add("public", user.avatarUrl, () => deletePublicImageUrl(user.avatarUrl!));
  for (const profile of user.businessProfiles) {
    add("public", profile.logoUrl, () => deletePublicImageUrl(profile.logoUrl!));
    for (const scan of profile.receiptScans) {
      add("receipt", scan.imageFile, () => deleteReceiptImage(scan.imageFile!));
      for (const page of scan.pages) {
        add("receipt", page.imageFile, () => deleteReceiptImage(page.imageFile));
        add("receipt", page.processedImageFile, () => deleteReceiptImage(page.processedImageFile!));
      }
    }
    for (const batch of profile.csvImportBatches) {
      if (
        batch.processingStatus === CsvImportProcessingStatus.STAGING ||
        batch.processingStatus === CsvImportProcessingStatus.PROCESSING
      ) {
        if (batch.heartbeatAt !== null && batch.heartbeatAt.getTime() > liveUploadCutoff) {
          hasLiveCsvUpload = true;
        }
        const lastReservationActivity = batch.heartbeatAt ?? batch.createdAt;
        const notBefore = new Date(
          lastReservationActivity.getTime() +
          STAGING_UPLOAD_LEASE_MS +
          CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS,
        );
        if (
          notBefore.getTime() > Date.now() &&
          (csvUploadNotBefore === null || notBefore > csvUploadNotBefore)
        ) {
          csvUploadNotBefore = notBefore;
        }
      }
      add("csv", batch.fileReference, () => deleteCsvFile(batch.fileReference!));
    }
  }
  for (const job of queuedCsvPurges) {
    add("csv", job.fileReference, () => deleteCsvFile(job.fileReference!));
  }

  const now = Date.now();
  const csvPurgeNotBefore = queuedCsvPurges.reduce<Date | null>((latest, job) => {
    if (!job.fileReference || job.nextAttemptAt.getTime() <= now) return latest;
    return latest === null || job.nextAttemptAt > latest ? job.nextAttemptAt : latest;
  }, null);

  const tasks = [...byKey.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return {
    tasks,
    profileIds,
    manifestHash: storageManifestHash(tasks),
    storedManifestHash: user.deletionStorageManifestHash,
    storedCheckpoint: user.deletionStorageCheckpoint,
    hasLiveCsvUpload,
    csvUploadNotBefore,
    csvPurgeNotBefore,
  };
}

/**
 * THE LAST STAGE: the relational graph, INCLUDING THE ROWS THAT DO NOT CASCADE.
 *
 * `prisma.user.delete` cascades through BusinessProfile to records, categories,
 * notifications, import batches and the rest. It does NOT reach receipt scans.
 * ReceiptScan's relation to BusinessProfile is `onDelete: SetNull` — that
 * nullable link exists so a scan survives a profile being reorganised — with
 * the consequence that deleting the owner merely detached the scan instead of
 * removing it. The row stayed behind holding the receipt's raw OCR text, the
 * extracted vendor, amount and date, and the storage paths of the photographs;
 * its pages, items and field corrections cascade FROM THE SCAN, so they stayed
 * too. Nothing referenced them any more, which made them unreachable rather
 * than deleted: the worst of both — undeletable by the owner, still present in
 * the database, and contradicting this file's own promise that a deleted
 * account leaves nothing behind.
 *
 * So the scans go first, explicitly, and only then the user. Both in ONE
 * transaction, so a failure between them cannot delete a person's receipts
 * while leaving the account that could still see them, or vice versa; a
 * rollback simply means this stage runs again, which it is built to survive.
 *
 * SCOPING IS THE SECURITY-CRITICAL PART. Every delete here is filtered through
 * `businessProfile: { userId }` — this user's own profiles and nothing else.
 * Scans already detached by an earlier deletion (businessProfileId null) are
 * deliberately NOT swept up: they cannot be attributed to anyone, and a
 * blanket "delete orphans" would be a cross-tenant delete in disguise. Those
 * are a pre-existing-data question for a one-off backfill, not for this path.
 *
 * The children are deleted explicitly rather than left to ReceiptScan's own
 * cascades. The cascades would do it today; naming them means a future change
 * to one of those relations shows up as a failing deletion test rather than as
 * more silently surviving receipt data.
 */
async function deleteRelationalDataInTransaction(tx: Prisma.TransactionClient, userId: number): Promise<void> {
  const profiles = await tx.businessProfile.findMany({ where: { userId }, select: { id: true } });
  const profileIds = profiles.map((profile) => profile.id);
  const scans = await tx.receiptScan.findMany({
    where: { businessProfile: { userId } },
    select: { id: true },
  });
  const scanIds = scans.map((scan) => scan.id);

  if (profileIds.length > 0) {
    const pendingCsvPurges = await tx.cSVSourcePurgeJob.count({
      where: {
        businessProfileId: { in: profileIds },
        fileReference: { not: null },
      },
    });
    if (pendingCsvPurges > 0) {
      throw new Error("Account storage cleanup is still pending");
    }
    // These relations deliberately refuse a parent cascade so their audit data cannot disappear independently.
    await tx.cSVSourcePurgeJob.deleteMany({
      where: { businessProfileId: { in: profileIds }, fileReference: null },
    });
    await tx.externalProviderDispatch.deleteMany({ where: { businessProfileId: { in: profileIds } } });
    await tx.externalProcessingConsent.deleteMany({ where: { businessProfileId: { in: profileIds } } });
    await tx.externalProviderBudget.deleteMany({
      where: { scope: "BUSINESS", businessProfileId: { in: profileIds } },
    });
  }

  if (scanIds.length > 0) {
    await tx.receiptPurgeJob.deleteMany({ where: { businessProfileId: { in: profileIds } } });
    await tx.receiptFieldCorrection.deleteMany({ where: { receiptScanId: { in: scanIds } } });
    await tx.receiptScanItem.deleteMany({ where: { receiptScanId: { in: scanIds } } });
    await tx.receiptScanPage.deleteMany({ where: { receiptScanId: { in: scanIds } } });
    await tx.receiptScan.deleteMany({ where: { id: { in: scanIds }, businessProfile: { userId } } });
  }

  await tx.user.delete({ where: { id: userId } });
}

async function deleteRelationalData(userId: number): Promise<void> {
  await prisma.$transaction((tx) => deleteRelationalDataInTransaction(tx, userId));
}

async function deleteClaimedRelationalData(job: ClaimedDeletion): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT "User_ID" AS id
      FROM "User"
      WHERE "User_ID" = ${job.id}
        AND "User_Status" = ${AccountStatus.DELETION_PENDING}::"AccountStatus"
        AND "User_DeletionStage" = ${job.stage}::"AccountDeletionStage"
        AND "User_DeletionWorkerID" = ${DELETION_WORKER_ID}
        AND "User_DeletionClaimVersion" = ${job.claimVersion}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new AccountDeletionLeaseLostError(job.id);
    const profiles = await tx.businessProfile.findMany({ where: { userId: job.id }, select: { id: true } });
    const profileIds = profiles.map((profile) => profile.id);
    const pendingCsvPurges = profileIds.length === 0
      ? 0
      : await tx.cSVSourcePurgeJob.count({
          where: {
            businessProfileId: { in: profileIds },
            fileReference: { not: null },
          },
        });
    if (pendingCsvPurges > 0) {
      await tx.user.update({
        where: { id: job.id },
        data: {
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionLastError: null,
          deletionNextAttemptAt: new Date(),
          deletionStorageManifestHash: null,
          deletionStorageCheckpoint: 0,
          ...releasedLease(),
        },
      });
      return false;
    }
    await deleteRelationalDataInTransaction(tx, job.id);
    return true;
  });
}

async function claimDeletion(): Promise<ClaimedDeletion | null> {
  const staleBefore = new Date(Date.now() - DELETION_LEASE_MS);
  const rows = await prisma.$queryRaw<ClaimedDeletion[]>(Prisma.sql`
    UPDATE "User" SET
      "User_DeletionStage" = COALESCE("User_DeletionStage", 'REQUESTED'::"AccountDeletionStage"),
      "User_DeletionLeaseStartedAt" = CURRENT_TIMESTAMP,
      "User_DeletionHeartbeatAt" = CURRENT_TIMESTAMP,
      "User_DeletionWorkerID" = ${DELETION_WORKER_ID},
      "User_DeletionClaimVersion" = "User_DeletionClaimVersion" + 1
    WHERE "User_ID" = (
      SELECT "User_ID"
      FROM "User"
      WHERE "User_Status" = ${AccountStatus.DELETION_PENDING}::"AccountStatus"
        AND "User_DeletionAttempts" < ${MAX_DELETION_ATTEMPTS}
        AND "User_DeletionNextAttemptAt" <= CURRENT_TIMESTAMP
        AND (
          "User_DeletionWorkerID" IS NULL
          OR "User_DeletionHeartbeatAt" IS NULL
          OR "User_DeletionHeartbeatAt" < ${staleBefore}
        )
      ORDER BY "User_DeletionNextAttemptAt", "User_DeletionRequestedAt" NULLS LAST, "User_ID"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING
      "User_ID" AS id,
      "User_AuthID" AS "authId",
      "User_DeletionStage" AS stage,
      "User_DeletionAttempts" AS "deletionAttempts",
      "User_DeletionClaimVersion" AS "claimVersion"
  `);
  return rows[0] ?? null;
}

async function heartbeatDeletion(job: ClaimedDeletion): Promise<void> {
  const updated = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: { deletionHeartbeatAt: new Date() },
  });
  if (updated.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
}

const releasedLease = () => ({
  deletionWorkerId: null,
  deletionLeaseStartedAt: null,
  deletionHeartbeatAt: null,
});

async function waitForLiveCsvUpload(job: ClaimedDeletion): Promise<void> {
  const released = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: {
      deletionNextAttemptAt: new Date(Date.now() + LIVE_CSV_UPLOAD_RETRY_MS),
      ...releasedLease(),
    },
  });
  if (released.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
  logger.info({ userId: job.id }, "account deletion waiting for active CSV upload");
}

async function waitForCsvPurgeNotBefore(job: ClaimedDeletion, notBefore: Date): Promise<void> {
  const released = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: {
      deletionNextAttemptAt: new Date(Math.max(notBefore.getTime(), Date.now() + 1_000)),
      deletionStorageManifestHash: null,
      deletionStorageCheckpoint: 0,
      ...releasedLease(),
    },
  });
  if (released.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
  logger.info({ userId: job.id }, "account deletion waiting for deferred CSV source purge");
}

async function waitForCsvUploadAmbiguity(job: ClaimedDeletion, notBefore: Date): Promise<void> {
  const released = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: {
      deletionNextAttemptAt: new Date(Math.max(notBefore.getTime(), Date.now() + 1_000)),
      deletionStorageManifestHash: null,
      deletionStorageCheckpoint: 0,
      ...releasedLease(),
    },
  });
  if (released.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
  logger.info({ userId: job.id }, "account deletion waiting for ambiguous CSV upload completion");
}

async function hasPendingCsvPurgeObligation(userId: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ pending: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "CSVSourcePurgeJob" j
      JOIN "BusinessProfile" p ON p."BusinessProfile_ID" = j."BusinessProfile_ID"
      WHERE p."User_ID" = ${userId}
        AND j."CSVSourcePurgeJob_FileReference" IS NOT NULL
    ) AS pending
  `);
  return rows[0]?.pending === true;
}

async function returnToStorageCleanup(job: ClaimedDeletion): Promise<void> {
  const reopened = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: {
      deletionStage: AccountDeletionStage.REQUESTED,
      deletionAttempts: 0,
      deletionLastError: null,
      deletionNextAttemptAt: new Date(),
      deletionStorageManifestHash: null,
      deletionStorageCheckpoint: 0,
      ...releasedLease(),
    },
  });
  if (reopened.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
}

async function processStorageStage(job: ClaimedDeletion): Promise<void> {
  const initial = await loadStoragePlan(job.id);
  if (initial.hasLiveCsvUpload) {
    await waitForLiveCsvUpload(job);
    return;
  }
  if (initial.csvUploadNotBefore) {
    await waitForCsvUploadAmbiguity(job, initial.csvUploadNotBefore);
    return;
  }
  if (initial.csvPurgeNotBefore) {
    await waitForCsvPurgeNotBefore(job, initial.csvPurgeNotBefore);
    return;
  }
  const validStoredCheckpoint = initial.storedCheckpoint >= 0 && initial.storedCheckpoint <= initial.tasks.length;
  let checkpoint = initial.storedManifestHash === initial.manifestHash && validStoredCheckpoint
    ? initial.storedCheckpoint
    : 0;

  if (checkpoint !== initial.storedCheckpoint || initial.storedManifestHash !== initial.manifestHash) {
    const reset = await prisma.user.updateMany({
      where: leaseGuard(job),
      data: {
        deletionStorageManifestHash: initial.manifestHash,
        deletionStorageCheckpoint: 0,
        deletionHeartbeatAt: new Date(),
      },
    });
    if (reset.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
    checkpoint = 0;
  }

  for (let start = checkpoint; start < initial.tasks.length; start += STORAGE_DELETE_CONCURRENCY) {
    const batch = initial.tasks.slice(start, start + STORAGE_DELETE_CONCURRENCY);
    const removed = await Promise.all(batch.map((task) => task.remove()));
    const failures = removed.filter((result) => !result).length;
    if (failures > 0) throw new Error(`${failures} stored file(s) could not be removed`);

    const nextCheckpoint = start + batch.length;
    const saved = await prisma.user.updateMany({
      where: {
        ...leaseGuard(job),
        deletionStorageManifestHash: initial.manifestHash,
        deletionStorageCheckpoint: start,
      },
      data: {
        deletionStorageCheckpoint: nextCheckpoint,
        deletionHeartbeatAt: new Date(),
      },
    });
    if (saved.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
  }

  const verified = await loadStoragePlan(job.id);
  if (verified.hasLiveCsvUpload) {
    await waitForLiveCsvUpload(job);
    return;
  }
  if (verified.csvUploadNotBefore) {
    await waitForCsvUploadAmbiguity(job, verified.csvUploadNotBefore);
    return;
  }
  if (verified.csvPurgeNotBefore) {
    await waitForCsvPurgeNotBefore(job, verified.csvPurgeNotBefore);
    return;
  }
  if (verified.manifestHash !== initial.manifestHash) {
    const restarted = await prisma.user.updateMany({
      where: {
        ...leaseGuard(job),
        deletionStorageManifestHash: initial.manifestHash,
        deletionStorageCheckpoint: initial.tasks.length,
      },
      data: {
        deletionStorageManifestHash: verified.manifestHash,
        deletionStorageCheckpoint: 0,
        deletionNextAttemptAt: new Date(),
        ...releasedLease(),
      },
    });
    if (restarted.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
    return;
  }

  const removedCsvReferences = initial.tasks
    .map((task) => task.key)
    .filter((key) => key.startsWith("csv:"))
    .map((key) => key.slice("csv:".length));
  const finalizationNow = new Date();
  const finalized = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT "User_ID" AS id
      FROM "User"
      WHERE "User_ID" = ${job.id}
        AND "User_Status" = ${AccountStatus.DELETION_PENDING}::"AccountStatus"
        AND "User_DeletionStage" = ${job.stage}::"AccountDeletionStage"
        AND "User_DeletionWorkerID" = ${DELETION_WORKER_ID}
        AND "User_DeletionClaimVersion" = ${job.claimVersion}
        AND "User_DeletionStorageManifestHash" = ${initial.manifestHash}
        AND "User_DeletionStorageCheckpoint" = ${initial.tasks.length}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new AccountDeletionLeaseLostError(job.id);
    const futurePurge = initial.profileIds.length === 0
      ? null
      : await tx.cSVSourcePurgeJob.findFirst({
          where: {
            businessProfileId: { in: initial.profileIds },
            fileReference: { not: null },
            nextAttemptAt: { gt: finalizationNow },
          },
          orderBy: { nextAttemptAt: "desc" },
          select: { nextAttemptAt: true },
        });
    if (futurePurge) {
      const waiting = await tx.user.updateMany({
        where: {
          ...leaseGuard(job),
          deletionStorageManifestHash: initial.manifestHash,
          deletionStorageCheckpoint: initial.tasks.length,
        },
        data: {
          deletionNextAttemptAt: futurePurge.nextAttemptAt,
          deletionStorageManifestHash: null,
          deletionStorageCheckpoint: 0,
          ...releasedLease(),
        },
      });
      return { count: waiting.count, advanced: false };
    }
    if (initial.profileIds.length > 0 && removedCsvReferences.length > 0) {
      await tx.cSVSourcePurgeJob.updateMany({
        where: {
          businessProfileId: { in: initial.profileIds },
          fileReference: { in: removedCsvReferences },
          nextAttemptAt: { lte: finalizationNow },
        },
        data: {
          fileReference: null,
          status: "COMPLETE",
          completedAt: finalizationNow,
          workerId: null,
          leaseStartedAt: null,
          heartbeatAt: null,
          lastErrorCode: null,
        },
      });
    }
    const advanced = await tx.user.updateMany({
      where: {
        ...leaseGuard(job),
        deletionStorageManifestHash: initial.manifestHash,
        deletionStorageCheckpoint: initial.tasks.length,
      },
      data: {
        deletionStage: AccountDeletionStage.STORAGE_CLEARED,
        deletionStorageManifestHash: null,
        deletionStorageCheckpoint: 0,
        deletionNextAttemptAt: new Date(),
        deletionLastError: null,
        ...releasedLease(),
      },
    });
    return { count: advanced.count, advanced: true };
  });
  if (finalized.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
  if (!finalized.advanced) return;
  securityEvent("account.deletion_stage", { userId: job.id, stage: "STORAGE_CLEARED" });
}

async function processAuthStage(job: ClaimedDeletion): Promise<void> {
  if (await hasPendingCsvPurgeObligation(job.id)) {
    await returnToStorageCleanup(job);
    return;
  }
  const { error } = await supabaseAdmin.auth.admin.deleteUser(job.authId, false);
  // A reclaimed attempt can repeat this call; an already-removed identity is success.
  if (error && error.status !== 404) throw new Error(error.message);
  const advanced = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: {
      deletionStage: AccountDeletionStage.AUTH_DELETED,
      deletionNextAttemptAt: new Date(),
      deletionLastError: null,
      ...releasedLease(),
    },
  });
  if (advanced.count !== 1) throw new AccountDeletionLeaseLostError(job.id);
  securityEvent("account.deletion_stage", { userId: job.id, stage: "AUTH_DELETED" });
}

async function recordDeletionFailure(job: ClaimedDeletion, error: unknown): Promise<void> {
  if (error instanceof AccountDeletionLeaseLostError) return;
  const message = error instanceof Error ? error.message : String(error);
  const attempts = job.deletionAttempts + 1;
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
  const failed = await prisma.user.updateMany({
    where: leaseGuard(job),
    data: {
      deletionAttempts: { increment: 1 },
      deletionLastError: message.slice(0, 500),
      deletionNextAttemptAt: new Date(Date.now() + delay),
      ...releasedLease(),
    },
  });
  if (failed.count !== 1) return;
  securityEvent("account.deletion_failed", { userId: job.id, stage: job.stage, attempts, reason: message });
  if (attempts >= MAX_DELETION_ATTEMPTS) {
    logger.error(
      { userId: job.id, stage: job.stage, err: error },
      "account deletion has exhausted its retries and needs manual attention",
    );
  }
}

/** Runs one leased stage and releases it before another stage can begin. */
export async function runAccountDeletionWorkerOnce(): Promise<boolean> {
  const job = await claimDeletion();
  if (!job) return false;
  const heartbeatTimer = setInterval(() => {
    void heartbeatDeletion(job).catch(() => undefined);
  }, Math.floor(DELETION_LEASE_MS / 3));
  heartbeatTimer.unref();

  try {
    if (job.stage === AccountDeletionStage.REQUESTED) {
      await processStorageStage(job);
    } else if (job.stage === AccountDeletionStage.STORAGE_CLEARED) {
      await processAuthStage(job);
    } else if (job.stage === AccountDeletionStage.AUTH_DELETED) {
      const deleted = await deleteClaimedRelationalData(job);
      if (deleted) securityEvent("account.deletion_completed", { userId: job.id });
    } else {
      throw new Error(`Unsupported account deletion stage: ${job.stage}`);
    }
  } catch (error) {
    if (error instanceof AccountDeletionLeaseLostError) {
      logger.warn({ userId: job.id }, "account deletion lease was reclaimed mid-stage");
    } else {
      await recordDeletionFailure(job, error);
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
  return true;
}

/** Deletions that have given up retrying, for the readiness probe to expose. */
export function countStalledAccountDeletions(): Promise<number> {
  return prisma.user.count({
    where: { status: AccountStatus.DELETION_PENDING, deletionAttempts: { gte: MAX_DELETION_ATTEMPTS } },
  });
}

/**
 * Releases addresses held by registrations that were never confirmed.
 *
 * Without this, one abandoned sign-up — a typo, a change of mind — holds an
 * email address permanently, and the person it actually belongs to can never
 * register: their address is taken by an account nobody ever proved they owned.
 * The auth user goes too, so Supabase's own uniqueness check is released with
 * ours.
 */
export async function purgeUnverifiedRegistrations(): Promise<number> {
  const cutoff = new Date(Date.now() - UNVERIFIED_TTL_MS);
  const stale = await prisma.user.findMany({
    where: { status: AccountStatus.PENDING_VERIFICATION, createdAt: { lt: cutoff } },
    select: { id: true, authId: true, email: true },
  });

  let purged = 0;
  for (const user of stale) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(user.authId, false);
    if (error && error.status !== 404) {
      logger.warn({ userId: user.id, err: error }, "could not remove unverified auth user");
      continue;
    }
    // Same non-cascading receipt rows as the main deletion path — an
    // unverified registration is not expected to own any, but "not expected
    // to" is what left them behind there too.
    try {
      await deleteRelationalData(user.id);
    } catch (error) {
      /*
       * This failure used to be swallowed and still counted as a purge.
       *
       * The auth user has already been deleted by the time we get here, so a
       * failure leaves the worst of both: Supabase has released the address
       * but our `User` row still holds it against the unique constraint, and
       * the person it belongs to gets "that email is taken" from an account
       * that no longer exists anywhere else. The log said the purge
       * succeeded, so nothing pointed at the cause.
       *
       * The row stays PENDING_VERIFICATION and past the cutoff, so the next
       * hourly pass retries it; deleting an already-deleted auth user is a
       * 404, which the branch above tolerates. What must not happen is
       * claiming it worked.
       */
      logger.error(
        { userId: user.id, err: error },
        "unverified registration purge left its User row behind; the address is still held",
      );
      securityEvent("account.deletion_failed", {
        userId: user.id,
        email: user.email,
        stage: "relational",
        reason: "unverified expiry: relational delete failed",
      });
      continue;
    }
    securityEvent("account.deletion_completed", { userId: user.id, email: user.email, reason: "unverified expiry" });
    purged++;
  }
  return purged;
}
