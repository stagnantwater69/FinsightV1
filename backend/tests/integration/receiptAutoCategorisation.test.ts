import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Business-first categorisation at scan time, through the real worker and
 * database. OCR and Storage are stubbed; the categoriser, the category
 * matching and the category creation are real. Every external route is a
 * tripwire: categorisation is local and must never call out.
 */
vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    uploadReceiptImage: vi.fn(async () => "1/mock-receipt.jpg"),
    uploadCsvFile: vi.fn(async () => "1/mock.csv"),
    signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed-receipt.jpg"),
    deleteReceiptImage: vi.fn(async () => true),
    inspectReceiptImage: vi.fn(async () => ({ sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn(async () => storedBytes),
  };
});

const { ocrText } = vi.hoisted(() => ({ ocrText: { value: "" } }));
vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return { ...actual, extractReceipt: vi.fn(async () => ({ text: ocrText.value, confidence: 95, lines: [] })) };
});

const { categoriseMock } = vi.hoisted(() => ({ categoriseMock: vi.fn() }));
vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, categoriseReceiptItems: categoriseMock };
});

import { prisma } from "../../src/config/prisma";
import { confirmReceipt, getScan, uploadAndScan } from "../../src/services/receiptScan.service";
import { listCategories } from "../../src/services/expenseCategory.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, runReceiptWorkerAndWait } from "../setup/testDb";

/** A sari-sari store's restocking run: shop goods in shop quantities. */
const RESTOCK = [
  "PUREGOLD PRICE CLUB",
  "Date: 2026-09-28",
  "10 x SAFEGUARD BAR 65G      350.00",
  "12 x LUCKY ME PANCIT CANTON 180.00",
  "6 x COKE 1.5L               450.00",
  "TOTAL                       980.00",
].join("\n");

/** A consultant's shop: one business line, one personal one. */
const MIXED = [
  "SM SUPERMARKET",
  "Date: 2026-09-28",
  "HP INK CARTRIDGE 680       1250.00",
  "SUNSILK SHAMPOO 180ML        89.00",
  "TOTAL                      1339.00",
].join("\n");

const UNPLACEABLE = [
  "ABC TRADING",
  "Date: 2026-09-28",
  "ZX-9 GIZMO KIT              500.00",
  "TOTAL                       500.00",
].join("\n");

type Owner = Awaited<ReturnType<typeof makeOwnerWithProfile>>;

async function scan(owner: Owner, text: string) {
  ocrText.value = text;
  const created = await uploadAndScan(owner.user.id, {
    businessProfileId: owner.profile.id,
    pages: [{ buffer: Buffer.from(`receipt-${Math.random()}`), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
  });
  await runReceiptWorkerAndWait(created.id);
  return getScan(owner.user.id, created.id);
}

async function categoryNames(owner: Owner) {
  const rows = await prisma.expenseCategory.findMany({ where: { businessProfileId: owner.profile.id }, orderBy: { name: "asc" } });
  return rows.map((row) => row.name);
}

const fetchMock = vi.fn(async () => {
  throw new Error("Receipt categorisation must not call an external service");
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("RECEIPT_PROVIDER_DISPATCH_ENABLED", "false");
  vi.stubEnv("RECEIPT_PROVIDER_KILL_SWITCH", "true");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  categoriseMock.mockReset();
  await resetDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await disconnectDb();
});

describe("categorising a scanned receipt, business first", () => {
  it("creates the category a new business needs, once, and files every item there", async () => {
    const owner = await makeOwnerWithProfile({ type: "Sari-sari store" }, []);
    const first = await scan(owner, RESTOCK);

    expect(await categoryNames(owner)).toEqual(["Inventory / Stock"]);
    const stock = await prisma.expenseCategory.findFirstOrThrow({ where: { businessProfileId: owner.profile.id } });
    expect(first.items.map((item) => item.categoryId)).toEqual([stock.id, stock.id, stock.id]);
    expect(first.items.map((item) => item.categorisation)).toEqual(Array(3).fill({
      confidence: "medium", source: "item", kind: "business", reason: null, newCategory: true,
    }));

    const second = await scan(owner, RESTOCK);
    expect(await categoryNames(owner)).toEqual(["Inventory / Stock"]);
    expect(second.items.every((item) => item.categoryId === stock.id && item.categorisation?.newCategory === false)).toBe(true);
  });

  it("files into the owner's own category under another name instead of creating a duplicate", async () => {
    const owner = await makeOwnerWithProfile({ type: "Sari-sari store" }, ["Stock", "Utilities"]);
    const result = await scan(owner, RESTOCK);

    expect(await categoryNames(owner)).toEqual(["Stock", "Utilities"]);
    expect(result.items.every((item) => item.categoryId === owner.categories.Stock)).toBe(true);
  });

  it("keeps each business's categories to itself", async () => {
    const store = await makeOwnerWithProfile({ type: "Sari-sari store" }, []);
    const consultant = await makeOwnerWithProfile({ type: "Services" }, []);
    const storeScan = await scan(store, RESTOCK);
    const consultantScan = await scan(consultant, RESTOCK);

    expect(await categoryNames(store)).toEqual(["Inventory / Stock"]);
    expect(await categoryNames(consultant)).toEqual(["Groceries", "Personal Care"]);
    const storeIds = new Set((await prisma.expenseCategory.findMany({ where: { businessProfileId: store.profile.id } })).map((row) => row.id));
    const consultantIds = new Set((await prisma.expenseCategory.findMany({ where: { businessProfileId: consultant.profile.id } })).map((row) => row.id));
    expect(storeScan.items.every((item) => storeIds.has(item.categoryId!))).toBe(true);
    expect(consultantScan.items.every((item) => consultantIds.has(item.categoryId!))).toBe(true);
  });

  it("prefers the owner's own earlier decision over the categoriser", async () => {
    const owner = await makeOwnerWithProfile({ type: "Sari-sari store" }, ["Inventory", "Utilities"]);
    await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/history.jpg`,
        processingStatus: "Complete",
        confirmationStatus: "Confirmed",
        extractedVendor: "PUREGOLD PRICE CLUB",
        items: { create: [{ lineNumber: 1, name: "SAFEGUARD BAR 65G", amount: 1, categoryId: owner.categories.Utilities! }] },
      },
    });
    const result = await scan(owner, RESTOCK);

    expect(result.items[0]).toMatchObject({ categoryId: owner.categories.Utilities, categorisation: { source: "history" } });
    expect(result.items.slice(1).every((item) => item.categoryId === owner.categories.Inventory)).toBe(true);
  });

  it("creates business and personal categories side by side, says which is which, and flags the personal line", async () => {
    const owner = await makeOwnerWithProfile({ type: "Services" }, []);
    const result = await scan(owner, MIXED);

    const categories = await listCategories(owner.user.id, owner.profile.id);
    expect(categories.map((category) => [category.name, category.kind])).toEqual([
      ["Personal Care", "personal"],
      ["Printing Supplies", "business"],
    ]);
    expect(result.items.map((item) => item.categorisation)).toEqual([
      { confidence: "medium", source: "item", kind: "business", reason: null, newCategory: true },
      { confidence: "low", source: "item", kind: "personal", reason: expect.stringMatching(/personal/), newCategory: true },
    ]);
  });

  it("leaves a line nothing explains in Uncategorized, flagged for the owner", async () => {
    const owner = await makeOwnerWithProfile({ type: "Services" }, []);
    const result = await scan(owner, UNPLACEABLE);

    expect(await categoryNames(owner)).toEqual(["Uncategorized"]);
    expect(result.items[0]!.categorisation).toMatchObject({ confidence: "low", source: "none", kind: null });
  });

  it("saves the categories the owner chose, not the ones FinSight suggested", async () => {
    const owner = await makeOwnerWithProfile({ type: "Sari-sari store" }, ["Inventory", "Utilities"]);
    const result = await scan(owner, RESTOCK);
    expect(result.items.every((item) => item.categoryId === owner.categories.Inventory)).toBe(true);

    await confirmReceipt(owner.user.id, result.id, {
      date: "2026-09-28",
      description: "Restock",
      amount: 980,
      itemAssignments: result.items.map((item, index) => ({
        itemId: item.id,
        categoryId: index === 0 ? owner.categories.Utilities! : owner.categories.Inventory!,
      })),
    });

    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: result.id }, orderBy: { lineNumber: "asc" } });
    expect(items.map((item) => item.categoryId)).toEqual([owner.categories.Utilities, owner.categories.Inventory, owner.categories.Inventory]);
    const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: result.id } });
    expect(new Set(records.map((record) => record.categoryId))).toEqual(new Set([owner.categories.Utilities, owner.categories.Inventory]));
  });

  it("decides every category on the server without calling out", async () => {
    const owner = await makeOwnerWithProfile({ type: "Food business" }, []);
    await scan(owner, RESTOCK);
    await scan(owner, MIXED);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(categoriseMock).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
  });
});
