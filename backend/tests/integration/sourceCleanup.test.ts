import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/*
 * Storage is the external system here, so it is mocked — but the DELETE calls
 * are captured rather than ignored, because "was the file actually asked to be
 * removed" is the whole question this suite answers.
 */
const { deleteReceiptImageMock, deleteCsvFileMock, listCsvFilesForProfileMock } = vi.hoisted(() => ({
  deleteReceiptImageMock: vi.fn(async () => true),
  deleteCsvFileMock: vi.fn(async () => true),
  listCsvFilesForProfileMock: vi.fn(async () => ({ objects: [], truncated: false })),
}));
vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadReceiptImage: vi.fn(async () => "1/mock-receipt.jpg"),
    uploadCsvFile: vi.fn(async () => "1/mock.csv"),
    signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed.jpg"),
    deleteReceiptImage: deleteReceiptImageMock,
    deleteCsvFile: deleteCsvFileMock,
    listCsvFilesForProfile: listCsvFilesForProfileMock,
  };
});

import { prisma } from "../../src/config/prisma";
import { app } from "../../src/app";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import {
  enqueueDetachedCsvSourcePurge,
  runCsvSourcePurgeWorkerOnce,
  sweepRetainedCsvSources,
} from "../../src/services/csvSourcePurge.service";
import { reconcileCsvStorageProfile } from "../../src/services/csvStorageReconciliation.service";
import { runReceiptPurgeWorkerOnce } from "../../src/services/receiptPurge.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * Deleting a record used to leave its receipt photograph or spreadsheet in
 * Storage forever. What makes this non-trivial is that one upload can produce
 * several records, so the file may only go when the LAST of them does — these
 * tests exist mostly to pin that reference counting down in both directions.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 });
  deleteReceiptImageMock.mockClear();
  deleteCsvFileMock.mockClear();
  deleteReceiptImageMock.mockResolvedValue(true);
  deleteCsvFileMock.mockResolvedValue(true);
  listCsvFilesForProfileMock.mockReset();
  listCsvFilesForProfileMock.mockResolvedValue({ objects: [], truncated: false });
});

afterAll(disconnectDb);

const TODAY = () => utcDayString(0);

async function drainReceiptPurge() {
  expect(await runReceiptPurgeWorkerOnce()).toBe(true);
  expect(await runReceiptPurgeWorkerOnce()).toBe(true);
}

/** A confirmed scan with `records` expense records hanging off it. */
async function confirmedScanWithRecords(records: number) {
  const scan = await prisma.receiptScan.create({
    data: {
      businessProfileId: ctx.profile.id,
      imageFile: "1/receipt-abc.jpg",
      confirmationStatus: "Confirmed",
      extractedAmount: 1000,
    },
  });
  const created = [];
  for (let i = 0; i < records; i++) {
    created.push(
      await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: TODAY(),
        description: `Scanned line ${i + 1}`,
        amount: 500,
        source: "RECEIPT_SCAN",
        receiptScanId: scan.id,
      }),
    );
  }
  return { scan, records: created };
}

describe("receipt image cleanup", () => {
  it("deletes the image when the last record from a scan is deleted", async () => {
    const { scan, records } = await confirmedScanWithRecords(1);

    await expenses.deleteExpenseRecord(ctx.user.id, records[0]!.id);

    expect(deleteReceiptImageMock).not.toHaveBeenCalled();
    expect(await prisma.receiptPurgeJob.findFirst({ where: { receiptScanId: scan.id } })).toMatchObject({
      status: "PENDING",
      stage: "STORAGE",
    });
    await drainReceiptPurge();
    expect(deleteReceiptImageMock).toHaveBeenCalledWith("1/receipt-abc.jpg");
    expect(await prisma.receiptScan.findUnique({ where: { id: scan.id } })).toBeNull();
  });

  /**
   * The case that makes this reference counting rather than a plain cascade:
   * an itemised receipt splits across categories, and deleting one of those
   * splits must not remove the photograph the others still came from.
   */
  it("keeps the image while another record from the same scan survives", async () => {
    const { scan, records } = await confirmedScanWithRecords(2);

    await expenses.deleteExpenseRecord(ctx.user.id, records[0]!.id);

    expect(deleteReceiptImageMock).not.toHaveBeenCalled();
    expect(await prisma.receiptScan.findUnique({ where: { id: scan.id } })).not.toBeNull();

    // ...and goes once the second one follows.
    await expenses.deleteExpenseRecord(ctx.user.id, records[1]!.id);
    expect(deleteReceiptImageMock).not.toHaveBeenCalled();
    await drainReceiptPurge();
    expect(deleteReceiptImageMock).toHaveBeenCalledWith("1/receipt-abc.jpg");
  });

  /**
   * A pending scan legitimately has no expense records — it is an owner
   * part-way through the review screen. Treating "no records" alone as the
   * orphan test would delete the receipt they are in the middle of checking.
   */
  it("never touches a scan that is still pending confirmation", async () => {
    const pending = await prisma.receiptScan.create({
      data: {
        businessProfileId: ctx.profile.id,
        imageFile: "1/pending.jpg",
        confirmationStatus: "Pending",
      },
    });
    const unrelated = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Typed by hand",
      amount: 300,
      source: "MANUAL_ENTRY",
    });

    await expenses.deleteExpenseRecord(ctx.user.id, unrelated.id);

    expect(deleteReceiptImageMock).not.toHaveBeenCalled();
    expect(await prisma.receiptScan.findUnique({ where: { id: pending.id } })).not.toBeNull();
  });

  /**
   * The trap the multi-page migration's own comment names: cascade deletes
   * the ReceiptScanPage ROWS for free, but Storage is a separate system and
   * still has to be asked, per page, to delete the actual objects. A scan
   * with three pages that only deleted the cover would leave pages 2 and 3
   * in Storage forever — silently, since removeObject never throws.
   */
  it("deletes every page's image, not only the cover, for a multi-page scan", async () => {
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: ctx.profile.id,
        imageFile: "1/page-1.jpg",
        confirmationStatus: "Confirmed",
        extractedAmount: 1000,
        pages: {
          create: [
            { pageNumber: 1, imageFile: "1/page-1.jpg" },
            { pageNumber: 2, imageFile: "1/page-2.jpg", processedImageFile: "1/page-2-processed.jpg" },
            { pageNumber: 3, imageFile: "1/page-3.jpg" },
          ],
        },
      },
    });
    const record = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Long receipt",
      amount: 1000,
      source: "RECEIPT_SCAN",
      receiptScanId: scan.id,
    });

    await expenses.deleteExpenseRecord(ctx.user.id, record.id);

    expect(deleteReceiptImageMock).not.toHaveBeenCalled();
    await drainReceiptPurge();
    expect(deleteReceiptImageMock).toHaveBeenCalledWith("1/page-1.jpg");
    expect(deleteReceiptImageMock).toHaveBeenCalledWith("1/page-2.jpg");
    expect(deleteReceiptImageMock).toHaveBeenCalledWith("1/page-2-processed.jpg");
    expect(deleteReceiptImageMock).toHaveBeenCalledWith("1/page-3.jpg");
    // Deduplicated: page 1's file and the scan's own cover are the same path
    // in real usage (uploadAndScan writes the cover as page 1), so a scan
    // with 3 pages must ask Storage to delete 3 objects, not 4.
    expect(deleteReceiptImageMock).toHaveBeenCalledTimes(4);
    expect(await prisma.receiptScan.findUnique({ where: { id: scan.id } })).toBeNull();
    expect(await prisma.receiptScanPage.count({ where: { receiptScanId: scan.id } })).toBe(0);
  });

  it("does not try to delete anything for a hand-typed record", async () => {
    const manual = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Typed by hand",
      amount: 300,
      source: "MANUAL_ENTRY",
    });

    await expenses.deleteExpenseRecord(ctx.user.id, manual.id);

    expect(deleteReceiptImageMock).not.toHaveBeenCalled();
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
  });
});

describe("CSV file cleanup", () => {
  it("expires a completed source after 90 days without deleting its import history", async () => {
    const now = new Date("2026-09-29T12:00:00.000Z");
    const old = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Old import",
        uploadDate: new Date("2026-06-01T00:00:00.000Z"),
        fileReference: `${ctx.profile.id}/old.csv`,
        status: "Completed",
        processingStatus: "COMPLETE",
        completedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    const recent = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Recent import",
        uploadDate: new Date("2026-09-01T00:00:00.000Z"),
        fileReference: `${ctx.profile.id}/recent.csv`,
        status: "Completed",
        processingStatus: "COMPLETE",
        completedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    const swept = await Promise.all([sweepRetainedCsvSources(now), sweepRetainedCsvSources(now)]);
    expect(swept.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await sweepRetainedCsvSources(now)).toBe(0);
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      processingStatus: "COMPLETE",
      fileReference: null,
    });
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: recent.id } })).toMatchObject({
      fileReference: `${ctx.profile.id}/recent.csv`,
    });
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledWith(`${ctx.profile.id}/old.csv`);
  });

  it("audits old Storage orphans before explicitly queuing deletion", async () => {
    const oldName = "c219bff0-6269-4ad8-8dd3-578089de6fa1-old.csv";
    const newName = "c219bff0-6269-4ad8-8dd3-578089de6fa2-new.csv";
    const ownedName = "c219bff0-6269-4ad8-8dd3-578089de6fa3-owned.csv";
    const oldPath = `${ctx.profile.id}/${oldName}`;
    const ownedPath = `${ctx.profile.id}/${ownedName}`;
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Owned import",
        uploadDate: new Date(),
        fileReference: ownedPath,
      },
    });
    listCsvFilesForProfileMock.mockResolvedValue({
      objects: [
        { path: oldPath, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: null },
        { path: `${ctx.profile.id}/${newName}`, createdAt: "2026-09-28T00:00:00.000Z", updatedAt: null },
        { path: ownedPath, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: null },
        { path: `${ctx.profile.id}/legacy.csv`, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: null },
      ],
      truncated: false,
    });
    const options = { businessProfileId: ctx.profile.id, now: new Date("2026-09-29T00:00:00.000Z") };
    const audit = await reconcileCsvStorageProfile({ ...options, delete: false });
    expect(audit).toMatchObject({
      mode: "audit",
      scanned: 4,
      protectedByBatch: 1,
      tooRecent: 1,
      unsafeOrUnknownAge: 1,
      orphanCandidates: 1,
      queued: 0,
    });
    expect(audit.candidateHashes).toHaveLength(1);
    expect(audit.candidateHashes[0]).not.toContain(oldName);
    expect(await prisma.cSVSourcePurgeJob.count()).toBe(0);
    await expect(reconcileCsvStorageProfile({ ...options, delete: true, graceDays: 1 }))
      .rejects.toThrow("graceDays must be 7..365");

    const deletion = await reconcileCsvStorageProfile({ ...options, delete: true });
    expect(deletion.queued).toBe(1);
    expect(await prisma.cSVSourcePurgeJob.findFirstOrThrow()).toMatchObject({
      fileReference: oldPath,
      status: "PENDING",
    });
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledWith(oldPath);
  });

  it("refuses to purge an object that became an active batch reference", async () => {
    const path = `${ctx.profile.id}/c219bff0-6269-4ad8-8dd3-578089de6fa4-late.csv`;
    await enqueueDetachedCsvSourcePurge(ctx.profile.id, 0, path);
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Late owner",
        uploadDate: new Date(),
        fileReference: path,
      },
    });

    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await prisma.cSVSourcePurgeJob.findFirstOrThrow()).toMatchObject({
      status: "FAILED",
      fileReference: path,
      lastErrorCode: "CSV_PURGE_ACTIVE_REFERENCE",
    });
  });

  async function batchWith(expenseCount: number, salesCount: number) {
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "February import",
        uploadDate: new Date(),
        fileReference: `${ctx.profile.id}/february.csv`,
        status: "Completed",
      },
    });
    const expenseRecords = [];
    for (let i = 0; i < expenseCount; i++) {
      expenseRecords.push(
        await expenses.createExpenseRecord(ctx.user.id, {
          businessProfileId: ctx.profile.id,
          categoryId: ctx.categories.Inventory!,
          date: TODAY(),
          description: `Imported expense ${i + 1}`,
          amount: 400,
          source: "CSV_UPLOAD",
          importBatchId: batch.id,
        }),
      );
    }
    const salesRecords = [];
    for (let i = 0; i < salesCount; i++) {
      salesRecords.push(
        await sales.createSalesRecord(ctx.user.id, {
          businessProfileId: ctx.profile.id,
          date: TODAY(),
          description: `Imported sales ${i + 1}`,
          amount: 900,
          source: "CSV_UPLOAD",
          importBatchId: batch.id,
        }),
      );
    }
    return { batch, expenseRecords, salesRecords };
  }

  it("deletes the spreadsheet when its last row is deleted", async () => {
    const { batch, expenseRecords } = await batchWith(1, 0);

    await expenses.deleteExpenseRecord(ctx.user.id, expenseRecords[0]!.id);

    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await prisma.cSVSourcePurgeJob.findFirst({ where: { sourceBatchId: batch.id } })).toMatchObject({
      status: "PENDING",
      fileReference: `${ctx.profile.id}/february.csv`,
    });

    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledWith(`${ctx.profile.id}/february.csv`);
    expect(await prisma.cSVSourcePurgeJob.findFirst({ where: { sourceBatchId: batch.id } })).toMatchObject({
      status: "COMPLETE",
      fileReference: null,
    });
  });

  /**
   * One spreadsheet can produce both expense and sales rows, so the batch is
   * only spent when BOTH kinds are gone — counting one and not the other would
   * delete a file rows still came from.
   */
  it("keeps the spreadsheet while sales rows from it survive", async () => {
    const { batch, expenseRecords, salesRecords } = await batchWith(1, 1);

    await expenses.deleteExpenseRecord(ctx.user.id, expenseRecords[0]!.id);
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).not.toBeNull();

    await sales.deleteSalesRecord(ctx.user.id, salesRecords[0]!.id);
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledWith(`${ctx.profile.id}/february.csv`);
  });

  it("deletes the spreadsheet when the last row is a sales record", async () => {
    const { batch, salesRecords } = await batchWith(0, 1);

    await sales.deleteSalesRecord(ctx.user.id, salesRecords[0]!.id);

    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledWith(`${ctx.profile.id}/february.csv`);
    expect(await prisma.cSVSourcePurgeJob.findFirst({ where: { sourceBatchId: batch.id } })).toMatchObject({
      status: "COMPLETE",
      fileReference: null,
    });
  });

  it.each([
    [
      "timeout",
      () => deleteCsvFileMock.mockRejectedValueOnce(new Error("Storage request timed out")),
      "CSV_PURGE_STORAGE_FAILED",
    ],
    ["failure", () => deleteCsvFileMock.mockResolvedValueOnce(false), "CSV_PURGE_STORAGE_DELETE_FAILED"],
  ])("retains the path and recovers after a Storage %s", async (_case, failOnce, expectedCode) => {
    const { batch, expenseRecords } = await batchWith(1, 0);
    failOnce();

    await expenses.deleteExpenseRecord(ctx.user.id, expenseRecords[0]!.id);
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);

    const retry = await prisma.cSVSourcePurgeJob.findFirstOrThrow({ where: { sourceBatchId: batch.id } });
    expect(retry).toMatchObject({
      status: "RETRY",
      attemptCount: 1,
      fileReference: `${ctx.profile.id}/february.csv`,
      lastErrorCode: expectedCode,
    });

    await prisma.cSVSourcePurgeJob.update({
      where: { id: retry.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledTimes(2);
    expect(await prisma.cSVSourcePurgeJob.findUniqueOrThrow({ where: { id: retry.id } })).toMatchObject({
      status: "COMPLETE",
      fileReference: null,
      lastErrorCode: null,
    });
  });

  it("claims one purge once when workers race", async () => {
    const { batch, salesRecords } = await batchWith(0, 1);
    await sales.deleteSalesRecord(ctx.user.id, salesRecords[0]!.id);

    const claims = await Promise.all([
      runCsvSourcePurgeWorkerOnce(),
      runCsvSourcePurgeWorkerOnce(),
      runCsvSourcePurgeWorkerOnce(),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(deleteCsvFileMock).toHaveBeenCalledTimes(1);
    expect(await prisma.cSVSourcePurgeJob.count({ where: { sourceBatchId: batch.id } })).toBe(1);
  });

  it("schedules one cleanup when the final expense and sale are deleted concurrently", async () => {
    const { batch, expenseRecords, salesRecords } = await batchWith(1, 1);

    await Promise.all([
      expenses.deleteExpenseRecord(ctx.user.id, expenseRecords[0]!.id),
      sales.deleteSalesRecord(ctx.user.id, salesRecords[0]!.id),
    ]);

    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await prisma.cSVSourcePurgeJob.count({ where: { sourceBatchId: batch.id } })).toBe(1);
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
  });

  it("surfaces queued and failed cleanup obligations in readiness", async () => {
    await prisma.cSVSourcePurgeJob.createMany({
      data: [
        {
          businessProfileId: ctx.profile.id,
          sourceBatchId: 90_001,
          targetHash: "a".repeat(64),
          fileReference: `${ctx.profile.id}/queued.csv`,
        },
        {
          businessProfileId: ctx.profile.id,
          sourceBatchId: 90_002,
          targetHash: "b".repeat(64),
          fileReference: `${ctx.profile.id}/failed.csv`,
          status: "FAILED",
          attemptCount: 10,
          lastErrorCode: "CSV_PURGE_ATTEMPTS_EXHAUSTED",
        },
      ],
    });

    const ready = await request(app).get("/api/v1/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      queuedCsvSourcePurges: 1,
      failedCsvSourcePurges: 1,
    });
    expect(ready.body.oldestQueuedCsvSourcePurgeAgeSeconds).toEqual(expect.any(Number));
  });

  it("counts terminalizing an exhausted purge as worker activity and keeps its path", async () => {
    const job = await prisma.cSVSourcePurgeJob.create({
      data: {
        businessProfileId: ctx.profile.id,
        sourceBatchId: 90_003,
        targetHash: "c".repeat(64),
        fileReference: `${ctx.profile.id}/exhausted.csv`,
        status: "RETRY",
        attemptCount: 10,
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });

    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).not.toHaveBeenCalled();
    expect(await prisma.cSVSourcePurgeJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "FAILED",
      fileReference: `${ctx.profile.id}/exhausted.csv`,
      lastErrorCode: "CSV_PURGE_ATTEMPTS_EXHAUSTED",
    });
  });

  it("queues a new generation when a late upload arrives after an earlier purge completed", async () => {
    const sourceBatchId = 90_004;
    const fileReference = `${ctx.profile.id}/late-upload.csv`;
    await enqueueDetachedCsvSourcePurge(ctx.profile.id, sourceBatchId, fileReference);
    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(await prisma.cSVSourcePurgeJob.findFirstOrThrow({ where: { sourceBatchId } })).toMatchObject({
      status: "COMPLETE",
      fileReference: null,
    });

    // An in-flight upload can recreate this path after the no-op deletion.
    // Compensation needs a fresh job rather than the completed target hash.
    await enqueueDetachedCsvSourcePurge(ctx.profile.id, sourceBatchId, fileReference);
    const jobs = await prisma.cSVSourcePurgeJob.findMany({
      where: { sourceBatchId },
      orderBy: { id: "asc" },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ status: "COMPLETE", fileReference: null });
    expect(jobs[1]).toMatchObject({ status: "PENDING", fileReference });
    expect(jobs[1]!.targetHash).not.toBe(jobs[0]!.targetHash);

    expect(await runCsvSourcePurgeWorkerOnce()).toBe(true);
    expect(deleteCsvFileMock).toHaveBeenCalledTimes(2);
    expect(await prisma.cSVSourcePurgeJob.findUniqueOrThrow({ where: { id: jobs[1]!.id } })).toMatchObject({
      status: "COMPLETE",
      fileReference: null,
    });
  });

  it("keeps the operational queue outside Supabase Data API access", async () => {
    const table = await prisma.$queryRaw<{ relrowsecurity: boolean }[]>`
      SELECT relrowsecurity
      FROM pg_class
      WHERE oid = '"CSVSourcePurgeJob"'::regclass
    `;
    expect(table).toEqual([{ relrowsecurity: true }]);

    const privileges = await prisma.$queryRaw<{ role: string; allowed: boolean }[]>`
      SELECT rolname AS role,
             has_table_privilege(rolname, '"CSVSourcePurgeJob"', 'SELECT, INSERT, UPDATE, DELETE') AS allowed
      FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated')
      ORDER BY rolname
    `;
    expect(privileges.every((row) => row.allowed === false)).toBe(true);
    const policies = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM pg_policy
      WHERE polrelid = '"CSVSourcePurgeJob"'::regclass
    `;
    expect(Number(policies[0]?.count ?? 0)).toBe(0);
  });

  it("keeps staged CSV rows outside Supabase Data API access", async () => {
    const table = await prisma.$queryRaw<{
      relrowsecurity: boolean;
      public_privileges: bigint;
      policies: bigint;
    }[]>`
      SELECT
        c.relrowsecurity,
        (
          SELECT COUNT(*)
          FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
          WHERE acl.grantee = 0
        ) AS public_privileges,
        (
          SELECT COUNT(*)
          FROM pg_policy p
          WHERE p.polrelid = c.oid
        ) AS policies
      FROM pg_class c
      WHERE c.oid = '"CSVImportStageChunk"'::regclass
    `;
    expect(table).toHaveLength(1);
    expect(table[0]!.relrowsecurity).toBe(true);
    expect(Number(table[0]!.public_privileges)).toBe(0);
    expect(Number(table[0]!.policies)).toBe(0);

    const privileges = await prisma.$queryRaw<{ role: string; allowed: boolean }[]>`
      SELECT rolname AS role,
             has_table_privilege(rolname, '"CSVImportStageChunk"', 'SELECT, INSERT, UPDATE, DELETE') AS allowed
      FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role')
      ORDER BY rolname
    `;
    expect(privileges.every((row) => row.allowed === false)).toBe(true);
  });
});
