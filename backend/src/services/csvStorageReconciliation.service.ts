import { createHash } from "node:crypto";
import { CsvSourcePurgeStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { enqueueDetachedCsvSourcePurge } from "./csvSourcePurge.service";
import { listCsvFilesForProfile } from "./storage.service";

export interface CsvStorageReconciliationOptions {
  businessProfileId: number;
  delete: boolean;
  maxObjects?: number;
  offset?: number;
  graceDays?: number;
  now?: Date;
}

export interface CsvStorageReconciliationResult {
  mode: "audit" | "delete";
  scanned: number;
  truncated: boolean;
  protectedByBatch: number;
  protectedByPurge: number;
  failedPurge: number;
  tooRecent: number;
  unsafeOrUnknownAge: number;
  orphanCandidates: number;
  queued: number;
  candidateHashes: string[];
}

const UUID_CSV_OBJECT = /^[0-9]+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/i;

function objectAgeDate(createdAt: string | null, updatedAt: string | null): Date | null {
  const created = createdAt ? new Date(createdAt) : null;
  const updated = updatedAt ? new Date(updatedAt) : null;
  if (!created || !Number.isFinite(created.getTime())) return null;
  if (updatedAt && (!updated || !Number.isFinite(updated.getTime()))) return null;
  return updated && updated > created ? updated : created;
}

export async function reconcileCsvStorageProfile(
  options: CsvStorageReconciliationOptions,
): Promise<CsvStorageReconciliationResult> {
  const { businessProfileId, delete: shouldDelete } = options;
  const maxObjects = options.maxObjects ?? 500;
  const offset = options.offset ?? 0;
  const graceDays = options.graceDays ?? 7;
  if (!Number.isSafeInteger(businessProfileId) || businessProfileId <= 0) throw new Error("Invalid business profile ID");
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 1_000) throw new Error("maxObjects must be 1..1000");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be nonnegative");
  if (!Number.isSafeInteger(graceDays) || graceDays < 7 || graceDays > 365) throw new Error("graceDays must be 7..365");

  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60_000);
  const { objects, truncated } = await listCsvFilesForProfile(businessProfileId, maxObjects, offset);
  const paths = objects.map((object) => object.path);
  const [batches, purgeJobs] = await Promise.all([
    prisma.cSVImportBatch.findMany({
      where: { businessProfileId, fileReference: { in: paths } },
      select: { fileReference: true },
    }),
    prisma.cSVSourcePurgeJob.findMany({
      where: {
        businessProfileId,
        fileReference: { in: paths },
        status: { not: CsvSourcePurgeStatus.COMPLETE },
      },
      select: { fileReference: true, status: true },
    }),
  ]);
  const batchReferences = new Set(batches.map((batch) => batch.fileReference));
  const purgeReferences = new Set(purgeJobs.map((job) => job.fileReference));
  const failedPurgeReferences = new Set(
    purgeJobs.filter((job) => job.status === CsvSourcePurgeStatus.FAILED).map((job) => job.fileReference),
  );
  const result: CsvStorageReconciliationResult = {
    mode: shouldDelete ? "delete" : "audit",
    scanned: objects.length,
    truncated,
    protectedByBatch: 0,
    protectedByPurge: 0,
    failedPurge: 0,
    tooRecent: 0,
    unsafeOrUnknownAge: 0,
    orphanCandidates: 0,
    queued: 0,
    candidateHashes: [],
  };

  for (const object of objects) {
    if (batchReferences.has(object.path)) {
      result.protectedByBatch += 1;
      continue;
    }
    if (purgeReferences.has(object.path)) {
      result.protectedByPurge += 1;
      if (failedPurgeReferences.has(object.path)) result.failedPurge += 1;
      continue;
    }
    const ageDate = objectAgeDate(object.createdAt, object.updatedAt);
    if (!UUID_CSV_OBJECT.test(object.path) || !object.path.startsWith(`${businessProfileId}/`) || !ageDate) {
      result.unsafeOrUnknownAge += 1;
      continue;
    }
    if (ageDate > cutoff) {
      result.tooRecent += 1;
      continue;
    }
    result.orphanCandidates += 1;
    result.candidateHashes.push(createHash("sha256").update(object.path).digest("hex").slice(0, 16));
    if (!shouldDelete) continue;

    const active = await prisma.cSVImportBatch.count({ where: { fileReference: object.path } });
    const queued = await prisma.cSVSourcePurgeJob.count({
      where: { fileReference: object.path, status: { not: CsvSourcePurgeStatus.COMPLETE } },
    });
    if (active || queued) continue;
    await enqueueDetachedCsvSourcePurge(businessProfileId, 0, object.path);
    result.queued += 1;
  }
  return result;
}
