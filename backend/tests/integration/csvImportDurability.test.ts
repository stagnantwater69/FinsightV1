import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Storage is mocked per-test here rather than once at module scope, because
 * several of these cases are ABOUT storage failing — the whole point of the
 * orphan-proof ordering is what happens when the upload throws.
 */
const uploadCsvFile = vi.fn(async () => "test/mock-csv-path.csv");
const downloadCsvFile = vi.fn(async (_ref: string) => uploadedBuffer);
const deleteCsvFile = vi.fn(async () => true);

vi.mock("../../src/services/storage.service", () => ({
  uploadCsvFile: (...args: unknown[]) => uploadCsvFile(...(args as [])),
  downloadCsvFile: (ref: string) => downloadCsvFile(ref),
  deleteCsvFile: (...args: unknown[]) => deleteCsvFile(...(args as [])),
  uploadReceiptImage: vi.fn(async () => "test/mock-receipt-path.jpg"),
}));

import { CsvImportProcessingStatus } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import {
  confirmImport,
  getImportBatchStatus,
  runCsvImportWorkerOnce,
  SYNC_ROW_LIMIT,
} from "../../src/services/csvImport.service";
import * as expenseService from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
/** What downloadCsvFile hands back to the worker — set by each test's builder. */
let uploadedBuffer: Buffer = Buffer.from("");

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  uploadCsvFile.mockImplementation(async () => "test/mock-csv-path.csv");
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 }, [
    "Inventory",
  ]);
});

afterAll(disconnectDb);

const MAPPING = { date: "Date", description: "Description", amount: "Amount", category: "Category" };

function csvOf(rows: number, startDay = 0): Buffer {
  const lines = ["Date,Description,Amount,Category"];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`${utcDayString(startDay - index)},Item ${index},${100 + index},Inventory`);
  }
  const buffer = Buffer.from(lines.join("\n"));
  uploadedBuffer = buffer;
  return buffer;
}

function confirmArgs(buffer: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: ctx.profile.id,
    recordType: "expense" as const,
    title: "Durability import",
    buffer,
    originalname: "books.csv",
    columnMapping: MAPPING,
    ...overrides,
  };
}

/** Drives the worker to completion the way the server tick would. */
async function drainWorker(maxPasses = 60) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (!(await runCsvImportWorkerOnce())) return pass;
  }
  return maxPasses;
}

describe("idempotent confirmation", () => {
  it("returns the same import for a replayed key instead of importing twice", async () => {
    const buffer = csvOf(5);
    const first = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "key-replay-1" }));
    const second = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "key-replay-1" }));

    expect(second.batchId).toBe(first.batchId);
    expect(second.imported).toBe(first.imported);
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(5);
    expect(await prisma.cSVImportBatch.count()).toBe(1);
  });

  it("imports separately when the keys differ, and says the file was seen before", async () => {
    const buffer = csvOf(3);
    await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "key-a" }));
    const second = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "key-b" }));

    expect(second.duplicateOfBatchId).toBeDefined();
    expect(await prisma.cSVImportBatch.count()).toBe(2);
    expect(await prisma.expenseRecord.count()).toBe(6);
  });

  it("refuses a key already used by a different business profile", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    await confirmImport(ctx.user.id, confirmArgs(csvOf(3), { idempotencyKey: "shared-key" }));

    await expect(
      confirmImport(
        other.user.id,
        confirmArgs(csvOf(3), { idempotencyKey: "shared-key", businessProfileId: other.profile.id }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("survives two concurrent confirms of the same key without duplicating records", async () => {
    const buffer = csvOf(4);
    const [a, b] = await Promise.all([
      confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "race-key" })),
      confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "race-key" })),
    ]);

    expect(a.batchId).toBe(b.batchId);
    expect(await prisma.expenseRecord.count()).toBe(4);
  });
});

describe("timezone-independent dates", () => {
  it("stores a day-first date on the day the file says, not one day earlier", async () => {
    // The old `new Date("05/01/2026")` path resolved this to 2026-01-04 on a
    // UTC+8 host (and to May 1st on any host, by guessing month-first).
    const buffer = Buffer.from(["Date,Description,Amount,Category", "05/01/2026,Rice sack,1200,Inventory"].join("\n"));
    uploadedBuffer = buffer;
    await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "dmy-1", dateFormat: "dmy" }));

    const record = await prisma.expenseRecord.findFirstOrThrow();
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("reads the same cell as May when told the file is month-first", async () => {
    const buffer = Buffer.from(["Date,Description,Amount,Category", "05/01/2026,Rice sack,1200,Inventory"].join("\n"));
    uploadedBuffer = buffer;
    await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "mdy-1", dateFormat: "mdy" }));

    const record = await prisma.expenseRecord.findFirstOrThrow();
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  it("refuses an ambiguous file rather than guessing, naming both readings", async () => {
    const buffer = Buffer.from(
      ["Date,Description,Amount,Category", "05/01/2026,Rice,1200,Inventory", "03/02/2026,Oil,300,Inventory"].join("\n"),
    );
    uploadedBuffer = buffer;
    await expect(
      confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "ambiguous-1" })),
    ).rejects.toThrow(/2026-01-05|2026-05-01/);
    // Nothing was created for a refused file.
    expect(await prisma.cSVImportBatch.count()).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

describe("file and cell validation", () => {
  it("rejects a header-only file before creating anything", async () => {
    const buffer = Buffer.from("Date,Description,Amount,Category");
    uploadedBuffer = buffer;
    await expect(confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "empty-1" }))).rejects.toMatchObject({
      status: 400,
    });
    expect(await prisma.cSVImportBatch.count()).toBe(0);
  });

  it("rejects a binary payload wearing a .csv name", async () => {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]);
    uploadedBuffer = buffer;
    await expect(confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "binary-1" }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("imports a semicolon-delimited export instead of reading it as one column", async () => {
    const buffer = Buffer.from(
      ["Date;Description;Amount;Category", `${utcDayString(0)};Rice sack;1200;Inventory`].join("\n"),
    );
    uploadedBuffer = buffer;
    const result = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "semi-1" }));
    expect(result.imported).toBe(1);
  });

  it("skips an over-long cell with a reason rather than dying mid-insert", async () => {
    const buffer = Buffer.from(
      [
        "Date,Description,Amount,Category",
        `${utcDayString(0)},${"x".repeat(300)},1200,Inventory`,
        `${utcDayString(-1)},Fine row,300,Inventory`,
      ].join("\n"),
    );
    uploadedBuffer = buffer;
    const result = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "long-cell-1" }));

    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/too long|255/i);
  });

  it("skips amounts outside the stored column's range or precision", async () => {
    const buffer = Buffer.from(
      [
        "Date,Description,Amount,Category",
        `${utcDayString(0)},Too precise,12.345,Inventory`,
        `${utcDayString(-1)},Too large,99999999999999,Inventory`,
        `${utcDayString(-2)},Fine,500,Inventory`,
      ].join("\n"),
    );
    uploadedBuffer = buffer;
    const result = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "amount-range-1" }));

    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(2);
  });
});

describe("storage failure", () => {
  it("marks the batch failed at the upload stage and writes no records", async () => {
    uploadCsvFile.mockImplementationOnce(async () => {
      throw new Error("storage unavailable");
    });
    const buffer = csvOf(4);

    await expect(confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "upload-fail-1" }))).rejects.toThrow(
      /storage unavailable/,
    );

    const batch = await prisma.cSVImportBatch.findFirstOrThrow();
    expect(batch.processingStatus).toBe(CsvImportProcessingStatus.FAILED);
    expect(batch.failureStage).toBe("upload");
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

describe("asynchronous import", () => {
  it("accepts a large file, then completes it through the worker with correct counts", async () => {
    const rows = SYNC_ROW_LIMIT + 10;
    const buffer = csvOf(rows);

    const accepted = await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "async-1" }));
    expect(accepted.processingStatus).toBe(CsvImportProcessingStatus.PENDING);
    expect(accepted.imported).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);

    await drainWorker();

    const status = await getImportBatchStatus(ctx.user.id, accepted.batchId);
    expect(status.processingStatus).toBe(CsvImportProcessingStatus.COMPLETE);
    expect(status.importedRows).toBe(rows);
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(rows);
  }, 120_000);

  it("resumes after a mid-import failure without duplicating committed rows", async () => {
    const rows = SYNC_ROW_LIMIT + 10;
    const buffer = csvOf(rows);
    await confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: "async-resume-1" }));

    // Fail one chunk exactly once; the worker must retry from its checkpoint
    // rather than re-inserting the chunks that already committed.
    const real = expenseService.bulkCreateExpenseRecords;
    const spy = vi.spyOn(expenseService, "bulkCreateExpenseRecords");
    let failed = false;
    spy.mockImplementation(async (...args: Parameters<typeof real>) => {
      if (!failed) {
        failed = true;
        throw new Error("transient database blip");
      }
      return real(...args);
    });

    await drainWorker();
    spy.mockRestore();

    /*
     * The failed attempt backs off, so the batch sits PENDING with a future
     * nextAttemptAt — correct production behaviour, and the reason a second
     * drain alone does nothing. Winding the clock back is how the test
     * reaches the retry without sleeping through the real delay.
     */
    await prisma.cSVImportBatch.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    await drainWorker();

    const batch = await prisma.cSVImportBatch.findFirstOrThrow();
    expect(failed).toBe(true);
    expect(batch.processingStatus).toBe(CsvImportProcessingStatus.COMPLETE);
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(rows);
  }, 180_000);

  it("keeps one owner's status out of another owner's reach", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    const accepted = await confirmImport(ctx.user.id, confirmArgs(csvOf(3), { idempotencyKey: "status-scope-1" }));

    await expect(getImportBatchStatus(other.user.id, accepted.batchId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("post-import analysis", () => {
  it("enqueues one coalesced profile refresh alongside the per-row jobs", async () => {
    await confirmImport(ctx.user.id, confirmArgs(csvOf(4), { idempotencyKey: "analysis-1" }));

    const profileJobs = await prisma.analysisJob.count({
      where: { businessProfileId: ctx.profile.id, kind: "PROFILE_REFRESH" },
    });
    const rowJobs = await prisma.analysisJob.count({
      where: { businessProfileId: ctx.profile.id, kind: "TRANSACTION" },
    });
    expect(profileJobs).toBe(1);
    expect(rowJobs).toBe(4);
  });
});

describe("category creation under concurrency", () => {
  it("creates exactly one category when two imports name the same new one", async () => {
    const build = (key: string) => {
      const buffer = Buffer.from(
        ["Date,Description,Amount,Category", `${utcDayString(0)},Bagged ice,150,Cold Storage`].join("\n"),
      );
      return confirmImport(ctx.user.id, confirmArgs(buffer, { idempotencyKey: key }));
    };
    uploadedBuffer = Buffer.from("");

    await Promise.all([build("cat-race-a"), build("cat-race-b")]);

    const categories = await prisma.expenseCategory.findMany({
      where: { businessProfileId: ctx.profile.id, name: "Cold Storage" },
    });
    expect(categories).toHaveLength(1);
  });
});
