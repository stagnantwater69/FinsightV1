import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Supabase Storage is mocked for the same reason csvImport.test.ts mocks it:
 * this exercises real parsing, real DB writes and real cleanup without needing
 * network or credentials.
 *
 * downloadCsvFile and deleteCsvFile are BOTH stubbed here, unlike that file,
 * because these tests reach code paths that call them — previewImportBatch
 * reads a stored file back, and discarding the last record of a batch asks
 * storage to delete it. A partial mock would surface as "x is not a function"
 * rather than as a failed assertion.
 */
const storedCsv = Buffer.from(
  ["Transaction Date,Particulars,Cash Out,Class", "2026-01-05,Rice sack,1200,Inventory"].join("\n") + "\n",
);
const deleteCsvFile = vi.fn(async () => true);

vi.mock("../../src/services/storage.service", () => ({
  uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
  uploadReceiptImage: vi.fn(async () => "test/mock-receipt-path.jpg"),
  downloadCsvFile: vi.fn(async () => storedCsv),
  deleteCsvFile: (...args: unknown[]) => deleteCsvFile(...(args as [])),
  deleteReceiptImage: vi.fn(async () => true),
  signedCsvFileUrl: vi.fn(async () => "https://example.test/signed.csv"),
  signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed.jpg"),
}));

import { prisma } from "../../src/config/prisma";
import { listImportBatches, previewImportBatch } from "../../src/services/csvImport.service";
import {
  bulkResolveExpenseDuplicates,
  searchExpenseRecords,
} from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  deleteCsvFile.mockClear();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
});

afterAll(disconnectDb);

async function makeBatch(title = "March expenses") {
  return prisma.cSVImportBatch.create({
    data: {
      businessProfileId: ctx.profile.id,
      title,
      uploadDate: utcDay(-1),
      fileReference: "test/mock-csv-path.csv",
      status: "Needs Review",
    },
  });
}

/**
 * One original plus `copies` flagged duplicates of it, which is the shape the
 * import path actually produces: the first occurrence is never flagged, and
 * every repeat points back at it.
 */
async function makeDuplicateCluster(opts: {
  importBatchId?: number;
  copies: number;
  description?: string;
}) {
  const description = opts.description ?? "Rice sack";
  const original = await prisma.expenseRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDay(-3),
      description,
      amount: 1200,
      source: "CSV_UPLOAD",
      importBatchId: opts.importBatchId,
      duplicateStatus: "Not a Duplicate",
      reviewStatus: "Reviewed",
    },
  });

  const copies = [];
  for (let i = 0; i < opts.copies; i++) {
    copies.push(
      await prisma.expenseRecord.create({
        data: {
          businessProfileId: ctx.profile.id,
          categoryId: ctx.categories.Inventory!,
          date: utcDay(-3),
          description,
          amount: 1200,
          source: "CSV_UPLOAD",
          importBatchId: opts.importBatchId,
          duplicateStatus: "Flagged",
          duplicateOfRecordId: original.id,
          reviewStatus: "Needs Review",
        },
      }),
    );
  }
  return { original, copies };
}

describe("bulkResolveExpenseDuplicates", () => {
  it("discards every copy and leaves the original untouched", async () => {
    // The safety property the whole grouped UI rests on: a flagged set never
    // contains the original, so discarding all of it cannot delete the
    // owner's real record.
    const { original, copies } = await makeDuplicateCluster({ copies: 3 });

    const resolved = await bulkResolveExpenseDuplicates(
      ctx.user.id,
      ctx.profile.id,
      copies.map((c) => c.id),
      "discard",
    );

    expect(resolved).toBe(3);
    const survivors = await prisma.expenseRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe(original.id);
    expect(survivors[0]!.duplicateStatus).toBe("Not a Duplicate");
  });

  it("clears the flag without deleting anything when keeping", async () => {
    const { copies } = await makeDuplicateCluster({ copies: 2 });

    const resolved = await bulkResolveExpenseDuplicates(
      ctx.user.id,
      ctx.profile.id,
      copies.map((c) => c.id),
      "keep",
    );

    expect(resolved).toBe(2);
    const all = await prisma.expenseRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.duplicateStatus === "Not a Duplicate")).toBe(true);
    expect(all.every((r) => r.reviewStatus === "Reviewed")).toBe(true);
  });

  it("skips ids belonging to another owner rather than touching them", async () => {
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    const intruder = await prisma.expenseRecord.create({
      data: {
        businessProfileId: other.profile.id,
        categoryId: other.categories.Inventory!,
        date: utcDay(-3),
        description: "Not yours",
        amount: 500,
        source: "MANUAL_ENTRY",
        duplicateStatus: "Flagged",
      },
    });
    const { copies } = await makeDuplicateCluster({ copies: 1 });

    const resolved = await bulkResolveExpenseDuplicates(
      ctx.user.id,
      ctx.profile.id,
      [copies[0]!.id, intruder.id],
      "discard",
    );

    // Only the caller's own record counted, and the other owner's survives.
    expect(resolved).toBe(1);
    expect(await prisma.expenseRecord.findUnique({ where: { id: intruder.id } })).not.toBeNull();
  });

  it("removes the import batch once its last record is discarded", async () => {
    const batch = await makeBatch();
    const { original, copies } = await makeDuplicateCluster({ importBatchId: batch.id, copies: 2 });

    // The original still belongs to the batch, so the batch must survive.
    await bulkResolveExpenseDuplicates(ctx.user.id, ctx.profile.id, copies.map((c) => c.id), "discard");
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).not.toBeNull();
    expect(deleteCsvFile).not.toHaveBeenCalled();

    // Now nothing is left that came from it.
    await bulkResolveExpenseDuplicates(ctx.user.id, ctx.profile.id, [original.id], "discard");
    expect(await prisma.cSVImportBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(deleteCsvFile).toHaveBeenCalledTimes(1);
  });

  it("does nothing on an empty id list", async () => {
    const { copies } = await makeDuplicateCluster({ copies: 1 });
    expect(await bulkResolveExpenseDuplicates(ctx.user.id, ctx.profile.id, [], "discard")).toBe(0);
    expect(await prisma.expenseRecord.findUnique({ where: { id: copies[0]!.id } })).not.toBeNull();
  });
});

describe("listImportBatches", () => {
  it("returns this profile's batches, newest first", async () => {
    const older = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "January",
        uploadDate: utcDay(-30),
        fileReference: "a.csv",
        status: "Completed",
      },
    });
    const newer = await makeBatch("March");

    const batches = await listImportBatches(ctx.user.id, ctx.profile.id);
    expect(batches.map((b) => b.id)).toEqual([newer.id, older.id]);
    expect(batches[0]!.title).toBe("March");
  });

  it("never returns another owner's batches", async () => {
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: other.profile.id,
        title: "Theirs",
        uploadDate: utcDay(-1),
        fileReference: "theirs.csv",
        status: "Completed",
      },
    });

    expect(await listImportBatches(ctx.user.id, ctx.profile.id)).toEqual([]);
  });
});

describe("previewImportBatch", () => {
  it("parses the stored file back into headers and rows", async () => {
    const batch = await makeBatch();
    const preview = await previewImportBatch(ctx.user.id, batch.id);

    expect(preview).not.toBeNull();
    expect(preview!.headers).toEqual(["Transaction Date", "Particulars", "Cash Out", "Class"]);
    expect(preview!.totalRows).toBe(1);
    expect(preview!.previewRows[0]!.Particulars).toBe("Rice sack");
  });

  it("returns null for another owner's batch rather than their file", async () => {
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    const theirs = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: other.profile.id,
        title: "Theirs",
        uploadDate: utcDay(-1),
        fileReference: "theirs.csv",
        status: "Completed",
      },
    });

    expect(await previewImportBatch(ctx.user.id, theirs.id)).toBeNull();
  });

  it("returns null for a batch that does not exist", async () => {
    expect(await previewImportBatch(ctx.user.id, 999999)).toBeNull();
  });
});

describe("searchExpenseRecords — importBatchId filter", () => {
  it("returns only the records that came in on the given import", async () => {
    const batch = await makeBatch();
    const otherBatch = await makeBatch("April");

    await makeDuplicateCluster({ importBatchId: batch.id, copies: 1, description: "From March" });
    await makeDuplicateCluster({ importBatchId: otherBatch.id, copies: 0, description: "From April" });

    const results = await searchExpenseRecords(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      importBatchId: batch.id,
    });

    expect(results).toHaveLength(2); // the original plus its one copy
    expect(results.every((r) => r.importBatchId === batch.id)).toBe(true);
  });

  it("returns everything when no import is specified", async () => {
    const batch = await makeBatch();
    await makeDuplicateCluster({ importBatchId: batch.id, copies: 1 });

    const results = await searchExpenseRecords(ctx.user.id, { businessProfileId: ctx.profile.id });
    expect(results).toHaveLength(2);
  });
});
