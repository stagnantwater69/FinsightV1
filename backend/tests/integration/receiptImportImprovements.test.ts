import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { previewCsv, previewCsvForProfile } from "../../src/services/csvImport.service";
import { suggestCategoryForDescription } from "../../src/services/ai.service";
import { confirmReceipt } from "../../src/services/receiptScan/reconciliation";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const mapping = { date: "Date", description: "Description", amount: "Amount", category: "Category" };
const csv = (rows: string[]) => Buffer.from(["Date,Description,Amount,Category", ...rows].join("\n"));
let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => { await resetDb(); owner = await makeOwnerWithProfile(); });
afterEach(() => vi.unstubAllGlobals());
afterAll(disconnectDb);

async function record(description: string, categoryId = owner.categories.Inventory!, vendor?: string, receiptScanId?: number) {
  return prisma.expenseRecord.create({ data: { businessProfileId: owner.profile.id, categoryId, description, vendor,
    receiptScanId, date: new Date("2026-09-01"), amount: 100, source: "MANUAL_ENTRY" } });
}

describe("CSV complete-file preflight", () => {
  it("validates beyond visible rows and applies corrections with bounded error output", () => {
    const buffer = csv(Array.from({ length: 160 }, (_, index) => `2026-09-01,Item ${index},${index < 50 ? "100" : "bad"},Inventory`));
    const result = previewCsv(buffer, { recordType: "expense", columnMapping: mapping });
    expect(result.previewRows).toHaveLength(50);
    expect(result.validation).toMatchObject({ validRows: 50, invalidRows: 110, skippedTruncated: true });
    expect(result.validation?.skipped).toHaveLength(100);
    const corrected = previewCsv(buffer, { recordType: "expense", columnMapping: mapping, corrections: { "52": { amount: "100" } } });
    expect(corrected.validation?.validRows).toBe(51);
  });

  it("uses the mapped date and respects corrected dates before deciding ambiguity", () => {
    const buffer = Buffer.from("Date,OtherDate,Description,Amount,Category\n2026-09-01,05/01/2026,Rice,100,Inventory");
    const options = { recordType: "expense" as const, columnMapping: { ...mapping, date: "OtherDate" } };
    expect(previewCsv(buffer, options)).toMatchObject({ dateFormatAmbiguous: true });
    expect(previewCsv(buffer, options).validation).toBeUndefined();
    expect(previewCsv(buffer, { ...options, corrections: { "2": { date: "2026-01-05" } } }).validation?.validRows).toBe(1);
  });

  it("rejects malformed headers, CSV quoting, and missing mapped columns", () => {
    for (const buffer of [Buffer.from("Date,Date\n2026-09-01,100"), Buffer.from("Date,\n2026-09-01,100"), Buffer.from('Date,Description\n2026-09-01,"broken')]) {
      expect(() => previewCsv(buffer)).toThrow();
    }
    expect(() => previewCsv(csv(["2026-09-01,Rice,100,Inventory"]), { recordType: "expense", columnMapping: { ...mapping, amount: "Missing" } })).toThrow(/mapped column/i);
  });

  it("reports existing and same-file duplicates without conflating sales with expenses or exposing other profiles", async () => {
    await record("Rice");
    const buffer = Buffer.from("Date,Description,Amount,Category,Type\n2026-09-01,Rice,100,Inventory,expense\n2026-09-01,Rice,100,,sales\n2026-09-01,Rice,100,,sales");
    const options = { recordType: "mixed" as const, mixedStrategy: "column" as const, columnMapping: { ...mapping, recordType: "Type" } };
    expect(previewCsv(buffer, options).validation).toMatchObject({ possibleDuplicateRows: 1, duplicateRows: [4] });
    const result = await previewCsvForProfile(owner.user.id, owner.profile.id, buffer, options);
    expect(result.validation).toMatchObject({ possibleDuplicateRows: 2, duplicateRows: [2, 4] });
    const other = await makeOwnerWithProfile();
    expect((await previewCsvForProfile(other.user.id, other.profile.id, buffer, options)).validation?.possibleDuplicateRows).toBe(1);
    await expect(previewCsvForProfile(other.user.id, owner.profile.id, buffer, options)).rejects.toMatchObject({ status: 404 });
    expect(await prisma.expenseRecord.count()).toBe(1);
  });

  it("suggests confirmed categories only for blank cells and never creates a category in preview", async () => {
    await record("Rice");
    const buffer = Buffer.from("Date,Description,Amount\n2026-09-01,Rice,100");
    const options = { recordType: "expense" as const, columnMapping: { date: "Date", description: "Description", amount: "Amount" } };
    const result = await previewCsvForProfile(owner.user.id, owner.profile.id, buffer, options);
    // A blank category no longer skips the row: it is categorised on import,
    // and the review shows which category that will be.
    expect(result.validation).toMatchObject({ validRows: 1, invalidRows: 0 });
    expect(result.rowCategories).toEqual([expect.objectContaining({ row: 2, name: "Inventory", source: "history", isNew: false })]);
    expect(result.categorySuggestions).toEqual([{ row: 2, categoryId: owner.categories.Inventory, categoryName: "Inventory", source: "history" }]);
    const corrected = await previewCsvForProfile(owner.user.id, owner.profile.id, buffer, { ...options, corrections: { "2": { category: "Utilities" } } });
    expect(corrected.categorySuggestions).toEqual([]);
    expect(corrected.rowCategories).toEqual([expect.objectContaining({ row: 2, name: "Utilities", source: "file" })]);
    const supplied = await previewCsvForProfile(owner.user.id, owner.profile.id, csv(["2026-09-01,Rice,100,New category"]), { ...options, columnMapping: mapping });
    expect(supplied.categorySuggestions).toEqual([]);
    expect(supplied.rowCategories).toEqual([expect.objectContaining({ row: 2, name: "New category", source: "file", isNew: true })]);
    expect(await prisma.expenseCategory.count()).toBe(2);
  });
});

describe("category history and receipt currency", () => {
  it("uses newest saved owner choice and vendor before calling AI", async () => {
    await record("Rice", owner.categories.Inventory, "Store A");
    await record("Rice", owner.categories.Utilities, "Store B");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await suggestCategoryForDescription(owner.user.id, owner.profile.id, " rice ", "Store A")).toMatchObject({ categoryId: owner.categories.Inventory, source: "history" });
    expect(await suggestCategoryForDescription(owner.user.id, owner.profile.id, "Rice")).toMatchObject({ categoryId: owner.categories.Utilities, source: "history" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not learn unconfirmed receipt guesses or another profile's history", async () => {
    const scan = await prisma.receiptScan.create({ data: { businessProfileId: owner.profile.id, imageFile: "private/pending.jpg" } });
    await record("Rice", owner.categories.Inventory, undefined, scan.id);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "NONE" }] } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await suggestCategoryForDescription(owner.user.id, owner.profile.id, "Rice")).toBeNull();
    const other = await makeOwnerWithProfile();
    await expect(suggestCategoryForDescription(other.user.id, owner.profile.id, "Rice")).rejects.toMatchObject({ status: 404 });
  });

  it.each(["TOTAL USD 100.00", "TOTAL PHP 100.00\nTOTAL USD 2.00", "TOTAL $100.00", "TOTAL ¥1200"])("books a receipt as PHP whatever currency its text seems to print: %s", async (rawText) => {
    const scan = await prisma.receiptScan.create({ data: { businessProfileId: owner.profile.id, imageFile: "private/usd.jpg", rawText, processingStatus: "Complete" } });
    await expect(confirmReceipt(owner.user.id, scan.id, { date: "2026-09-01", description: "Rice", amount: 100, splits: [{ categoryId: owner.categories.Inventory!, amount: 100 }] })).resolves.toBeDefined();
    expect(await prisma.expenseRecord.count()).toBe(1);
  });
});
