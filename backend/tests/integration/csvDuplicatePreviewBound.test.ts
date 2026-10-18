import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { previewCsvForProfile } from "../../src/services/csvImport.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * The duplicate check against existing records reads only the records a
 * duplicate key could match (same date and same amount), in bounded pages,
 * and still finds every duplicate.
 */
const mapping = { date: "Date", description: "Description", amount: "Amount", category: "Category" };
const csv = (rows: string[]) => Buffer.from(["Date,Description,Amount,Category", ...rows].join("\n"));
const DAY = new Date("2026-09-01");
let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => { await resetDb(); owner = await makeOwnerWithProfile(); });
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

async function seedExpenses(count: number, amountOf: (index: number) => number, descriptionOf: (index: number) => string) {
  await prisma.expenseRecord.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Inventory!,
      date: DAY,
      amount: amountOf(index),
      description: descriptionOf(index),
      source: "MANUAL_ENTRY" as const,
    })),
  });
}

/**
 * Rows each duplicate-candidate query returned, in call order. Other reads of
 * the table (category suggestions from history) are not counted.
 */
function watchExpenseCandidateReads() {
  const original = prisma.expenseRecord.findMany.bind(prisma.expenseRecord);
  const reads: number[] = [];
  vi.spyOn(prisma.expenseRecord, "findMany").mockImplementation((async (args: Parameters<typeof original>[0]) => {
    const rows = await original(args);
    if (args?.where && "date" in args.where) reads.push(rows.length);
    return rows;
  }) as never);
  return reads;
}

describe("CSV duplicate preview against a dense ledger", () => {
  it("reads only the records with an uploaded amount, and still flags the duplicate", async () => {
    // 3,000 records on one busy day; one of them is the uploaded row again.
    await seedExpenses(3_000, (index) => (index === 1_234 ? 75.5 : 1_000 + index), (index) => `Sale item ${index}`);
    const reads = watchExpenseCandidateReads();

    const result = await previewCsvForProfile(owner.user.id, owner.profile.id, csv([
      "2026-09-01,Sale item 1234,75.50,Inventory",
      "2026-09-01,New purchase,12.00,Inventory",
    ]), { recordType: "expense", columnMapping: mapping });

    expect(result.validation).toMatchObject({ possibleDuplicateRows: 1, duplicateRows: [2] });
    // Only the one record that shares a date and an amount was read, not the day's 3,000.
    expect(reads.reduce((sum, rows) => sum + rows, 0)).toBeLessThanOrEqual(1);
  });

  it("pages through many records that share a date and amount, and finds a match on a later page", async () => {
    // 2,500 records with the same date and amount; only the last one has the uploaded description.
    await seedExpenses(2_500, () => 100, (index) => (index === 2_499 ? "Rice sack" : `Other ${index}`));
    const reads = watchExpenseCandidateReads();

    const result = await previewCsvForProfile(owner.user.id, owner.profile.id, csv([
      "2026-09-01,Rice sack,100,Inventory",
    ]), { recordType: "expense", columnMapping: mapping });

    expect(result.validation).toMatchObject({ possibleDuplicateRows: 1, duplicateRows: [2] });
    expect(Math.max(...reads)).toBeLessThanOrEqual(1_000);
    expect(reads.reduce((sum, rows) => sum + rows, 0)).toBe(2_500);
  });

  it("matches an amount written without its trailing zero against the stored two-decimal amount", async () => {
    await seedExpenses(1, () => 10.5, () => "Coffee");

    const result = await previewCsvForProfile(owner.user.id, owner.profile.id, csv([
      "2026-09-01,Coffee,10.5,Inventory",
    ]), { recordType: "expense", columnMapping: mapping });

    expect(result.validation).toMatchObject({ possibleDuplicateRows: 1 });
  });

  it("still flags existing sales duplicates", async () => {
    await prisma.salesReferenceRecord.createMany({
      data: Array.from({ length: 1_500 }, (_, index) => ({
        businessProfileId: owner.profile.id,
        date: DAY,
        amount: index < 1_200 ? 250 : 900 + index,
        description: index === 1_199 ? "Catering" : `Order ${index}`,
        source: "MANUAL_ENTRY" as const,
      })),
    });

    const result = await previewCsvForProfile(owner.user.id, owner.profile.id, csv([
      "2026-09-01,Catering,250,",
    ]), { recordType: "sales", columnMapping: { date: "Date", description: "Description", amount: "Amount" } });

    expect(result.validation).toMatchObject({ possibleDuplicateRows: 1, duplicateRows: [2] });
  });
});
