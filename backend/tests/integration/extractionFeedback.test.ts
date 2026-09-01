import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same mocking rules as receiptScan.test.ts, and for the same reasons: storage
// is external, and running real OCR over Buffer.from("fake-image-bytes") fails.
// What this suite asks is whether the owner's review is RECORDED faithfully,
// not whether tesseract reads well — that is the corpus harness's job.
vi.mock("../../src/services/storage.service", () => ({
  uploadReceiptImage: vi.fn(async () => "1/mock-receipt.jpg"),
  uploadCsvFile: vi.fn(async () => "1/mock.csv"),
  signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed-receipt.jpg"),
  deleteReceiptImage: vi.fn(async () => true),
}));

const { extractTextMock, confidenceRef, linesRef } = vi.hoisted(() => ({
  extractTextMock: vi.fn(),
  confidenceRef: { value: 95 },
  // Per-word confidences. Unlike receiptScan.test.ts this suite DOES assert on
  // confidence, because whether a low score predicts a correction is the
  // question the whole feedback loop exists to answer.
  linesRef: { value: [] as { text: string; confidence: number; words: { text: string; confidence: number }[] }[] },
}));
vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractText: extractTextMock,
    extractReceipt: async (...args: unknown[]) => ({
      text: await extractTextMock(...args),
      confidence: confidenceRef.value,
      lines: linesRef.value,
    }),
  };
});

const { categoriseMock } = vi.hoisted(() => ({ categoriseMock: vi.fn() }));
vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, categoriseReceiptItems: categoriseMock };
});

const { visionMock } = vi.hoisted(() => ({ visionMock: vi.fn() }));
vi.mock("../../src/services/visionOcr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/visionOcr.service")>();
  return { ...actual, extractReceiptWithVision: visionMock };
});

import { prisma } from "../../src/config/prisma";
import { confirmReceipt, deleteScanItem, getScan, uploadAndScan } from "../../src/services/receiptScan.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, waitForScanProcessing } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

const RECEIPT_TEXT = [
  "ABC SARI-SARI STORE",
  "Date: 2026-07-20",
  "Rice 25kg          1220.00",
  "Cooking oil          180.00",
  "TOTAL             1400.00",
].join("\n");

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  extractTextMock.mockReset();
  categoriseMock.mockReset();
  categoriseMock.mockResolvedValue([]);
  visionMock.mockReset();
  visionMock.mockResolvedValue(null);
  confidenceRef.value = 95;
  linesRef.value = [];
  extractTextMock.mockResolvedValue(RECEIPT_TEXT);
});

afterAll(disconnectDb);

async function upload() {
  const created = await uploadAndScan(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    pages: [{ buffer: Buffer.from("fake-image-bytes"), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
  });
  await waitForScanProcessing(created.id);
  return getScan(ctx.user.id, created.id);
}

function corrections(field?: string) {
  return prisma.receiptFieldCorrection.findMany({
    where: field ? { field } : {},
    orderBy: { id: "asc" },
  });
}

/** The itemised confirmation the web and mobile confirm screens both send. */
async function confirmAsRead(scanId: number, items: { id: number }[], overrides: Record<string, unknown> = {}) {
  return confirmReceipt(ctx.user.id, scanId, {
    date: "2026-07-20",
    description: "Purchase from ABC SARI-SARI STORE",
    vendor: "ABC SARI-SARI STORE",
    amount: 1400,
    itemAssignments: items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory! })),
    ...overrides,
  });
}

describe("recording a confirmation", () => {
  /**
   * The rule the whole feature rests on. Logging only the edits would record a
   * numerator with no denominator, and would lose the low-confidence-but-
   * correct case entirely — nothing was edited to record it by.
   */
  it("records a row for every reviewed field, not only the corrected ones", async () => {
    // The categoriser agrees with where the owner files these, so this receipt
    // is confirmed with nothing changed at all — which is precisely the review
    // that would leave no trace if only edits were logged.
    categoriseMock.mockResolvedValue([
      { index: 0, match: "Inventory", suggestNew: null },
      { index: 1, match: "Inventory", suggestNew: null },
    ]);
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items);

    const rows = await corrections();
    expect(rows.every((r) => r.receiptScanId === scan.id)).toBe(true);

    // date, vendor, amount + one per line item, all left alone.
    expect(rows.filter((r) => r.field === "date")).toHaveLength(1);
    expect(rows.filter((r) => r.field === "vendor")).toHaveLength(1);
    expect(rows.filter((r) => r.field === "amount")).toHaveLength(1);
    expect(rows.filter((r) => r.field === "itemCategory")).toHaveLength(2);
    expect(rows.every((r) => r.wasEdited === false)).toBe(true);
  });

  it("marks the fields the owner actually changed", async () => {
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items, {
      vendor: "Mercado Fresh",
      date: "2026-07-19",
      // The owner read a higher total off the receipt than OCR did. The extra
      // 100 has to be accounted for or the confirmation is refused, which is
      // the arithmetic rule this feature does not get to opt out of.
      amount: 1500,
      reconciliation: { mode: "proportional" },
    });

    const byField = new Map((await corrections()).map((r) => [r.field, r]));
    expect(byField.get("vendor")).toMatchObject({
      wasEdited: true,
      originalValue: "ABC SARI-SARI STORE",
      finalValue: "Mercado Fresh",
    });
    expect(byField.get("date")).toMatchObject({ wasEdited: true, originalValue: "2026-07-20", finalValue: "2026-07-19" });
    expect(byField.get("amount")).toMatchObject({ wasEdited: true, originalValue: "1400.00", finalValue: "1500.00" });
  });

  /**
   * OCR noise is not a correction. `MERCAD0` for `MERCADO` is the classic
   * thermal-print misread, and the shared matcher in lib/fieldComparison — the
   * same one the corpus harness scores with — treats it as a match. Counting
   * it as an owner correction would inflate the vendor error rate with cases
   * nobody actually considers wrong.
   */
  it("does not count light OCR noise in a vendor name as a correction", async () => {
    // A trailing E read as a 3 — the owner retypes the name, but nothing about
    // the extraction was meaningfully wrong.
    extractTextMock.mockResolvedValue(RECEIPT_TEXT.replace("ABC SARI-SARI STORE", "ABC SARI-SARI STOR3"));
    const scan = await upload();
    expect(scan.extractedVendor).toBe("ABC SARI-SARI STOR3");

    await confirmAsRead(scan.id, scan.items, { vendor: "ABC SARI-SARI STORE" });

    const row = (await corrections("vendor"))[0]!;
    expect(row.wasEdited).toBe(false);
    // Both readings are kept even so, so a report can still show what the
    // owner retyped and why the matcher forgave it.
    expect(row.originalValue).toBe("ABC SARI-SARI STOR3");
    expect(row.finalValue).toBe("ABC SARI-SARI STORE");
  });

  it("skips a field that was neither read nor entered, rather than scoring it correct", async () => {
    /*
     * A receipt whose header never made it into the photo has no vendor to get
     * right. Recording agreement about an absence would inflate accuracy with
     * rows that measure nothing.
     *
     * The null is set on the row rather than coaxed out of the parser, which
     * always falls back to SOME line. What is under test here is the recording
     * rule, and building the state directly says so instead of depending on a
     * parser fixture that a future parser change would quietly invalidate.
     */
    const scan = await upload();
    await prisma.receiptScan.update({ where: { id: scan.id }, data: { extractedVendor: null } });

    await confirmReceipt(ctx.user.id, scan.id, {
      date: "2026-07-20",
      description: "Purchase",
      amount: 1400,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory! })),
    });

    expect(await corrections("vendor")).toHaveLength(0);
  });
});

describe("the categoriser's original pick", () => {
  /**
   * THE REGRESSION THIS SUITE EXISTS FOR.
   *
   * confirmReceipt overwrites ReceiptScanItem.categoryId with the owner's
   * choice as it writes the expense records. Anything reading the item
   * afterwards compares the owner's choice with itself and concludes the
   * categoriser is never wrong. The snapshot has to be taken before that
   * write, and this is the test that fails if it ever moves after it.
   */
  it("is recorded even though confirmation overwrites it on the item", async () => {
    categoriseMock.mockResolvedValue([
      { index: 0, match: "Utilities", suggestNew: null },
      { index: 1, match: "Utilities", suggestNew: null },
    ]);
    const scan = await upload();
    expect(scan.items[0]!.categoryId).toBe(ctx.categories.Utilities);

    // The owner disagrees: both lines are Inventory.
    await confirmAsRead(scan.id, scan.items);

    // The item row now says Inventory — the AI's answer is gone from it.
    const item = await prisma.receiptScanItem.findFirstOrThrow({ where: { id: scan.items[0]!.id } });
    expect(item.categoryId).toBe(ctx.categories.Inventory);

    // ...but the disagreement was captured before that happened.
    const rows = await corrections("itemCategory");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      wasEdited: true,
      originalValue: "Utilities",
      finalValue: "Inventory",
      itemName: "Rice 25kg",
      source: "ai-category",
    });
  });

  it("records agreement when the owner keeps the suggested category", async () => {
    categoriseMock.mockResolvedValue([
      { index: 0, match: "Inventory", suggestNew: null },
      { index: 1, match: "Inventory", suggestNew: null },
    ]);
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items);

    const rows = await corrections("itemCategory");
    expect(rows.every((r) => r.wasEdited === false)).toBe(true);
    expect(rows.every((r) => r.originalValue === "Inventory")).toBe(true);
  });

  /**
   * A category correction is not evidence about OCR's confidence in the
   * amount. Borrowing that column would put a real-looking number into the
   * calibration report that no model ever produced for this decision.
   */
  it("carries no confidence, because the categoriser does not report one", async () => {
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items);
    expect((await corrections("itemCategory")).every((r) => r.confidence === null)).toBe(true);
  });
});

describe("lines that were never extracted", () => {
  it("records a line the owner had to type in as a miss", async () => {
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items, {
      amount: 1450,
      additionalItems: [{ name: "Softdrinks", amount: 50, categoryId: ctx.categories.Inventory! }],
    });

    const rows = await corrections("itemPresence");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Nothing was read — that absence is the finding.
      originalValue: null,
      finalValue: "Softdrinks",
      itemName: "Softdrinks",
      wasEdited: true,
    });
  });

  /**
   * Schema note 12: a row a human supplied must never be counted as something
   * FinSight extracted. An owner-added line has no AI pick to disagree with,
   * so scoring it as a correct categorisation would quietly flatter the
   * categoriser with rows it never saw.
   */
  it("does not score an owner-added line as a correct categorisation", async () => {
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items, {
      amount: 1450,
      additionalItems: [{ name: "Softdrinks", amount: 50, categoryId: ctx.categories.Inventory! }],
    });

    const rows = await corrections("itemCategory");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.itemName)).toEqual(["Rice 25kg", "Cooking oil"]);
  });

  it("records a deleted line as a false positive, before the row disappears", async () => {
    const scan = await upload();
    await deleteScanItem(ctx.user.id, scan.id, scan.items[1]!.id);

    const rows = await corrections("itemPresence");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      originalValue: "Cooking oil",
      // Nothing survives on the owner's side — that is the finding.
      finalValue: null,
      itemName: "Cooking oil",
      wasEdited: true,
      source: "ocr",
    });
  });

  it("does not count an owner undoing their own typing as an OCR mistake", async () => {
    const scan = await upload();
    await confirmReceipt(ctx.user.id, scan.id, {
      date: "2026-07-20",
      description: "Purchase",
      amount: 1450,
      itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory! })),
      additionalItems: [{ name: "Softdrinks", amount: 50, categoryId: ctx.categories.Inventory! }],
    });

    // Re-scan a fresh receipt and remove a line the owner added themselves.
    const second = await upload();
    const added = await prisma.receiptScanItem.create({
      data: { receiptScanId: second.id, lineNumber: 9, name: "Typed by hand", amount: 10, addedByOwner: true },
    });
    await deleteScanItem(ctx.user.id, second.id, added.id);

    const rows = await corrections("itemPresence");
    expect(rows.map((r) => r.itemName)).toEqual(["Softdrinks"]);
  });
});

describe("what must not be recorded", () => {
  /**
   * A refused confirmation is not a judgement on the extraction. Recording
   * feedback before the write would file accuracy data for reviews the owner
   * never completed, and would count the same receipt again on every retry.
   */
  it("records nothing when the confirmation is rejected", async () => {
    const scan = await upload();
    await expect(
      confirmReceipt(ctx.user.id, scan.id, {
        date: "2026-07-20",
        description: "Purchase",
        // Does not reconcile against the 1400 of items, and no plan for the gap.
        amount: 9999,
        itemAssignments: scan.items.map((i) => ({ itemId: i.id, categoryId: ctx.categories.Inventory! })),
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await corrections()).toHaveLength(0);
  });

  it("does not record the same scan twice when a confirmation is retried", async () => {
    const scan = await upload();
    await expect(
      confirmAsRead(scan.id, scan.items, { amount: 9999 }),
    ).rejects.toMatchObject({ status: 400 });

    await confirmAsRead(scan.id, scan.items);

    expect(await corrections("amount")).toHaveLength(1);
  });

  /**
   * The owner's receipt is already confirmed by the time feedback is written,
   * and it must stay that way. An analytics failure that cost someone the
   * review they had just finished would be an indefensible trade.
   */
  it("still confirms the receipt if recording the feedback fails", async () => {
    const scan = await upload();

    /*
     * Swapped and restored by hand rather than with vi.spyOn.
     *
     * spyOn's mockRestore does not put a Prisma delegate method back the way
     * it found it, so the stub leaked into every test that ran afterwards and
     * broke them — the failure looked like a bug in the feature rather than in
     * this test. `finally` is what guarantees the swap is undone even when the
     * assertions below throw.
     */
    const original = prisma.receiptFieldCorrection.createMany;
    prisma.receiptFieldCorrection.createMany = (() =>
      Promise.reject(new Error("boom"))) as typeof original;

    try {
      const records = await confirmAsRead(scan.id, scan.items);

      expect(records).toHaveLength(1);
      expect((await getScan(ctx.user.id, scan.id)).confirmationStatus).toBe("Confirmed");
    } finally {
      prisma.receiptFieldCorrection.createMany = original;
    }

    expect(await corrections()).toHaveLength(0);
  });
});

describe("per-field confidence", () => {
  /**
   * The whole-scan figure cannot say whether confidence predicts a wrong
   * answer for the VENDOR specifically — one number per scan says nothing
   * about which field on it was doubtful.
   */
  it("is carried onto the rows that have one", async () => {
    // confidenceForValue looks for the value among the WORDS of each line, so
    // a line without them carries no confidence for anything on it.
    linesRef.value = [
      {
        text: "ABC SARI-SARI STORE",
        confidence: 42,
        words: [
          { text: "ABC", confidence: 42 },
          { text: "SARI-SARI", confidence: 42 },
          { text: "STORE", confidence: 42 },
        ],
      },
      {
        text: "TOTAL             1400.00",
        confidence: 88,
        words: [
          { text: "TOTAL", confidence: 88 },
          { text: "1400.00", confidence: 88 },
        ],
      },
    ];
    const scan = await upload();
    await confirmAsRead(scan.id, scan.items);

    const byField = new Map((await corrections()).map((r) => [r.field, r]));
    expect(byField.get("vendor")!.confidence).toBe(42);
    expect(byField.get("amount")!.confidence).toBe(88);
  });

  it("stays null on a vision-assisted read, where it would describe unread text", async () => {
    extractTextMock.mockResolvedValue("~~~ unreadable ~~~");
    // The extraction envelope: an ACCEPTED reading, as opposed to null
    // ("provider never reached") or a rejectReason ("answered, refused").
    visionMock.mockResolvedValue({
      receipt: {
        date: "2026-07-20",
        vendor: "ABC SARI-SARI STORE",
        amount: 1400,
        warnings: [],
        items: [{ name: "Rice 25kg", quantity: null, amount: 1400, pageNumber: null, sourceText: null }],
      },
      rejectReason: null,
    });

    const scan = await upload();
    await confirmAsRead(scan.id, scan.items);

    const rows = await corrections();
    expect(rows.every((r) => r.source === "vision" || r.source === "ai-category")).toBe(true);
    expect(rows.filter((r) => r.field === "vendor")[0]!.confidence).toBeNull();
  });
});
