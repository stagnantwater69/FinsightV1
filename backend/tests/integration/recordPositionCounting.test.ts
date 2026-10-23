import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { resolveBusinessToday, utcAddDays, utcDateKey } from "../../src/lib/dates";
import { RECORD_SORTS } from "../../src/lib/recordSort";
import {
  findRecordAtPosition,
  findRecordAtPositionByCounting,
  findRecordAtPositionBySorting,
  type RecordPositionFilters,
} from "../../src/services/recordPosition.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/*
 * findRecordAtPosition finds a page jump's boundary record by counting per
 * day or per whole-peso amount instead of sorting the ledger. Whatever it
 * returns must be exactly what sorting every row and skipping `offset` gives
 * (findRecordAtPositionBySorting). Generated ledgers are built to stress the
 * tie order: many rows on one date or one exact amount, amounts either side
 * of a peso boundary, zero and negative amounts, both tables, every source.
 */

afterAll(disconnectDb);

const AMOUNTS = [0, 0.5, 0.99, 1, 99.99, 100, 100, 100.01, 250, 250, 1234.5, 1234.56, 99999.99, -5.5, -60.25];
const WORDS = ["Rice sacks", "Cooking oil", "rice bran", "100% juice", "a_b token", "Sugar"];

const ledgerSpec = fc.record({
  expenses: fc.array(fc.record({
    offset: fc.integer({ min: -6, max: 0 }),
    amount: fc.constantFrom(...AMOUNTS),
    word: fc.constantFrom(...WORDS),
    category: fc.constantFrom("Inventory", "Utilities"),
    source: fc.constantFrom("MANUAL_ENTRY", "CSV_UPLOAD", "RECEIPT_SCAN"),
  }), { minLength: 10, maxLength: 45 }),
  sales: fc.array(fc.record({
    offset: fc.integer({ min: -6, max: 0 }),
    amount: fc.constantFrom(...AMOUNTS),
    word: fc.constantFrom(...WORDS),
    source: fc.constantFrom("MANUAL_ENTRY", "CSV_UPLOAD"),
  }), { minLength: 5, maxLength: 30 }),
});

/** Absent three times in four, so most queries still have rows to find. */
const sometimes = <T>(arbitrary: fc.Arbitrary<T>) =>
  fc.oneof({ arbitrary: fc.constant(undefined), weight: 3 }, { arbitrary, weight: 1 });

const querySpec = fc.record({
  sort: fc.constantFrom(...RECORD_SORTS),
  include: fc.constantFrom("both", "expenses", "sales"),
  category: sometimes(fc.constantFrom("Inventory", "Utilities")),
  source: sometimes(fc.constantFrom("MANUAL_ENTRY", "CSV_UPLOAD", "RECEIPT_SCAN")),
  keyword: sometimes(fc.constantFrom("rice", "%", "_", "oil", "zzz")),
  from: sometimes(fc.integer({ min: -6, max: 0 })),
  to: sometimes(fc.integer({ min: -6, max: 0 })),
  batchOnly: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
  // Taken modulo the ledger size (+2, to also ask just past the end).
  offsetSeed: fc.nat(),
});

describe("page-jump boundary by counting", () => {
  it("returns exactly the record that sorting the ledger returns", async () => {
    // Positions that held a record, so a generator that only ever asks past
    // the end cannot make this pass without comparing anything.
    let comparedRecords = 0;
    await fc.assert(
      fc.asyncProperty(ledgerSpec, fc.array(querySpec, { minLength: 1, maxLength: 12 }), async (ledger, queries) => {
        await resetDb();
        const owner = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
        const neighbour = await makeOwnerWithProfile({}, ["Inventory"]);
        const today = resolveBusinessToday(owner.profile.timezone);
        const batch = await prisma.cSVImportBatch.create({
          data: { businessProfileId: owner.profile.id, title: "Jump test", uploadDate: today, fileReference: `${owner.profile.id}/jump.csv` },
        });
        const scan = await prisma.receiptScan.create({
          data: { businessProfileId: owner.profile.id, imageFile: "receipts/jump.jpg", processingStatus: "Complete", confirmationStatus: "Confirmed" },
        });
        await prisma.expenseRecord.createMany({
          data: ledger.expenses.map((row) => ({
            businessProfileId: owner.profile.id,
            categoryId: owner.categories[row.category]!,
            date: utcAddDays(today, row.offset),
            description: row.word,
            amount: row.amount,
            source: row.source as "MANUAL_ENTRY" | "CSV_UPLOAD" | "RECEIPT_SCAN",
            importBatchId: row.source === "CSV_UPLOAD" ? batch.id : null,
            receiptScanId: row.source === "RECEIPT_SCAN" ? scan.id : null,
          })),
        });
        await prisma.salesReferenceRecord.createMany({
          data: ledger.sales.map((row) => ({
            businessProfileId: owner.profile.id,
            date: utcAddDays(today, row.offset),
            description: row.word,
            amount: row.amount,
            source: row.source as "MANUAL_ENTRY" | "CSV_UPLOAD",
            importBatchId: row.source === "CSV_UPLOAD" ? batch.id : null,
          })),
        });
        // Another business's records on the same days and amounts must never count.
        await prisma.expenseRecord.createMany({
          data: AMOUNTS.map((amount, i) => ({
            businessProfileId: neighbour.profile.id, categoryId: neighbour.categories.Inventory!,
            date: utcAddDays(today, -(i % 7)), description: "Rice sacks", amount, source: "MANUAL_ENTRY" as const,
          })),
        });

        for (const query of queries) {
          const filters: RecordPositionFilters = {
            businessProfileId: owner.profile.id,
            categoryId: query.category ? owner.categories[query.category] : undefined,
            source: query.source,
            keyword: query.keyword,
            dateFrom: query.from === undefined ? undefined : utcDateKey(utcAddDays(today, query.from)),
            dateTo: query.to === undefined ? undefined : utcDateKey(utcAddDays(today, query.to)),
            importBatchId: query.batchOnly ? batch.id : undefined,
          };
          // As records.controller.ts: sales have no category and no receipt source.
          const salesPossible = query.category === undefined && query.source !== "RECEIPT_SCAN";
          const options = {
            includeExpenses: query.include !== "sales" || !salesPossible,
            includeSales: query.include !== "expenses" && salesPossible,
            sort: query.sort,
            offset: query.offsetSeed % (ledger.expenses.length + ledger.sales.length + 2),
          };
          const expected = await findRecordAtPositionBySorting(owner.user.id, filters, options);
          if (expected) comparedRecords += 1;
          const label = JSON.stringify({ query, expected });
          expect(await findRecordAtPositionByCounting(owner.user.id, filters, options), label).toEqual(expected);
          expect(await findRecordAtPosition(owner.user.id, filters, options), label).toEqual(expected);
        }
      }),
      { seed: Number(process.env.FC_SEED ?? 20261022), numRuns: Number(process.env.FC_RUNS ?? 30) },
    );
    expect(comparedRecords).toBeGreaterThan(Number(process.env.FC_RUNS ?? 30));
  });

  it("matches sorting at every offset across whole-peso bucket boundaries", async () => {
    await resetDb();
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const today = resolveBusinessToday(owner.profile.timezone);
    // Amounts sitting on and either side of a bucket edge, in both tables,
    // with ties on the exact amount.
    const edges = [0, 0.5, 0.99, 1, 1, 1.01, 99.99, 100, 100, 100.01, 100.99, 101, -1, -0.99, -1.01];
    await prisma.expenseRecord.createMany({
      data: edges.map((amount, i) => ({
        businessProfileId: owner.profile.id, categoryId: owner.categories.Inventory!,
        date: utcAddDays(today, -(i % 3)), description: "Edge", amount, source: "MANUAL_ENTRY" as const,
      })),
    });
    await prisma.salesReferenceRecord.createMany({
      data: edges.filter((_, i) => i % 2 === 0).map((amount, i) => ({
        businessProfileId: owner.profile.id, date: utcAddDays(today, -(i % 3)), description: "Edge", amount, source: "MANUAL_ENTRY" as const,
      })),
    });
    const total = edges.length + Math.ceil(edges.length / 2);
    for (const sort of ["amount_desc", "amount_asc"] as const) {
      for (let offset = 0; offset <= total; offset += 1) {
        const options = { includeExpenses: true, includeSales: true, sort, offset };
        const filters = { businessProfileId: owner.profile.id };
        const expected = await findRecordAtPositionBySorting(owner.user.id, filters, options);
        expect(await findRecordAtPositionByCounting(owner.user.id, filters, options), `${sort} @ ${offset}`).toEqual(expected);
      }
    }
  });

  it("answers null past the end and for a business with no records", async () => {
    await resetDb();
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const options = { includeExpenses: true, includeSales: true, sort: "date_desc" as const, offset: 0 };
    expect(await findRecordAtPositionByCounting(owner.user.id, { businessProfileId: owner.profile.id }, options)).toBeNull();
    expect(await findRecordAtPositionByCounting(owner.user.id, { businessProfileId: owner.profile.id }, { ...options, sort: "amount_asc" })).toBeNull();
  });
});
