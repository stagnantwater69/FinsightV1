import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Supabase Storage is the one external dependency in this flow. Mocked so the
// test exercises real parsing, real category resolution and real DB writes
// without needing network or credentials. The upload itself is covered by the
// live regression pass, not here.
vi.mock("../../src/services/storage.service", () => ({
  uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
  uploadReceiptImage: vi.fn(async () => "test/mock-receipt-path.jpg"),
}));

import { prisma } from "../../src/config/prisma";
import { confirmImport, MAX_IMPORT_ROWS, previewCsv } from "../../src/services/csvImport.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile(
    { expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 },
    ["Inventory", "Utilities"]
  );
});

afterAll(disconnectDb);

const EXPENSE_MAPPING = {
  date: "Transaction Date",
  description: "Particulars",
  amount: "Cash Out",
  category: "Class",
};

function csv(rows: string[]): Buffer {
  return Buffer.from(["Transaction Date,Particulars,Cash Out,Class", ...rows].join("\n") + "\n");
}

async function importExpenses(
  buffer: Buffer,
  title = "Test batch",
  corrections?: Parameters<typeof confirmImport>[1]["corrections"],
) {
  return confirmImport(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    recordType: "expense",
    title,
    buffer,
    originalname: "test.csv",
    columnMapping: EXPENSE_MAPPING,
    corrections,
  });
}

describe("the import is bounded by ROW COUNT, not only by file size", () => {
  /*
   * WHY THIS BOUND EXISTS AND WHY IT IS NOT MEGABYTES. The upload is already
   * capped at 5 MB by multer, and that number says almost nothing about how
   * much work the file represents. A CSV is plain text, so its size tracks the
   * characters in it rather than the records:
   *
   *   `2026-01-05,Load,120`           ~25 bytes  →  5 MB is ~200,000 rows
   *   a row with a full description  ~600 bytes  →  5 MB is ~8,000 rows
   *
   * Twenty-five times the work for an identical file size — and each row
   * becomes an ExpenseRecord with its own validation, duplicate check, large-
   * expense evaluation and analysis job. Bytes do not bound the cost; rows do.
   */
  function rowsOfLength(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${utcDayString(-((i % 27) + 1))},Row ${i},100,Inventory`);
  }

  it("accepts a file exactly at the limit", () => {
    expect(previewCsv(csv(rowsOfLength(MAX_IMPORT_ROWS))).totalRows).toBe(MAX_IMPORT_ROWS);
  });

  it("refuses one row past it, with a message that says what to do", () => {
    let message = "";
    try {
      previewCsv(csv(rowsOfLength(MAX_IMPORT_ROWS + 1)));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Names both figures and the remedy: "too large" is unactionable when the
    // file is only a few megabytes and the owner cannot see why.
    expect(message).toContain(String(MAX_IMPORT_ROWS + 1).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    expect(message).toMatch(/split/i);
  });

  /**
   * Refused at PREVIEW, not only at confirm. An owner must not spend time
   * mapping columns for an import that was never going to run.
   */
  it("refuses on the mapping screen, before any column is matched", () => {
    expect(() => previewCsv(csv(rowsOfLength(MAX_IMPORT_ROWS + 1)))).toThrow(/limit is/i);
  });

  it("refuses the same file at confirm, so the two cannot disagree", async () => {
    await expect(importExpenses(csv(rowsOfLength(MAX_IMPORT_ROWS + 1)))).rejects.toThrow(/limit is/i);
  });

  /**
   * Set from measured capacity AND from use.
   *
   * The floor below is the case that drove it up from 5,000: a business
   * importing per-transaction SALES history produces 50-100 rows a day, which
   * 5,000 covered for under three months. A year of that is the bar.
   *
   * The ceiling is real too — the import runs inside one request, and the
   * measured cost is ~160µs a row — so a limit far above this wants the job
   * queue rather than a bigger number, and this test fails if someone raises it
   * to a figure that no longer fits a request.
   */
  it("covers a year of per-transaction sales without leaving request scope", () => {
    expect(MAX_IMPORT_ROWS).toBeGreaterThanOrEqual(365 * 50);
    expect(MAX_IMPORT_ROWS).toBeLessThanOrEqual(50_000);
  });
});

describe("previewCsv", () => {
  it("returns headers and row count without touching the database", () => {
    const result = previewCsv(csv([`${utcDayString(-1)},Item one,1400,Inventory`, `${utcDayString(-2)},Item two,900,Utilities`]));
    expect(result.headers).toEqual(["Transaction Date", "Particulars", "Cash Out", "Class"]);
    expect(result.totalRows).toBe(2);
    expect(result.previewRows).toHaveLength(2);
  });

  it("caps the preview at 50 rows but still reports the true total", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `${utcDayString(-1)},Item ${i},100,Inventory`);
    const result = previewCsv(csv(rows));
    expect(result.totalRows).toBe(80);
    expect(result.previewRows).toHaveLength(50);
  });

  it("sends the whole file when it is shorter than the cap", () => {
    const rows = Array.from({ length: 35 }, (_, i) => `${utcDayString(-1)},Item ${i},100,Inventory`);
    const result = previewCsv(csv(rows));
    expect(result.totalRows).toBe(35);
    expect(result.previewRows).toHaveLength(35);
  });

  it("handles an empty file without throwing", () => {
    const result = previewCsv(Buffer.from("Transaction Date,Particulars,Cash Out,Class\n"));
    expect(result.totalRows).toBe(0);
    expect(result.previewRows).toEqual([]);
  });
});

describe("import of a wholly valid file", () => {
  it("imports every row and reports nothing skipped", async () => {
    const result = await importExpenses(
      csv([
        `${utcDayString(-1)},Supplier stocks,1400,Inventory`,
        `${utcDayString(-2)},Electric bill,900,Utilities`,
      ])
    );

    expect(result.totalRows).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.status).toBe("Completed");
  });

  it("tags imported records with the CSV_UPLOAD source and links the batch", async () => {
    const result = await importExpenses(csv([`${utcDayString(-1)},Supplier stocks,1400,Inventory`]));

    const records = await prisma.expenseRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(records).toHaveLength(1);
    expect(records[0]!.source).toBe("CSV_UPLOAD");
    expect(records[0]!.importBatchId).toBe(result.batchId);
  });

  it("resolves an existing category case-insensitively rather than duplicating it", async () => {
    await importExpenses(csv([`${utcDayString(-1)},Supplier stocks,1400,INVENTORY`]));

    const categories = await prisma.expenseCategory.findMany({ where: { businessProfileId: ctx.profile.id } });
    // Still just the two seeded categories — no "INVENTORY" duplicate.
    expect(categories).toHaveLength(2);
    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(record.categoryId).toBe(ctx.categories.Inventory);
  });

  /*
   * Vendor: mappable, optional, and never a reason to skip a row.
   * ExpenseRecord.vendor is nullable and the Add Expense form marks it
   * optional, so an export without a supplier column has to import cleanly —
   * it just can't fill one in.
   */
  it("imports the vendor when a column is mapped to it", async () => {
    const buffer = Buffer.from(
      ["Transaction Date,Particulars,Cash Out,Class,Supplier", `${utcDayString(-1)},Rice,1400,Inventory,Aling Nena`].join("\n") + "\n",
    );
    await confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Vendor batch",
      buffer,
      originalname: "test.csv",
      columnMapping: { ...EXPENSE_MAPPING, vendor: "Supplier" },
    });

    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(record.vendor).toBe("Aling Nena");
  });

  it("imports with no vendor at all when the column isn't mapped", async () => {
    const result = await importExpenses(csv([`${utcDayString(-1)},Rice,1400,Inventory`]));
    expect(result.imported).toBe(1);
    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(record.vendor).toBeNull();
  });

  it("does not skip a row whose vendor cell is empty", async () => {
    const buffer = Buffer.from(
      [
        "Transaction Date,Particulars,Cash Out,Class,Supplier",
        `${utcDayString(-1)},Has vendor,1400,Inventory,Aling Nena`,
        `${utcDayString(-2)},No vendor,900,Inventory,`,
      ].join("\n") + "\n",
    );
    const result = await confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "expense",
      title: "Vendor batch",
      buffer,
      originalname: "test.csv",
      columnMapping: { ...EXPENSE_MAPPING, vendor: "Supplier" },
    });

    expect(result.imported).toBe(2);
    expect(result.skipped).toEqual([]);
    const blank = await prisma.expenseRecord.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, description: "No vendor" },
    });
    expect(blank.vendor).toBeNull();
  });

  it("stores dates at UTC midnight", async () => {
    const day = utcDayString(-1);
    await importExpenses(csv([`${day},Supplier stocks,1400,Inventory`]));
    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(record.date.toISOString()).toBe(`${day}T00:00:00.000Z`);
  });
});

describe("import of a file with a mix of valid and invalid rows", () => {
  it("imports the good rows, skips the bad ones, and says which and why", async () => {
    const result = await importExpenses(
      csv([
        `${utcDayString(-1)},Good row one,1400,Inventory`,
        `,Missing date,900,Utilities`,
        `${utcDayString(-2)},Missing amount,,Inventory`,
        `${utcDayString(-3)},Bad amount,not-a-number,Inventory`,
        `${utcDayString(-4)},Good row two,700,Utilities`,
      ])
    );

    expect(result.totalRows).toBe(5);
    expect(result.imported).toBe(2);
    expect(result.skipped).toHaveLength(3);

    // Every skipped row carries a row number and a human-readable reason —
    // an owner has to be able to find and fix the offending line.
    for (const s of result.skipped) {
      expect(typeof s.row).toBe("number");
      expect(s.reason.length).toBeGreaterThan(0);
    }

    // Only the two good rows made it in.
    const records = await prisma.expenseRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(records.map((r) => r.description).sort()).toEqual(["Good row one", "Good row two"]);
  });

  it("does not partially apply a bad row", async () => {
    await importExpenses(csv([`${utcDayString(-1)},Bad amount,not-a-number,Inventory`]));
    const records = await prisma.expenseRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(records).toHaveLength(0);
  });

  it("marks the batch as needing review when rows were skipped", async () => {
    const result = await importExpenses(
      csv([`${utcDayString(-1)},Good row,1400,Inventory`, `,Missing date,900,Utilities`])
    );
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.status).toBe("Needs Review");

    const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.status).toBe("Needs Review");
  });

  /*
   * Corrections: the cells an owner retypes in the "rows won't import" panel,
   * applied over the uploaded file so a bad row can be rescued in the same
   * import rather than sending them back to Excel for a second round trip.
   */
  it("imports a row that a correction makes valid", async () => {
    const result = await importExpenses(
      csv([`${utcDayString(-1)},Good row,1400,Inventory`, `,Missing date,900,Utilities`]),
      "Fixed batch",
      { "3": { date: utcDayString(-2) } },
    );

    expect(result.imported).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.status).toBe("Completed");

    const rescued = await prisma.expenseRecord.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, description: "Missing date" },
    });
    expect(rescued.date.toISOString()).toBe(`${utcDayString(-2)}T00:00:00.000Z`);
  });

  it("can correct several fields of the same row at once", async () => {
    const result = await importExpenses(
      csv([`,Broken everywhere,not-a-number,`]),
      "Fixed batch",
      { "2": { date: utcDayString(-1), amount: "1250.50", category: "Utilities" } },
    );

    expect(result.imported).toBe(1);
    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(Number(record.amount)).toBe(1250.5);
    expect(record.categoryId).toBe(ctx.categories.Utilities);
  });

  it("leaves untouched rows alone when correcting one", async () => {
    const result = await importExpenses(
      csv([`${utcDayString(-1)},Keep me,1400,Inventory`, `,Fix me,900,Utilities`]),
      "Fixed batch",
      { "3": { date: utcDayString(-2) } },
    );
    expect(result.imported).toBe(2);
    const kept = await prisma.expenseRecord.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, description: "Keep me" },
    });
    expect(Number(kept.amount)).toBe(1400);
    expect(kept.date.toISOString()).toBe(`${utcDayString(-1)}T00:00:00.000Z`);
  });

  /**
   * The correction is data, not a bypass. A value that is still invalid gets
   * skipped with the same reason as if it had come out of the file that way —
   * so this cannot be used to push an unparseable amount into the database.
   */
  it("still skips a row whose correction is also invalid", async () => {
    const result = await importExpenses(
      csv([`${utcDayString(-1)},Bad amount,not-a-number,Inventory`]),
      "Fixed batch",
      { "2": { amount: "still-not-a-number" } },
    );
    expect(result.imported).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("Invalid amount");
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("ignores a correction for a row number that isn't in the file", async () => {
    const result = await importExpenses(csv([`${utcDayString(-1)},Only row,1400,Inventory`]), "Fixed batch", {
      "99": { amount: "5" },
    });
    expect(result.imported).toBe(1);
    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(Number(record.amount)).toBe(1400);
  });

  it("creates a category named only in a correction", async () => {
    await importExpenses(csv([`${utcDayString(-1)},Needs a category,1400,`]), "Fixed batch", {
      "2": { category: "Transport" },
    });
    const created = await prisma.expenseCategory.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, name: "Transport" },
    });
    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(record.categoryId).toBe(created.id);
  });

  it("records the batch with a stored file reference (NOT NULL in the dictionary)", async () => {
    const result = await importExpenses(csv([`${utcDayString(-1)},Supplier stocks,1400,Inventory`]));
    const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.fileReference).toBe("test/mock-csv-path.csv");
    expect(batch.title).toBe("Test batch");
  });
});

describe("imported rows still go through the normal flagging rules", () => {
  it("flags a large expense that arrives via CSV", async () => {
    // 20,000 is over 25% of 60,000.
    const result = await importExpenses(csv([`${utcDayString(-1)},Bulk delivery,20000,Inventory`]));
    expect(result.imported).toBe(1);
    expect(result.largeExpenseFlagged).toBe(1);
    // `flagged` counts possible duplicates only — this row is not one.
    expect(result.flagged).toBe(0);

    const record = await prisma.expenseRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(record.largeExpenseFlag).toBe(true);
    expect(record.reviewStatus).toBe("Needs Review");
  });

  it("marks the batch Needs Review when its only flag is a large expense", async () => {
    // Regression guard. The batch status previously considered duplicates only,
    // so a batch of large expenses reported "Completed" while every record in
    // it was queued for review.
    const result = await importExpenses(csv([`${utcDayString(-1)},Bulk delivery,20000,Inventory`]));
    expect(result.skipped).toEqual([]);
    expect(result.flagged).toBe(0);
    expect(result.largeExpenseFlagged).toBe(1);
    expect(result.status).toBe("Needs Review");

    const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.status).toBe("Needs Review");
  });

  it("still reports Completed for a clean batch with no flags at all", async () => {
    const result = await importExpenses(csv([`${utcDayString(-1)},Small item,100,Inventory`]));
    expect(result.skipped).toEqual([]);
    expect(result.flagged).toBe(0);
    expect(result.largeExpenseFlagged).toBe(0);
    expect(result.status).toBe("Completed");
  });

  it("flags a duplicate that arrives via CSV against an existing manual record", async () => {
    const day = utcDayString(-1);
    await importExpenses(csv([`${day},Supplier stocks,1400,Inventory`]), "First batch");
    const second = await importExpenses(csv([`${day},Supplier stocks,1400,Inventory`]), "Second batch");

    expect(second.imported).toBe(1);
    expect(second.flagged).toBeGreaterThan(0);

    const records = await prisma.expenseRecord.findMany({
      where: { businessProfileId: ctx.profile.id },
      orderBy: { id: "asc" },
    });
    expect(records).toHaveLength(2);
    expect(records[1]!.duplicateStatus).toBe("Flagged");
    expect(records[1]!.duplicateOfRecordId).toBe(records[0]!.id);
  });

  /**
   * Two identical rows inside ONE file.
   *
   * This used to be free: rows were inserted one at a time, so the second
   * row's duplicate SELECT could already see the first. The batched import
   * inserts them together, which means nothing in the database distinguishes
   * them at insert time and the link has to be worked out in memory and
   * written back afterwards — so it is worth a test of its own.
   */
  it("flags a row that duplicates an earlier row of the SAME file", async () => {
    const day = utcDayString(-1);
    const result = await importExpenses(
      csv([
        `${day},Supplier stocks,1400,Inventory`,
        `${day},Different thing,900,Inventory`,
        `${day},Supplier stocks,1400,Inventory`,
      ]),
      "One batch",
    );

    expect(result.imported).toBe(3);
    expect(result.flagged).toBe(1);

    const records = await prisma.expenseRecord.findMany({
      where: { businessProfileId: ctx.profile.id },
      orderBy: { id: "asc" },
    });
    expect(records).toHaveLength(3);
    // First occurrence is clean, the unrelated row is clean, the repeat is flagged
    // and points back at the first occurrence — not at itself, and not at null.
    expect(records[0]!.duplicateStatus).toBe("Not a Duplicate");
    expect(records[1]!.duplicateStatus).toBe("Not a Duplicate");
    expect(records[2]!.duplicateStatus).toBe("Flagged");
    expect(records[2]!.duplicateOfRecordId).toBe(records[0]!.id);
  });

  /**
   * DELIBERATELY CHANGED. This used to assert one notification per flagged row,
   * carrying a link to the record it was about, which was reasonable while an
   * import was capped at 5,000 rows.
   *
   * It stopped being reasonable when the cap rose to 30,000: a measured import
   * of that size produced 33,355 notifications, which does not inform an owner
   * of anything — it buries every other notification they have. The batch
   * summary is now the whole of what an import raises, and the flagged rows are
   * worked through in the review queue, which is built for the volume.
   *
   * The per-record link is not lost anywhere it mattered: createExpenseRecord
   * and updateExpenseRecord still raise their own, because there a single
   * record IS the whole event.
   */
  it("summarises a batch in one notification rather than one per flagged row", async () => {
    const day = utcDayString(-1);
    await importExpenses(csv([`${day},Supplier stocks,1400,Inventory`, `${day},Supplier stocks,1400,Inventory`]), "Batch");

    const perRecord = await prisma.notification.findMany({
      where: { businessProfileId: ctx.profile.id, type: "Possible Duplicate" },
    });
    expect(perRecord).toEqual([]);

    const all = await prisma.notification.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(all).toHaveLength(1);
    expect(all[0]!.message).toContain("flagged as possible duplicates");

    // The flag itself still exists on the record, which is what the review
    // queue reads — only the notification per row is gone.
    const flagged = await prisma.expenseRecord.findFirst({
      where: { businessProfileId: ctx.profile.id, duplicateStatus: "Flagged" },
    });
    expect(flagged).not.toBeNull();
  });
});

describe("sales imports", () => {
  it("imports sales reference records without needing a category column", async () => {
    const buffer = Buffer.from(
      ["Transaction Date,Particulars,Cash In", `${utcDayString(-1)},Daily sales,5000`].join("\n") + "\n"
    );
    const result = await confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "sales",
      title: "Sales batch",
      buffer,
      originalname: "sales.csv",
      columnMapping: { date: "Transaction Date", description: "Particulars", amount: "Cash In" },
    });

    expect(result.imported).toBe(1);
    const records = await prisma.salesReferenceRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(records).toHaveLength(1);
    expect(records[0]!.source).toBe("CSV_UPLOAD");
    // No expense records were created by a sales import.
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });
});

describe("ownership", () => {
  it("refuses to import into another owner's business profile, with 404 not 403", async () => {
    const other = await makeOwnerWithProfile();
    await expect(
      confirmImport(ctx.user.id, {
        businessProfileId: other.profile.id,
        recordType: "expense",
        title: "Hijack attempt",
        buffer: csv([`${utcDayString(-1)},Supplier stocks,1400,Inventory`]),
        originalname: "test.csv",
        columnMapping: EXPENSE_MAPPING,
      })
    ).rejects.toMatchObject({ status: 404 });

    // Nothing was written to the victim's profile.
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: other.profile.id } })).toBe(0);
    expect(await prisma.cSVImportBatch.count({ where: { businessProfileId: other.profile.id } })).toBe(0);
  });
});

/**
 * One file holding both sales and expenses — the sheet an owner who keeps a
 * single spreadsheet actually has.
 *
 * The rule under test throughout is that the file DECIDES and FinSight never
 * guesses. A row filed the wrong way is not a cosmetic error: it moves money
 * from one side of the books to the other, changes the recovery target and the
 * daily target, and reports nothing. So every case below either takes the
 * file's word or skips the row.
 */
describe("mixed sales-and-expense imports", () => {
  const MIXED_MAPPING = {
    date: "Date",
    description: "Particulars",
    amount: "Amount",
    category: "Class",
    recordType: "Type",
  };

  function mixedCsv(rows: string[]): Buffer {
    return Buffer.from(["Date,Particulars,Amount,Class,Type", ...rows].join("\n") + "\n");
  }

  function importMixed(buffer: Buffer, mapping = MIXED_MAPPING, strategy: "column" | "sign" = "column") {
    return confirmImport(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      recordType: "mixed",
      mixedStrategy: strategy,
      title: "Combined sheet",
      buffer,
      originalname: "mixed.csv",
      columnMapping: mapping,
    });
  }

  it("splits one file into sales records and expense records", async () => {
    const result = await importMixed(
      mixedCsv([
        `${utcDayString(-1)},Morning sales,2500,,Sale`,
        `${utcDayString(-1)},Supplier stocks,1400,Inventory,Expense`,
        `${utcDayString(-2)},Afternoon sales,1800,,benta`,
        `${utcDayString(-2)},Electricity,900,Utilities,gastos`,
      ]),
    );

    expect(result.imported).toBe(4);
    expect(result.importedSales).toBe(2);
    expect(result.importedExpenses).toBe(2);
    expect(result.skipped).toEqual([]);

    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(2);
    expect(await prisma.salesReferenceRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(2);
  });

  /**
   * ONE batch, not two. CSVImportBatch already relates to both record types, so
   * a combined file stays a single entry in the owner's import history — one
   * row in the "which import" filter, one file to re-open.
   */
  it("files both halves under the same import batch", async () => {
    const result = await importMixed(
      mixedCsv([
        `${utcDayString(-1)},Morning sales,2500,,Sale`,
        `${utcDayString(-1)},Supplier stocks,1400,Inventory,Expense`,
      ]),
    );

    const batches = await prisma.cSVImportBatch.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.id).toBe(result.batchId);

    expect(await prisma.expenseRecord.count({ where: { importBatchId: result.batchId } })).toBe(1);
    expect(await prisma.salesReferenceRecord.count({ where: { importBatchId: result.batchId } })).toBe(1);
  });

  /** The core promise: an unreadable type is skipped and named, never assumed. */
  it("skips rows whose type it cannot read, rather than guessing", async () => {
    const result = await importMixed(
      mixedCsv([
        `${utcDayString(-1)},Morning sales,2500,,Sale`,
        `${utcDayString(-1)},Bank transfer,5000,,Transfer`,
        `${utcDayString(-1)},Mystery,300,,`,
      ]),
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]!.reason).toMatch(/could not tell/i);
    expect(result.skipped[0]!.reason).toContain("Transfer");
    expect(result.skipped[1]!.reason).toMatch(/missing/i);

    // Nothing was invented for the rows it could not read.
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  /**
   * A combined export usually has no category column — categories are an
   * expense concept and the sales rows have nothing to put there. Skipping every
   * expense over a column that was never going to exist would reject the exact
   * file this feature exists to accept.
   */
  it("files uncategorised expenses rather than rejecting them", async () => {
    const result = await importMixed(
      Buffer.from(
        ["Date,Particulars,Amount,Type", `${utcDayString(-1)},Morning sales,2500,Sale`, `${utcDayString(-1)},Supplier stocks,1400,Expense`].join("\n") + "\n",
      ),
      { date: "Date", description: "Particulars", amount: "Amount", recordType: "Type" },
    );

    expect(result.imported).toBe(2);
    expect(result.uncategorised).toBe(1);

    const expense = await prisma.expenseRecord.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id },
      include: { category: true },
    });
    expect(expense.category.name).toBe("Uncategorised");
  });

  it("reads the bank-statement convention where expenses are negative", async () => {
    const result = await importMixed(
      Buffer.from(
        [
          "Date,Particulars,Amount,Class",
          `${utcDayString(-1)},Morning sales,2500,`,
          `${utcDayString(-1)},Supplier stocks,-1400,Inventory`,
          // Accounting parentheses are a negative too.
          `${utcDayString(-2)},Electricity,(900),Utilities`,
        ].join("\n") + "\n",
      ),
      { date: "Date", description: "Particulars", amount: "Amount", category: "Class" },
      "sign",
    );

    expect(result.importedSales).toBe(1);
    expect(result.importedExpenses).toBe(2);

    // Stored as a positive magnitude — the sign was direction, not value.
    const expenses = await prisma.expenseRecord.findMany({ where: { businessProfileId: ctx.profile.id } });
    for (const e of expenses) expect(Number(e.amount)).toBeGreaterThan(0);
  });

  /**
   * A negative in a file that is NOT using the sign convention stays the
   * invalid amount it has always been. Silently flipping it would import a
   * refund as an ordinary expense.
   */
  it("still rejects negative amounts when the file does not use the sign convention", async () => {
    const result = await importMixed(
      mixedCsv([
        `${utcDayString(-1)},Morning sales,2500,,Sale`,
        `${utcDayString(-1)},Refund,-400,Inventory,Expense`,
      ]),
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/invalid amount/i);
  });

  /**
   * The preview has to OFFER the mixed path, or an owner has to already know
   * the feature exists to find it.
   */
  it("tells the preview which column names the type", () => {
    const preview = previewCsv(
      mixedCsv([
        `${utcDayString(-1)},Morning sales,2500,,Sale`,
        `${utcDayString(-1)},Supplier stocks,1400,Inventory,Expense`,
      ]),
    );
    expect(preview.detectedTypeColumn).toBe("Type");
  });

  it("tells the preview which columns carry signed amounts", () => {
    const preview = previewCsv(
      Buffer.from(
        ["Date,Particulars,Amount", `${utcDayString(-1)},Sales,2500`, `${utcDayString(-1)},Stocks,-1400`].join("\n") + "\n",
      ),
    );
    expect(preview.columnsWithNegatives).toContain("Amount");
  });
});

/**
 * A CSV import raises ONE notification for the batch, never one per row.
 *
 * At the old 5,000-row cap a notification each was merely untidy. At 30,000 it
 * is destructive: a measured import produced 33,355 of them, burying every
 * other notification the owner had and making the bell useless for the one job
 * it exists to do. The flagged rows remain reachable through the review queue,
 * which is the screen built for working through them.
 */
describe("import notifications are summarised, not per-row", () => {
  it("raises one notification for a batch with many flagged rows", async () => {
    // Threshold is 25% of 60,000 = 15,000, so every row below is a large expense.
    const rows = Array.from(
      { length: 12 },
      (_, i) => `${utcDayString(-((i % 20) + 1))},Big purchase ${i},20000,Inventory`,
    );
    const result = await importExpenses(csv(rows));

    expect(result.largeExpenseFlagged).toBe(12);

    const notifications = await prisma.notification.findMany({
      where: { businessProfileId: ctx.profile.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("CSV import");

    // The records themselves still carry the flag and still need review, which
    // is what the review queue reads.
    expect(
      await prisma.expenseRecord.count({
        where: { businessProfileId: ctx.profile.id, largeExpenseFlag: true, reviewStatus: "Needs Review" },
      }),
    ).toBe(12);
  });
});
