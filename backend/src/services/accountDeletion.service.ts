import { AccountDeletionStage, AccountStatus } from "@prisma/client";
import { supabaseAdmin } from "../config/supabase";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { securityEvent } from "../lib/securityLog";
import { deleteCsvFile, deletePublicImageUrl, deleteReceiptImage } from "./storage.service";

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

/** How long an unconfirmed registration holds its email address before being purged. */
const UNVERIFIED_TTL_MS = 72 * 60 * 60 * 1000;

async function clearStorage(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      businessProfiles: {
        select: {
          logoUrl: true,
          receiptScans: { select: { pages: { select: { imageFile: true, processedImageFile: true } } } },
          csvImportBatches: { select: { fileReference: true } },
        },
      },
    },
  });
  if (!user) return;

  const receiptPaths = user.businessProfiles.flatMap((profile) =>
    profile.receiptScans.flatMap((scan) =>
      scan.pages.flatMap((page) => [page.imageFile, page.processedImageFile]).filter((path): path is string => Boolean(path)),
    ),
  );
  const csvPaths = user.businessProfiles
    .flatMap((profile) => profile.csvImportBatches.map((batch) => batch.fileReference))
    .filter((path): path is string => Boolean(path));
  const publicUrls = [user.avatarUrl, ...user.businessProfiles.map((profile) => profile.logoUrl)].filter(
    (url): url is string => Boolean(url),
  );

  const results = await Promise.all([
    ...receiptPaths.map(deleteReceiptImage),
    ...csvPaths.map(deleteCsvFile),
    ...publicUrls.map(deletePublicImageUrl),
  ]);

  /*
   * A partial failure throws, so the pass is retried rather than advancing.
   *
   * This is the one place the old inline version was right and it is kept: if
   * some objects survive, moving on would delete the rows that name them and
   * strand them forever. Re-running this stage re-deletes the ones that already
   * went, which costs nothing.
   */
  if (results.some((removed) => !removed)) {
    throw new Error(`${results.filter((removed) => !removed).length} stored file(s) could not be removed`);
  }
}

/** Runs one stage of one pending deletion. Returns false when there is nothing to do. */
export async function runAccountDeletionWorkerOnce(): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: {
      status: AccountStatus.DELETION_PENDING,
      deletionAttempts: { lt: MAX_DELETION_ATTEMPTS },
    },
    orderBy: { deletionRequestedAt: "asc" },
  });
  if (!user) return false;

  const stage = user.deletionStage ?? AccountDeletionStage.REQUESTED;
  try {
    if (stage === AccountDeletionStage.REQUESTED) {
      await clearStorage(user.id);
      await prisma.user.update({
        where: { id: user.id },
        data: { deletionStage: AccountDeletionStage.STORAGE_CLEARED, deletionLastError: null },
      });
      securityEvent("account.deletion_stage", { userId: user.id, stage: "STORAGE_CLEARED" });
      return true;
    }

    if (stage === AccountDeletionStage.STORAGE_CLEARED) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(user.authId, false);
      // "not found" means a previous pass already did it — that is success, not
      // a failure to retry forever.
      if (error && error.status !== 404) throw new Error(error.message);
      await prisma.user.update({
        where: { id: user.id },
        data: { deletionStage: AccountDeletionStage.AUTH_DELETED, deletionLastError: null },
      });
      securityEvent("account.deletion_stage", { userId: user.id, stage: "AUTH_DELETED" });
      return true;
    }

    await prisma.user.delete({ where: { id: user.id } });
    securityEvent("account.deletion_completed", { userId: user.id });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = user.deletionAttempts + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: { deletionAttempts: attempts, deletionLastError: message.slice(0, 500) },
    });
    securityEvent("account.deletion_failed", { userId: user.id, stage, attempts, reason: message });
    if (attempts >= MAX_DELETION_ATTEMPTS) {
      logger.error(
        { userId: user.id, stage, err: error },
        "account deletion has exhausted its retries and needs manual attention",
      );
    }
    return true;
  }
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
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    securityEvent("account.deletion_completed", { userId: user.id, email: user.email, reason: "unverified expiry" });
    purged++;
  }
  return purged;
}
