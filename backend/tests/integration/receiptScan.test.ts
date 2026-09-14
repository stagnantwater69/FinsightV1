import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Storage is external; OCR is mocked here so this test covers the FLOW
// (upload -> extract -> pending -> confirm -> expense record) deterministically.
// Real OCR accuracy is measured separately by the OCR accuracy assessment
// against a sample of real and degraded images — that is a different question
// from whether the flow wires up correctly.
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

// vi.mock is hoisted above ordinary declarations, so the spy has to be created
// inside vi.hoisted to exist by the time the factory runs. parseReceiptFields is
// kept real — this test asserts on its actual parsing of the OCR text.
const { extractTextMock, confidenceRef } = vi.hoisted(() => ({
  extractTextMock: vi.fn(),
  // Page confidence the mocked read reports. A mutable ref rather than a
  // second vi.fn so a test can say "this receipt was read badly" in one line.
  confidenceRef: { value: 95 },
}));
vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  /*
   * extractReceipt is derived from the same mock rather than being a second
   * one. The service reads receipts through it (text PLUS tesseract's
   * per-word confidences); leaving it unmocked ran real OCR against
   * Buffer.from("fake-image-bytes") and every test failed with "Error
   * attempting to read image". Deriving it means a test that sets the OCR
   * text still controls the whole read, and the two can never disagree about
   * what this receipt says.
   *
   * `lines` is empty: these tests assert on grouping and failure handling,
   * not on confidence, so an empty list is the honest "not measured" input
   * and confidenceForValue correctly returns null for every field.
   *
   * The default confidence is 95 — a clean read — and that default is load-
   * bearing now that a low page confidence sends the receipt to the vision
   * model. It was previously 0, which after the trigger landed meant every
   * test in this file silently exercised the rescue path. Tests that want the
   * rescue set confidenceRef.value themselves.
   */
  return {
    ...actual,
    extractText: extractTextMock,
    extractReceipt: async (...args: unknown[]) => ({
      text: await extractTextMock(...args),
      confidence: confidenceRef.value,
      lines: [],
    }),
  };
});

// Retained as a tripwire for the pre-Phase-1 categorisation path. Receipt
// items must be categorised locally from confirmed owner history.
const { categoriseMock } = vi.hoisted(() => ({ categoriseMock: vi.fn() }));
vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, categoriseReceiptItems: categoriseMock };
});

// Retained as a tripwire for the pre-Phase-1 direct-vision path. Receipt
// extraction may now reach a provider only through its consent/budget gate.
const { visionMock } = vi.hoisted(() => ({ visionMock: vi.fn() }));
vi.mock("../../src/services/visionOcr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/visionOcr.service")>();
  return { ...actual, extractReceiptWithVision: visionMock };
});

import { prisma } from "../../src/config/prisma";
import type { VisionReceipt } from "../../src/services/visionOcr.service";
import { confirmReceipt, deleteScanItem, getScan, uploadAndScan } from "../../src/services/receiptScan.service";
import { getExpenseRecord } from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, runReceiptWorkerAndWait, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

/**
 * Wraps a plain reading in the extraction envelope the service now receives.
 *
 * The envelope distinguishes "the provider was never reached" (null) from
 * "the provider answered and the answer was refused" ({receipt: null,
 * rejectReason}) — a distinction the per-scan version record needs. These
 * tests are about what the pipeline DOES with an accepted reading, so they
 * state the reading and let this fill in the rest; the per-field evidence
 * fields default to null exactly as a model that did not report them would
 * leave them.
 */
function visionReply(receipt: Partial<VisionReceipt> & { items?: Partial<VisionReceipt["items"][number]>[] }) {
  return {
    receipt: {
      date: receipt.date ?? null,
      vendor: receipt.vendor ?? null,
      amount: receipt.amount ?? null,
      warnings: receipt.warnings ?? [],
      items: (receipt.items ?? []).map((item) => ({
        name: item!.name!,
        quantity: item!.quantity ?? null,
        amount: item!.amount!,
        pageNumber: item!.pageNumber ?? null,
        sourceText: item!.sourceText ?? null,
      })),
    },
    rejectReason: null,
  };
}

const RECEIPT_TEXT = [
  "ABC SARI-SARI STORE",
  "123 Apas Road, Cebu City",
  "Date: 2026-07-20",
  "Rice 25kg          1220.00",
  "Cooking oil          180.00",
  "TOTAL             1400.00",
  "Thank you!",
].join("\n");

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 });
  extractTextMock.mockReset();
  categoriseMock.mockReset();
  categoriseMock.mockResolvedValue([]);
  visionMock.mockReset();
  visionMock.mockResolvedValue(null);
  confidenceRef.value = 95;
  extractTextMock.mockResolvedValue(RECEIPT_TEXT);
});

afterAll(disconnectDb);

/**
 * Uploads a receipt and returns it once the background read has finished.
 *
 * uploadAndScan now returns as soon as the photographs are stored, with OCR
 * and categorisation continuing behind the response — so every assertion in
 * this file about extracted fields would otherwise be racing work that had
 * not happened yet. Polling here mirrors exactly what both clients do, so
 * these tests exercise the real contract rather than an internal shortcut.
 */
async function upload() {
  const created = await uploadAndScan(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    pages: [{ buffer: Buffer.from("fake-image-bytes"), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
  });
  await runReceiptWorkerAndWait(created.id);
  return getScan(ctx.user.id, created.id);
}

async function establishCategoryChoices(
  choices: { name: string; categoryId: number }[],
  vendor = "ABC SARI-SARI STORE",
) {
  await prisma.receiptScan.create({
    data: {
      businessProfileId: ctx.profile.id,
      imageFile: `${ctx.profile.id}/category-history.jpg`,
      processingStatus: "Complete",
      confirmationStatus: "Confirmed",
      extractedVendor: vendor,
      items: {
        create: choices.map((choice, index) => ({
          lineNumber: index + 1,
          name: choice.name,
          amount: 1,
          categoryId: choice.categoryId,
        })),
      },
    },
  });
}

describe("upload and scan", () => {
  it("creates a Pending scan with the extracted fields", async () => {
    const scan = await upload();
    expect(scan.confirmationStatus).toBe("Pending");
    expect(scan).not.toHaveProperty("imageFile");
    expect(scan.extractedAmount).toBe(1400);
    expect(scan.extractedVendor).toBe("ABC SARI-SARI STORE");
    expect(scan.extractedDate?.toISOString().slice(0, 10)).toBe("2026-07-20");
  });

  it("does not create an expense record until the owner confirms", async () => {
    await upload();
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("stores the scan even when OCR extracts nothing usable", async () => {
    // A blurry photo must still produce a reviewable scan the owner can correct
    // by hand, not an error that loses their upload.
    extractTextMock.mockResolvedValue("~~~ unreadable ~~~");
    const scan = await upload();
    expect(scan.confirmationStatus).toBe("Pending");
    expect(scan.extractedAmount).toBeNull();
  });

  it("links the scan to the business profile", async () => {
    const scan = await upload();
    expect(scan.businessProfileId).toBe(ctx.profile.id);
  });

  it("refuses to scan into another owner's profile, with 404 not 403", async () => {
    const other = await makeOwnerWithProfile();
    await expect(
      uploadAndScan(ctx.user.id, {
        businessProfileId: other.profile.id,
        pages: [{ buffer: Buffer.from("x"), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(await prisma.receiptScan.count({ where: { businessProfileId: other.profile.id } })).toBe(0);
  });
});

describe("automatic itemisation at scan time", () => {
  it("extracts and stores the receipt's line items", async () => {
    const scan = await upload();
    expect(scan.items).toHaveLength(2);
    expect(scan.items.map((i) => i.name)).toEqual(["Rice 25kg", "Cooking oil"]);
    expect(scan.items.map((i) => i.amount)).toEqual([1220, 180]);
    expect(scan.items.map((i) => i.lineNumber)).toEqual([1, 2]);
  });

  it("applies exact category choices from the owner's confirmed history", async () => {
    await establishCategoryChoices([
      { name: "Rice 25kg", categoryId: ctx.categories.Inventory! },
      { name: "Cooking oil", categoryId: ctx.categories.Utilities! },
    ]);
    const scan = await upload();
    expect(scan.items[0]!.categoryId).toBe(ctx.categories.Inventory);
    expect(scan.items[1]!.categoryId).toBe(ctx.categories.Utilities);
  });

  it("does not send item or category text to the legacy AI categoriser", async () => {
    await upload();
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /**
   * The honest fallback. An item the model wouldn't place lands in a standing
   * "Uncategorized" category rather than being guessed into one of the real
   * ones — the owner sees plainly that there is something left to decide.
   */
  it("falls back to a standing Uncategorized category for unplaced items", async () => {
    await establishCategoryChoices([{ name: "Rice 25kg", categoryId: ctx.categories.Inventory! }]);
    const scan = await upload();

    const uncategorised = await prisma.expenseCategory.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, name: "Uncategorized" },
    });
    expect(scan.items[0]!.categoryId).toBe(ctx.categories.Inventory);
    expect(scan.items[1]!.categoryId).toBe(uncategorised.id);
  });

  it("creates the Uncategorized category only when something actually needs it", async () => {
    await establishCategoryChoices([
      { name: "Rice 25kg", categoryId: ctx.categories.Inventory! },
      { name: "Cooking oil", categoryId: ctx.categories.Utilities! },
    ]);
    await upload();
    expect(
      await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id, name: "Uncategorized" } }),
    ).toBe(0);
  });

  it("reuses an existing Uncategorized rather than making a second one", async () => {
    await upload(); // creates it
    await upload(); // must not create another
    expect(
      await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id, name: "Uncategorized" } }),
    ).toBe(1);
  });

  it("never calls the legacy model after creating Uncategorized", async () => {
    await upload(); // creates Uncategorized
    categoriseMock.mockClear();
    await upload();
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  it("stores items without depending on the legacy provider categoriser", async () => {
    categoriseMock.mockRejectedValue(new Error("provider down"));
    const scan = await upload();
    expect(scan.items).toHaveLength(2);
    expect(scan.confirmationStatus).toBe("Pending");
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  it("stores no items for a receipt with no parseable item lines", async () => {
    extractTextMock.mockResolvedValue(["MANG JOSE STORE", "Date: 2026-07-18", "TOTAL   845.50"].join("\n"));
    const scan = await upload();
    expect(scan.items).toEqual([]);
    // Nothing to categorise means nothing was asked.
    expect(categoriseMock).not.toHaveBeenCalled();
  });
});

/** Provider responses are tripwires: receipt categorisation stays local. */
describe("provider category proposals disabled for receipt data", () => {
  it("stores no unconsented provider proposal against the item", async () => {
    categoriseMock.mockResolvedValue([
      { index: 0, match: null, suggestNew: "Packaging" },
      { index: 1, match: "Utilities", suggestNew: null },
    ]);
    const scan = await upload();
    expect(scan.items[0]!.suggestedCategoryName).toBeNull();
  });

  it("returns the same null proposal stored in the database", async () => {
    categoriseMock.mockResolvedValue([{ index: 0, match: null, suggestNew: "Packaging" }]);
    const scan = await upload();
    const fromDb = await prisma.receiptScanItem.findFirstOrThrow({ where: { id: scan.items[0]!.id } });
    expect(fromDb.suggestedCategoryName).toBeNull();
    expect(scan.items[0]!.suggestedCategoryName).toBe(fromDb.suggestedCategoryName);
  });

  /**
   * The line between a suggestion and a decision. Creating the category here
   * would put a name in the owner's books that they never chose — the exact
   * thing the categoriser's grounding rules exist to prevent.
   */
  it("does not create the proposed category", async () => {
    categoriseMock.mockResolvedValue([{ index: 0, match: null, suggestNew: "Packaging" }]);
    await upload();
    expect(
      await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id, name: "Packaging" } }),
    ).toBe(0);
  });

  it("files the unplaced item in Uncategorized without a provider proposal", async () => {
    categoriseMock.mockResolvedValue([{ index: 0, match: null, suggestNew: "Packaging" }]);
    const scan = await upload();
    const uncategorised = await prisma.expenseCategory.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, name: "Uncategorized" },
    });
    expect(scan.items[0]!.categoryId).toBe(uncategorised.id);
  });

  it("carries no proposal for an item that matched an existing category", async () => {
    categoriseMock.mockResolvedValue([{ index: 0, match: "Inventory", suggestNew: null }]);
    const scan = await upload();
    expect(scan.items[0]!.suggestedCategoryName).toBeNull();
  });
});

/* Direct vision rescue was replaced by the consent-and-budget provider gate. */
describe("local fallback when receipt provider rescue is unavailable", () => {
  /** A receipt tesseract read a total from but no item lines. */
  const TOTAL_ONLY = ["MANG JOSE STORE", "Date: 2026-07-18", "TOTAL   845.50"].join("\n");
  /** A receipt tesseract got nothing usable from at all. */
  const UNREADABLE = "~~~ unreadable ~~~";

  it("does not call the legacy vision path for a clean receipt", async () => {
    await upload(); // RECEIPT_TEXT parses to 2 items and a total
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("does not bypass the provider gate when OCR found no line items", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    await upload();
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("does not bypass the provider gate when OCR found no total", async () => {
    extractTextMock.mockResolvedValue(UNREADABLE);
    await upload();
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("ignores an un-gated legacy vision reply and keeps the local result reviewable", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    visionMock.mockResolvedValue(visionReply({
      date: "2026-07-18",
      vendor: "MANG JOSE STORE",
      amount: 845.5,
      items: [
        { name: "Spareribs Meal", quantity: null, amount: 129 },
        { name: "Iced Latte 16oz", quantity: 2, amount: 118 },
      ],
    }));

    const scan = await upload();
    expect(scan.items).toEqual([]);
    expect(scan.extractedAmount).toBe(845.5);
    expect(scan.visionAssisted).toBe(false);
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("does not create model-derived items outside the provider gate", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    visionMock.mockResolvedValue(visionReply({
      date: null,
      vendor: null,
      amount: null,
      items: [
        { name: "Two of these", quantity: 2, amount: 118 },
        { name: "No quantity printed", quantity: null, amount: 129 },
      ],
    }));

    const scan = await upload();
    expect(scan.items).toEqual([]);
    expect(visionMock).not.toHaveBeenCalled();
  });

  /**
   * The date rule, and the reason for it.
   *
   * "03/09/2026" cannot be resolved by reading harder — both components are
   * <= 12, so the answer is the Philippine DD/MM convention rather than
   * anything visible. Measured across three corpus runs the model answered
   * such a receipt inconsistently; the parser has the rule compiled in and is
   * right every time. So the parser's date must survive a rescue.
   */
  it("keeps the deterministic date even when the model disagrees", async () => {
    extractTextMock.mockResolvedValue(["MANG JOSE STORE", "Date: 03/09/2026", "TOTAL 845.50"].join("\n"));
    visionMock.mockResolvedValue(visionReply({
      date: "2026-03-09", // the MM/DD reading — wrong for this market
      vendor: "MANG JOSE STORE",
      amount: 845.5,
      items: [{ name: "Assorted goods", quantity: null, amount: 845.5 }],
    }));

    const scan = await upload();
    expect(scan.extractedDate?.toISOString().slice(0, 10)).toBe("2026-09-03");
  });

  it("does not use an un-gated model date when OCR found none", async () => {
    extractTextMock.mockResolvedValue(UNREADABLE);
    visionMock.mockResolvedValue(visionReply({ date: "2026-07-18", vendor: null, amount: 845.5, items: [] }));
    const scan = await upload();
    expect(scan.extractedDate).toBeNull();
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("keeps the local total when an un-gated model reply disagrees", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    visionMock.mockResolvedValue(visionReply({ date: null, vendor: null, amount: 999.99, items: [] }));
    const scan = await upload();
    expect(scan.extractedAmount).toBe(845.5);
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("never replaces items the deterministic parser already read", async () => {
    // OCR found items but no total. An un-gated mock reply must not touch them.
    extractTextMock.mockResolvedValue(["ABC STORE", "Rice 25kg   1220.00"].join("\n"));
    visionMock.mockResolvedValue(visionReply({
      date: null,
      vendor: null,
      amount: 1220,
      items: [{ name: "Something else entirely", quantity: null, amount: 50 }],
    }));

    const scan = await upload();
    expect(scan.items.map((i) => i.name)).toEqual(["Rice 25kg"]);
    expect(scan.items.every((i) => i.extractedByVision)).toBe(false);
  });

  it("leaves the scan as OCR left it when no provider rescue occurs", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    visionMock.mockResolvedValue(null);
    const scan = await upload();
    expect(scan.extractedAmount).toBe(845.5);
    expect(scan.items).toEqual([]);
    expect(scan.visionAssisted).toBe(false);
  });

  it("does not claim vision assistance without an accepted provider field", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    visionMock.mockResolvedValue(visionReply({ date: null, vendor: null, amount: null, items: [] }));
    const scan = await upload();
    expect(scan.visionAssisted).toBe(false);
  });

  it("does not categorise items supplied only by the legacy vision mock", async () => {
    extractTextMock.mockResolvedValue(TOTAL_ONLY);
    visionMock.mockResolvedValue(visionReply({
      date: null,
      vendor: null,
      amount: null,
      items: [{ name: "Rice 25kg", quantity: null, amount: 845.5 }],
    }));
    categoriseMock.mockResolvedValue([{ index: 0, match: "Inventory", suggestNew: null }]);

    const scan = await upload();
    expect(scan.items).toEqual([]);
    expect(categoriseMock).not.toHaveBeenCalled();
  });
});

/**
 * Correcting a vendor against the ones this business has confirmed before.
 *
 * The reference data is what the OWNER typed on the confirm screen, so these
 * tests all establish history the honest way — by confirming a receipt — rather
 * than writing vendor rows straight into the database.
 */
describe("vendor corrected from confirmed history", () => {
  /** Confirms one receipt so the business has a known vendor on record. */
  async function establishHistory(vendor: string) {
    extractTextMock.mockResolvedValue(
      [vendor, "Date: 2026-07-20", "Rice 25kg 1220.00", "Cooking oil 180.00", "TOTAL 1400.00"].join("\n"),
    );
    const scan = await upload();
    await confirmReceipt(ctx.user.id, scan.id, {
      date: "2026-07-20",
      description: `Purchase from ${vendor}`,
      vendor,
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory })),
    });
  }

  it("snaps a noisy reading to the confirmed spelling", async () => {
    await establishHistory("SAVEMORE MARKET");

    // Same shop, read with a zero for the O.
    extractTextMock.mockResolvedValue(
      ["SAVEM0RE MARKET", "Date: 2026-07-21", "Bread 60.00", "TOTAL 60.00"].join("\n"),
    );
    const scan = await upload();
    expect(scan.extractedVendor).toBe("SAVEMORE MARKET");
  });

  /**
   * The original complaint. A stylised logo mangles into a short scrap that
   * outranks the real registered name printed below it — until the business's
   * own history says which of the two is a shop it actually buys from.
   */
  it("overrules a vendor read off the wrong line", async () => {
    await establishHistory("SANFORD MARKETING CORPORATION");

    extractTextMock.mockResolvedValue(
      ["Dore", "SANFORD MARKETING CORPORATION", "Date: 2026-07-21", "Bread 60.00", "TOTAL 60.00"].join("\n"),
    );
    const scan = await upload();
    expect(scan.extractedVendor).toBe("SANFORD MARKETING CORPORATION");
    // The description the owner reads is rebuilt from the corrected name.
    expect(scan.extractedDescription).toBe("Purchase from SANFORD MARKETING CORPORATION");
  });

  it("leaves a receipt from a genuinely new shop alone", async () => {
    await establishHistory("SAVEMORE MARKET");

    extractTextMock.mockResolvedValue(
      ["MERCURY DRUG STORE", "Date: 2026-07-21", "Paracetamol 60.00", "TOTAL 60.00"].join("\n"),
    );
    const scan = await upload();
    expect(scan.extractedVendor).toBe("MERCURY DRUG STORE");
  });

  /** A business with no confirmed receipts yet must behave exactly as before. */
  it("changes nothing for a business with no history", async () => {
    const scan = await upload();
    expect(scan.extractedVendor).toBe("ABC SARI-SARI STORE");
  });

  /**
   * History corrects the NAME and nothing else. A vendor match must never
   * reach the figures — those are the owner's money, and they come off the
   * receipt in front of them, not off a previous one.
   */
  it("never lets history touch the amount or the date", async () => {
    await establishHistory("SAVEMORE MARKET");

    extractTextMock.mockResolvedValue(
      ["SAVEM0RE MARKET", "Date: 2026-07-29", "Bread 60.00", "TOTAL 60.00"].join("\n"),
    );
    const scan = await upload();
    expect(scan.extractedVendor).toBe("SAVEMORE MARKET");
    expect(scan.extractedAmount).toBe(60);
    expect(scan.extractedDate?.toISOString().slice(0, 10)).toBe("2026-07-29");
  });

  /** One business's suppliers must never leak into another's readings. */
  it("does not use another business's vendors", async () => {
    await establishHistory("SAVEMORE MARKET");
    const other = await makeOwnerWithProfile();

    extractTextMock.mockResolvedValue(
      ["SAVEM0RE MARKET", "Date: 2026-07-21", "Bread 60.00", "TOTAL 60.00"].join("\n"),
    );
    const created = await uploadAndScan(other.user.id, {
      businessProfileId: other.profile.id,
      pages: [{ buffer: Buffer.from("fake-image-bytes"), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
    });
    await runReceiptWorkerAndWait(created.id);
    const scan = await getScan(other.user.id, created.id);
    // Uncorrected: this business has never confirmed that vendor.
    expect(scan.extractedVendor).toBe("SAVEM0RE MARKET");
  });
});

describe("doubtful local reads without provider authorization", () => {
  /** Items 20.00 short of the printed total, with nothing explaining the gap. */
  const MISREAD = [
    "ABC SARI-SARI STORE",
    "Date: 2026-07-20",
    "Del Monte Pineapple    62.00",
    "Rice 25kg             607.75",
    "TOTAL                 689.75",
  ].join("\n");

  it("does not call legacy vision when items do not account for the total", async () => {
    extractTextMock.mockResolvedValue(MISREAD);
    await upload();
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("does not call legacy vision when tesseract was unsure", async () => {
    confidenceRef.value = 40;
    await upload();
    expect(visionMock).not.toHaveBeenCalled();
  });

  /* VAT can explain a local item/total gap without authorizing a provider. */
  it("keeps a confident VAT receipt local when its gap is explained", async () => {
    extractTextMock.mockResolvedValue(
      ["ABC STORE", "Date: 2026-07-20", "Goods 1000.00", "SUBTOTAL 1000.00", "VAT 12% 120.00", "TOTAL 1120.00"].join(
        "\n",
      ),
    );
    const scan = await upload();
    expect(visionMock).not.toHaveBeenCalled();
    expect(scan.extractedAmount).toBe(1120);
    expect(scan.items.map((i) => i.amount)).toEqual([1000]);
  });

  it("keeps a receipt that already adds up entirely local", async () => {
    const scan = await upload();
    expect(visionMock).not.toHaveBeenCalled();
    expect(scan.extractedAmount).toBe(1400);
  });

  it("does not take un-gated model items even when they would settle the gap", async () => {
    extractTextMock.mockResolvedValue(MISREAD);
    visionMock.mockResolvedValue(visionReply({
      date: "2026-07-20",
      vendor: "ABC SARI-SARI STORE",
      amount: 689.75,
      items: [
        { name: "Del Monte Pineapple", quantity: null, amount: 82 },
        { name: "Rice 25kg", quantity: null, amount: 607.75 },
      ],
    }));

    const scan = await upload();
    expect(scan.items.map((i) => i.amount)).toEqual([62, 607.75]);
    expect(scan.items.every((i) => !i.extractedByVision)).toBe(true);
    expect(visionMock).not.toHaveBeenCalled();
  });

  /**
   * The conservative half of the rule. If the model's reading does not add up
   * either, there is no evidence it did better — so the OCR figures stand and
   * the owner is pointed at the doubtful line instead.
   */
  it("keeps OCR's amounts when the model's items also fail to add up", async () => {
    extractTextMock.mockResolvedValue(MISREAD);
    visionMock.mockResolvedValue(visionReply({
      date: null,
      vendor: null,
      amount: null,
      items: [
        { name: "Del Monte Pineapple Tidbits", quantity: null, amount: 62 },
        { name: "Rice 25kg", quantity: null, amount: 500 },
      ],
    }));

    const scan = await upload();
    expect(scan.items.map((i) => i.amount)).toEqual([62, 607.75]);
  });

  /**
   * The targeted repair: where the arithmetic already corroborates every
   * amount, only the NAMES are in doubt, and only those are taken from the
   * model. This is the "DelMontePttCrspOrg read as Sey" case.
   */
  it("keeps OCR wording and amounts when an un-gated model offers replacements", async () => {
    confidenceRef.value = 40;
    extractTextMock.mockResolvedValue(
      ["ABC SARI-SARI STORE", "Date: 2026-07-20", "Sey 82.00", "Rice 25kg 607.75", "TOTAL 689.75"].join("\n"),
    );
    visionMock.mockResolvedValue(visionReply({
      date: "2026-07-20",
      vendor: "ABC SARI-SARI STORE",
      amount: 689.75,
      items: [
        { name: "Del Monte Pineapple Tidbits", quantity: null, amount: 82 },
        { name: "Rice 25kg", quantity: null, amount: 607.75 },
      ],
    }));

    const scan = await upload();
    expect(scan.items.map((i) => i.name)).toEqual(["Sey", "Rice 25kg"]);
    expect(scan.items.map((i) => i.amount)).toEqual([82, 607.75]);
    expect(scan.visionAssisted).toBe(false);
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("keeps every OCR name when the un-gated model reports only one line", async () => {
    confidenceRef.value = 40;
    extractTextMock.mockResolvedValue(
      ["ABC SARI-SARI STORE", "Date: 2026-07-20", "Sey 82.00", "Rice 25kg 607.75", "TOTAL 689.75"].join("\n"),
    );
    visionMock.mockResolvedValue(visionReply({
      date: null,
      vendor: null,
      amount: null,
      items: [{ name: "Del Monte Pineapple Tidbits", quantity: null, amount: 82 }],
    }));

    const scan = await upload();
    expect(scan.items.map((i) => i.name)).toEqual(["Sey", "Rice 25kg"]);
    expect(visionMock).not.toHaveBeenCalled();
  });
});

describe("local confirmed-category history", () => {
  it("does not send the vendor to the legacy provider categoriser", async () => {
    const scan = await upload();
    expect(scan.extractedVendor).toBe("ABC SARI-SARI STORE");
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /**
   * The vendor the model is told about and the vendor the owner sees on the
   * confirm screen are the same read, not two. If these could drift, the
   * screen would be showing one store while the categories were reasoned
   * from another.
   */
  it("keeps categorisation local when the stored vendor is present", async () => {
    const scan = await upload();
    expect(scan.extractedVendor).toBe("ABC SARI-SARI STORE");
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /**
   * The feedback loop. Without this the same wrong guess arrives every week
   * however many times the owner corrects it.
   */
  it("reuses the categories this business confirmed on earlier receipts", async () => {
    const first = await upload();
    await confirmReceipt(ctx.user.id, first.id, {
      date: "2026-07-20",
      description: "Groceries",
      amount: 1400,
      itemAssignments: first.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory })),
    });

    const repeated = await upload();

    expect(repeated.items.every((item) => item.categoryId === ctx.categories.Inventory)).toBe(true);
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /**
   * The guard that keeps the loop from eating its own tail.
   *
   * A pending scan's categories are the model's OWN unreviewed guesses.
   * Replaying those would teach it whatever it happened to say last time and
   * amplify a mistake instead of correcting it. Only a confirmed scan carries
   * a decision a human actually made.
   */
  it("ignores categories from scans the owner has not confirmed yet", async () => {
    const first = await upload(); // left Pending
    const uncategorised = await prisma.expenseCategory.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, name: "Uncategorized" },
    });
    const second = await upload();

    expect(first.items.every((item) => item.categoryId === uncategorised.id)).toBe(true);
    expect(second.items.every((item) => item.categoryId === uncategorised.id)).toBe(true);
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /** "It went in Uncategorized" is the absence of a decision, not one. */
  it("does not replay items left in Uncategorized", async () => {
    const first = await upload(); // no matches, so both land in Uncategorized
    const uncategorised = await prisma.expenseCategory.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, name: "Uncategorized" },
    });
    await confirmReceipt(ctx.user.id, first.id, {
      date: "2026-07-20",
      description: "Groceries",
      amount: 1400,
      itemAssignments: first.items.map((i) => ({ itemId: i.id, categoryId: uncategorised.id })),
    });

    const repeated = await upload();

    expect(repeated.items.every((item) => item.categoryId === uncategorised.id)).toBe(true);
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /** One business's habits must never leak into another's suggestions. */
  it("never replays another business's choices", async () => {
    const first = await upload();
    await confirmReceipt(ctx.user.id, first.id, {
      date: "2026-07-20",
      description: "Groceries",
      amount: 1400,
      itemAssignments: first.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory })),
    });

    const other = await makeOwnerWithProfile();
    const otherScan = await uploadAndScan(other.user.id, {
      businessProfileId: other.profile.id,
      pages: [{ buffer: Buffer.from("fake-image-bytes"), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
    });
    await runReceiptWorkerAndWait(otherScan.id);
    const otherUncategorised = await prisma.expenseCategory.findFirstOrThrow({
      where: { businessProfileId: other.profile.id, name: "Uncategorized" },
    });
    const otherResult = await getScan(other.user.id, otherScan.id);

    expect(otherResult.items.every((item) => item.categoryId === otherUncategorised.id)).toBe(true);
    expect(categoriseMock).not.toHaveBeenCalled();
  });

  /** A history read that fails must cost the owner no more than the guess. */
  it("still stores the items when the history read fails", async () => {
    const historyRead = vi.spyOn(prisma.receiptScanItem, "findMany").mockRejectedValueOnce(new Error("history unavailable"));
    try {
      const scan = await upload();
      expect(scan.items).toHaveLength(2);
      expect(scan.items.every((i) => i.suggestedCategoryName === null)).toBe(true);
    } finally {
      historyRead.mockRestore();
    }
  });
});

/**
 * Removing a line OCR read that was never a purchase.
 *
 * The row is deleted rather than hidden client-side because confirmation
 * requires every stored item to carry a category — a line the review screen
 * merely stopped sending would block Confirm with a message about an item the
 * owner can no longer see.
 */
describe("removing a line that was not a purchase", () => {
  it("deletes the line and returns the scan without it", async () => {
    const scan = await upload();
    const updated = await deleteScanItem(ctx.user.id, scan.id, scan.items[0]!.id);
    expect(updated.items.map((i) => i.name)).toEqual(["Cooking oil"]);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id } })).toBe(1);
  });

  it("lets the remaining items confirm, with the gap reconciled", async () => {
    // Deleting a line widens the gap against the total the owner confirmed.
    // That is the reconciliation step's job, not a reason to refuse.
    const scan = await upload();
    const updated = await deleteScanItem(ctx.user.id, scan.id, scan.items[0]!.id);
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: "2026-07-20",
      description: "Groceries",
      amount: 1400,
      itemAssignments: updated.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory })),
      reconciliation: { mode: "proportional" },
    });
    expect(records).toHaveLength(1);
    expect(Number(records[0]!.amount)).toBe(1400);
  });

  it("refuses to touch another owner's scan, with 404 not 403", async () => {
    const scan = await upload();
    const other = await makeOwnerWithProfile();
    await expect(deleteScanItem(other.user.id, scan.id, scan.items[0]!.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id } })).toBe(2);
  });

  it("refuses an item id that belongs to a different receipt", async () => {
    const scan = await upload();
    const otherScan = await upload();
    await expect(deleteScanItem(ctx.user.id, scan.id, otherScan.items[0]!.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: otherScan.id } })).toBe(2);
  });

  it("refuses once the scan is confirmed", async () => {
    // The items are the evidence for records that now exist; deleting one
    // would leave a record whose breakdown no longer explains its amount.
    const scan = await upload();
    await confirmReceipt(ctx.user.id, scan.id, {
      date: "2026-07-20",
      description: "Groceries",
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory })),
    });
    await expect(deleteScanItem(ctx.user.id, scan.id, scan.items[0]!.id)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("confirming an itemised receipt", () => {
  async function uploadCategorised() {
    await establishCategoryChoices([
      { name: "Rice 25kg", categoryId: ctx.categories.Inventory! },
      { name: "Cooking oil", categoryId: ctx.categories.Utilities! },
    ]);
    return upload();
  }

  it("creates ONE record per category group, not one per item", async () => {
    extractTextMock.mockResolvedValue(
      ["STORE", "Date: 2026-07-20", "Buns  60.00", "Patty  320.00", "Rice cooker  1020.00", "TOTAL 1400.00"].join("\n"),
    );
    await establishCategoryChoices([
      { name: "Buns", categoryId: ctx.categories.Inventory! },
      { name: "Patty", categoryId: ctx.categories.Inventory! },
      { name: "Rice cooker", categoryId: ctx.categories.Utilities! },
    ], "STORE");
    const scan = await upload();
    expect(scan.items).toHaveLength(3);

    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Grocery run",
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: i.categoryId! })),
    });

    // Three items, two categories, two records.
    expect(records).toHaveLength(2);
    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    expect(inventory.amount).toBe(380); // 60 + 320
    const utilities = records.find((r) => r.categoryId === ctx.categories.Utilities)!;
    expect(utilities.amount).toBe(1020);
  });

  it("names the record after the items that composed it", async () => {
    const scan = await uploadCategorised();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "ignored on the itemised path",
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: i.categoryId! })),
    });
    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    expect(inventory.description).toBe("Rice 25kg");
  });

  /** Traceability: which items made up this record. */
  it("links each item to the record it ended up in", async () => {
    const scan = await uploadCategorised();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: i.categoryId! })),
    });

    const stored = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id }, orderBy: { lineNumber: "asc" } });
    expect(stored.every((i) => i.expenseRecordId !== null)).toBe(true);
    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    expect(stored[0]!.expenseRecordId).toBe(inventory.id);
  });

  it("honours the owner's re-assignment over the history-derived assignment", async () => {
    const scan = await uploadCategorised();
    // The owner moves both items to Inventory, overriding the prior choice.
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory! })),
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.amount).toBe(1400);

    const stored = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(stored.every((i) => i.categoryId === ctx.categories.Inventory)).toBe(true);
  });

  it("refuses when the grouped items don't sum to the confirmed total", async () => {
    const scan = await uploadCategorised();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 9999, // items come to 1400
        itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: i.categoryId! })),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("refuses when an item is left without a category", async () => {
    const scan = await uploadCategorised();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 1400,
        itemAssignments: [{ itemId: scan.items[0]!.id, categoryId: ctx.categories.Inventory! }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an item that belongs to a different receipt", async () => {
    const scan = await uploadCategorised();
    const other = await upload();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 1400,
        itemAssignments: [{ itemId: other.items[0]!.id, categoryId: ctx.categories.Inventory! }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a category belonging to another business", async () => {
    const scan = await uploadCategorised();
    const other = await makeOwnerWithProfile();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 1400,
        itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: other.categories.Inventory! })),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/*
 * Receipts whose items do not sum to the total.
 *
 * This is the normal case on a VAT-exclusive register, not an error state.
 * RECEIPT_TEXT gives two items (1220.00 + 180.00 = 1400.00), so confirming a
 * different total exercises the gap directly.
 *
 * The invariant every test here defends: the confirmed total is what gets
 * saved. Money the owner actually spent must never be dropped to make the
 * arithmetic balance.
 */
describe("reconciling a receipt whose items don't sum to the total", () => {
  async function uploadCategorised() {
    await establishCategoryChoices([
      { name: "Rice 25kg", categoryId: ctx.categories.Inventory! },
      { name: "Cooking oil", categoryId: ctx.categories.Utilities! },
    ]);
    return upload();
  }

  const assignAsSuggested = (scan: Awaited<ReturnType<typeof upload>>) =>
    scan.items.map((i) => ({ itemId: i.id, categoryId: i.categoryId! }));

  it("spreads added tax across the categories in proportion to their subtotals", async () => {
    const scan = await uploadCategorised();
    // 1400.00 of items under a 1568.00 total — 12% VAT added on top.
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1568,
      itemAssignments: assignAsSuggested(scan),
      reconciliation: { mode: "proportional" },
    });

    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    const utilities = records.find((r) => r.categoryId === ctx.categories.Utilities)!;
    expect(inventory.amount).toBe(1366.4); // 1220.00 + its 146.40 share
    expect(utilities.amount).toBe(201.6); //   180.00 + its  21.60 share
    // The whole point: the receipt total is preserved exactly.
    expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(1568);
  });

  it("records how much of each amount was tax rather than items", async () => {
    const scan = await uploadCategorised();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1568,
      itemAssignments: assignAsSuggested(scan),
      reconciliation: { mode: "proportional" },
    });

    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    expect(inventory.allocatedCharges).toBe(146.4);
  });

  it("never loses a centavo when the gap doesn't divide evenly", async () => {
    const scan = await uploadCategorised();
    // A one-centavo gap cannot be split proportionally without rounding.
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1400.01,
      itemAssignments: assignAsSuggested(scan),
      reconciliation: { mode: "proportional" },
    });
    expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(1400.01);
  });

  it("can file the difference as its own record instead", async () => {
    const scan = await uploadCategorised();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1568,
      itemAssignments: assignAsSuggested(scan),
      reconciliation: { mode: "category", categoryId: ctx.categories.Utilities! },
    });

    // Two item groups plus the charges record.
    expect(records).toHaveLength(3);
    const charges = records.find((r) => r.description === "Tax and charges")!;
    expect(charges.amount).toBe(168);
    expect(charges.categoryId).toBe(ctx.categories.Utilities);
    expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(1568);
  });

  it("spreads a discount too, as a negative share", async () => {
    const scan = await uploadCategorised();
    // 1400.00 of items, 1330.00 paid — a 70.00 discount.
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1330,
      itemAssignments: assignAsSuggested(scan),
      reconciliation: { mode: "proportional" },
    });

    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    expect(inventory.allocatedCharges).toBe(-61);
    expect(inventory.amount).toBe(1159);
    expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(1330);
  });

  it("refuses to file a discount as its own record, which would be a negative expense", async () => {
    const scan = await uploadCategorised();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 1330,
        itemAssignments: assignAsSuggested(scan),
        reconciliation: { mode: "category", categoryId: ctx.categories.Utilities! },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("still refuses a gap when no plan is given", async () => {
    const scan = await uploadCategorised();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 1568,
        itemAssignments: assignAsSuggested(scan),
        reconciliation: { mode: "none" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("ignores the plan entirely when the receipt already reconciles", async () => {
    const scan = await uploadCategorised();
    // The VAT-inclusive case: items already sum to the total, so there is
    // nothing to allocate and no charge should be invented.
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1400,
      itemAssignments: assignAsSuggested(scan),
      reconciliation: { mode: "proportional" },
    });
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.allocatedCharges === null)).toBe(true);
  });

  it("lets the owner add a line OCR missed, closing the gap with a real item", async () => {
    const scan = await uploadCategorised();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1600,
      itemAssignments: assignAsSuggested(scan),
      additionalItems: [{ name: "Soy sauce", amount: 200, categoryId: ctx.categories.Inventory! }],
      reconciliation: { mode: "none" },
    });

    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    expect(inventory.amount).toBe(1420); // 1220 + the 200 added by hand
    expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(1600);
  });

  it("marks an owner-added line as not something FinSight read", async () => {
    const scan = await uploadCategorised();
    await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount: 1600,
      itemAssignments: assignAsSuggested(scan),
      additionalItems: [{ name: "Soy sauce", amount: 200, categoryId: ctx.categories.Inventory! }],
      reconciliation: { mode: "none" },
    });

    const stored = await prisma.receiptScanItem.findMany({
      where: { receiptScanId: scan.id },
      orderBy: { lineNumber: "asc" },
    });
    expect(stored).toHaveLength(3);
    expect(stored.slice(0, 2).every((i) => i.addedByOwner)).toBe(false);
    expect(stored[2]!.addedByOwner).toBe(true);
    expect(stored[2]!.name).toBe("Soy sauce");
    // Hand-added lines sort after the printed ones rather than claiming a
    // position on the receipt they never occupied.
    expect(stored[2]!.lineNumber).toBe(3);
  });

  it("writes nothing at all when an added line names another business's category", async () => {
    const other = await makeOwnerWithProfile();
    const scan = await uploadCategorised();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Groceries",
        amount: 1600,
        itemAssignments: assignAsSuggested(scan),
        additionalItems: [{ name: "Soy sauce", amount: 200, categoryId: other.categories.Inventory! }],
        reconciliation: { mode: "none" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    // The rejected item must not have been persisted on the way to failing —
    // an orphan row would reappear the next time the owner opened this scan.
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id } })).toBe(2);
  });
});

/*
 * Opening a saved record and seeing what is behind it.
 *
 * A record from a scan is a SUMMARY — "Inventory 1,220.00" was really a line
 * on a photographed receipt, filed next to a Utilities record from the same
 * slip. Without this, editing it showed five flat fields and no way to check
 * the figure or even recall the purchase.
 */
describe("a saved record carries where it came from", () => {
  async function confirmSplitReceipt(amount = 1400, reconciliation?: { mode: "proportional" }) {
    await establishCategoryChoices([
      { name: "Rice 25kg", categoryId: ctx.categories.Inventory! },
      { name: "Cooking oil", categoryId: ctx.categories.Utilities! },
    ]);
    const scan = await upload();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Groceries",
      amount,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: i.categoryId! })),
      ...(reconciliation ? { reconciliation } : {}),
    });
    return { scan, records };
  }

  it("returns the items that make up this record, and only this record's", async () => {
    const { records } = await confirmSplitReceipt();
    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;

    const detail = await getExpenseRecord(ctx.user.id, inventory.id);
    expect(detail.origin?.kind).toBe("receipt_scan");
    const origin = detail.origin as Extract<typeof detail.origin, { kind: "receipt_scan" }>;

    // The Utilities line belongs to the sibling record, not this one.
    expect(origin.items.map((i) => i.name)).toEqual(["Rice 25kg"]);
    expect(origin.itemsSubtotal).toBe(1220);
  });

  it("points at the other records the same receipt produced", async () => {
    const { records } = await confirmSplitReceipt();
    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;
    const utilities = records.find((r) => r.categoryId === ctx.categories.Utilities)!;

    const detail = await getExpenseRecord(ctx.user.id, inventory.id);
    const origin = detail.origin as Extract<typeof detail.origin, { kind: "receipt_scan" }>;
    expect(origin.siblings).toHaveLength(1);
    expect(origin.siblings[0]!.id).toBe(utilities.id);
    expect(origin.siblings[0]!.categoryName).toBe("Utilities");
  });

  it("keeps the items subtotal separate from the amount, so tax is visible", async () => {
    const { records } = await confirmSplitReceipt(1568, { mode: "proportional" });
    const inventory = records.find((r) => r.categoryId === ctx.categories.Inventory)!;

    const detail = await getExpenseRecord(ctx.user.id, inventory.id);
    const origin = detail.origin as Extract<typeof detail.origin, { kind: "receipt_scan" }>;
    // 1,220.00 of items inside a 1,366.40 record — the difference is the tax
    // share, and the panel shows the arithmetic rather than hiding it.
    expect(origin.itemsSubtotal).toBe(1220);
    expect(detail.amount).toBe(1366.4);
    expect(detail.allocatedCharges).toBe(146.4);
  });

  it("has no origin for a hand-typed record", async () => {
    const record = await prisma.expenseRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: new Date(utcDayString(-1)),
        description: "Typed by hand",
        amount: 500,
        source: "MANUAL_ENTRY",
      },
    });
    const detail = await getExpenseRecord(ctx.user.id, record.id);
    expect(detail.origin).toBeNull();
  });

  it("does not leak another owner's record", async () => {
    const other = await makeOwnerWithProfile();
    const { records } = await confirmSplitReceipt();
    await expect(getExpenseRecord(other.user.id, records[0]!.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("confirm", () => {
  it("creates an expense record tagged RECEIPT_SCAN and linked to the scan", async () => {
    const scan = await upload();
    const [record] = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Rice and cooking oil",
      vendor: "ABC Sari-Sari Store",
      amount: 1400,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1400 }],
    });

    expect(record.source).toBe("RECEIPT_SCAN");
    expect(record.receiptScanId).toBe(scan.id);
    expect(record.amount).toBe(1400);
    expect(record.description).toBe("Rice and cooking oil");
  });

  it("marks the scan Confirmed", async () => {
    const scan = await upload();
    await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Rice",
      amount: 1400,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1400 }],
    });
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.confirmationStatus).toBe("Confirmed");
  });

  it("lets the owner correct the OCR values before saving", async () => {
    // The extracted amount was 1400; the owner overrides it to 1220. The saved
    // record must reflect what the owner confirmed, not what OCR guessed.
    const scan = await upload();
    const [record] = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-2),
      description: "Rice only",
      amount: 1220,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1220 }],
    });
    expect(record.amount).toBe(1220);
    expect(scan.extractedAmount).toBe(1400);
  });

  it("refuses a second confirmation of the same scan", async () => {
    const scan = await upload();
    const input = {
      date: utcDayString(-1),
      description: "Rice",
      amount: 1400,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1400 }],
    };
    await confirmReceipt(ctx.user.id, scan.id, input);
    await expect(confirmReceipt(ctx.user.id, scan.id, input)).rejects.toMatchObject({ status: 400 });

    // Exactly one record, so a double submit can't duplicate the expense.
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(1);
  });

  it("applies the large-expense rule to a confirmed receipt", async () => {
    const scan = await upload();
    const [record] = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Bulk delivery from receipt",
      amount: 20000,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 20000 }], // over 25% of 60,000
    });
    expect(record.largeExpenseFlag).toBe(true);
    expect(record.reviewStatus).toBe("Needs Review");
  });

  it("applies duplicate detection to a confirmed receipt", async () => {
    const day = utcDayString(-1);
    const first = await upload();
    await confirmReceipt(ctx.user.id, first.id, {
      date: day,
      description: "Rice",
      amount: 1400,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1400 }],
    });

    const second = await upload();
    const input = {
      date: day,
      description: "Rice",
      amount: 1400,
      splits: [{ categoryId: ctx.categories.Inventory!, amount: 1400 }],
    };
    const review = await confirmReceipt(ctx.user.id, second.id, input).then(
      () => null,
      (error: unknown) => error as {
        status: number;
        code: string;
        responseDetails: { candidateSetHash: string };
      },
    );
    expect(review).toMatchObject({ status: 409, code: "DUPLICATE_REVIEW_REQUIRED" });

    const [dup] = await confirmReceipt(ctx.user.id, second.id, {
      ...input,
      duplicateDecision: {
        action: "SAVE_ANYWAY",
        candidateSetHash: review!.responseDetails.candidateSetHash,
      },
    });
    expect(dup.duplicateStatus).toBe("Flagged");
  });

  /*
   * A receipt covering more than one kind of spending.
   *
   * Before ExpenseRecord.receiptScanId stopped being @unique this was simply
   * not expressible: the whole total had to be filed under one category, so
   * every category-based figure downstream — the Dashboard breakdown, the
   * category trends, the "what did I spend most on" answer — was wrong by
   * construction for any mixed receipt.
   */
  it("splits one receipt into a record per category", async () => {
    const scan = await upload();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Hardware run",
      amount: 2000,
      splits: [
        { categoryId: ctx.categories.Inventory!, amount: 1200 },
        { categoryId: ctx.categories.Utilities!, amount: 800 },
      ],
    });

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.amount)).toEqual([1200, 800]);
    expect(records.map((r) => r.categoryId)).toEqual([ctx.categories.Inventory, ctx.categories.Utilities]);
    // Both still trace back to the one receipt they came from.
    expect(records.every((r) => r.receiptScanId === scan.id)).toBe(true);
    expect(records.every((r) => r.source === "RECEIPT_SCAN")).toBe(true);

    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.confirmationStatus).toBe("Confirmed");
  });

  it("carries a per-split description when one is given, and the receipt's otherwise", async () => {
    const scan = await upload();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Hardware run",
      amount: 2000,
      splits: [
        { categoryId: ctx.categories.Inventory!, amount: 1200, description: "Rice, oil, sugar" },
        { categoryId: ctx.categories.Utilities!, amount: 800 },
      ],
    });
    expect(records[0]!.description).toBe("Rice, oil, sugar");
    expect(records[1]!.description).toBe("Hardware run");
  });

  it("refuses a split that does not add up to the receipt total, saving nothing", async () => {
    const scan = await upload();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Hardware run",
        amount: 2000,
        splits: [
          { categoryId: ctx.categories.Inventory!, amount: 1200 },
          { categoryId: ctx.categories.Utilities!, amount: 700 }, // 100 short
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });

    // Nothing was written, and the scan stays confirmable.
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.confirmationStatus).toBe("Pending");
  });

  it("refuses a split that overshoots the receipt total", async () => {
    const scan = await upload();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: utcDayString(-1),
        description: "Hardware run",
        amount: 2000,
        splits: [
          { categoryId: ctx.categories.Inventory!, amount: 1200 },
          { categoryId: ctx.categories.Utilities!, amount: 900 }, // 100 over
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  /**
   * Centavos that don't survive a round trip through binary floating point.
   * 1200.10 + 800.20 === 2000.3000000000002, so a naive === would reject a
   * split the owner had got exactly right.
   */
  it("accepts a split whose parts only sum exactly in centavos", async () => {
    const scan = await upload();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Hardware run",
      amount: 2000.3,
      splits: [
        { categoryId: ctx.categories.Inventory!, amount: 1200.1 },
        { categoryId: ctx.categories.Utilities!, amount: 800.2 },
      ],
    });
    expect(records).toHaveLength(2);
  });

  it("applies the large-expense rule per split, not to the receipt total", async () => {
    // 20,000 would be flagged; neither half of it is.
    const scan = await upload();
    const records = await confirmReceipt(ctx.user.id, scan.id, {
      date: utcDayString(-1),
      description: "Big mixed receipt",
      amount: 20000,
      splits: [
        { categoryId: ctx.categories.Inventory!, amount: 10000 },
        { categoryId: ctx.categories.Utilities!, amount: 10000 },
      ],
    });
    expect(records.map((r) => r.largeExpenseFlag)).toEqual([false, false]);
  });

  it("returns 404 for a scan belonging to another owner", async () => {
    const scan = await upload();
    const other = await makeOwnerWithProfile();
    await expect(
      confirmReceipt(other.user.id, scan.id, {
                date: utcDayString(-1),
        description: "Hijack attempt",
        amount: 100,
        splits: [{ categoryId: other.categories.Inventory!, amount: 100 }],
      })
    ).rejects.toMatchObject({ status: 404 });

    // The victim's scan is untouched and no record was created anywhere.
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.confirmationStatus).toBe("Pending");
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("returns 404 for a scan that does not exist", async () => {
    await expect(
      confirmReceipt(ctx.user.id, 999999, {
                date: utcDayString(-1),
        description: "Nope",
        amount: 100,
        splits: [{ categoryId: ctx.categories.Inventory!, amount: 100 }],
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
