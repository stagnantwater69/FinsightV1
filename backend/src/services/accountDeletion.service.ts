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
          receiptScans: {
            select: {
              imageFile: true,
              pages: { select: { imageFile: true, processedImageFile: true } },
            },
          },
          csvImportBatches: { select: { fileReference: true } },
        },
      },
    },
  });
  if (!user) return;

  const receiptPaths = [...new Set(user.businessProfiles.flatMap((profile) =>
    profile.receiptScans.flatMap((scan) =>
      [
        scan.imageFile,
        ...scan.pages.flatMap((page) => [page.imageFile, page.processedImageFile]),
      ].filter((path): path is string => Boolean(path)),
    ),
  ))];
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
async function deleteRelationalData(userId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const profiles = await tx.businessProfile.findMany({ where: { userId }, select: { id: true } });
    const profileIds = profiles.map((profile) => profile.id);
    const scans = await tx.receiptScan.findMany({
      where: { businessProfile: { userId } },
      select: { id: true },
    });
    const scanIds = scans.map((scan) => scan.id);

    if (profileIds.length > 0) {
      // Dispatch must go first because its consent and business-budget
      // relations intentionally refuse independent audit-row deletion.
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
  });
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

    await deleteRelationalData(user.id);
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
