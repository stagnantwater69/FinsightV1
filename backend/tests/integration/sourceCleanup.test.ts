import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Storage is the external system here, so it is mocked — but the DELETE calls
 * are captured rather than ignored, because "was the file actually asked to be
 * removed" is the whole question this suite answers.
 */
const { deleteReceiptImageMock, deleteCsvFileMock } = vi.hoisted(() => ({
  deleteReceiptImageMock: vi.fn(async () => true),
  deleteCsvFileMock: vi.fn(async () => true),
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
  };
});

import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
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
});

afterAll(disconnectDb);

const TODAY = () => utcDayString(0);

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
  async function batchWith(expenseCount: number, salesCount: number) {
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "February import",
        uploadDate: new Date(),
        fileReference: "1/february.csv",
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

    expect(deleteCsvFileMock).toHaveBeenCalledWith("1/february.csv");
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
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
    expect(deleteCsvFileMock).toHaveBeenCalledWith("1/february.csv");
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
  });

  it("deletes the spreadsheet when the last row is a sales record", async () => {
    const { salesRecords } = await batchWith(0, 1);

    await sales.deleteSalesRecord(ctx.user.id, salesRecords[0]!.id);

    expect(deleteCsvFileMock).toHaveBeenCalledWith("1/february.csv");
  });
});
