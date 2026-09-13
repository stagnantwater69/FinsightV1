import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Same mocking posture as receiptScan.test.ts: OCR text, the categoriser, the
 * legacy vision and verifier entry points are stubbed as tripwires so these
 * tests prove the worker records local evidence without bypassing the new
 * provider gate. Storage is stubbed for the same reason.
 */
/*
 * extractReceipt is DERIVED from the text mock rather than being mocked
 * directly, matching receiptScan.test.ts: the service reads through it (text
 * plus per-word confidences), and mocking it directly with the wrong envelope
 * makes the worker throw and the scan never reach a terminal state. Parsing
 * itself stays real — these tests assert on what the real parser records.
 */
const { extractTextMock, confidenceRef } = vi.hoisted(() => ({
  extractTextMock: vi.fn(),
  confidenceRef: { value: 95 },
}));
vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
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

const { categoriseMock } = vi.hoisted(() => ({ categoriseMock: vi.fn() }));
vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, categoriseReceiptItems: categoriseMock };
});

const { visionMock, verifierMock } = vi.hoisted(() => ({ visionMock: vi.fn(), verifierMock: vi.fn() }));
vi.mock("../../src/services/visionOcr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/visionOcr.service")>();
  return { ...actual, extractReceiptWithVision: visionMock, verifyVisionReceipt: verifierMock };
});

vi.mock("../../src/lib/imageQuality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/imageQuality")>();
  return {
    ...actual,
    assessImageQuality: vi.fn(async () => ({
      sharpness: 1_000,
      brightness: 180,
      tooBlurredToTrust: false,
      width: 1_200,
      height: 2_000,
      tooSmallToRead: false,
    })),
  };
});

vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    uploadReceiptImage: vi.fn(async () => "test/mock-receipt.jpg"),
    uploadCsvFile: vi.fn(async () => "test/mock-csv.csv"),
    signedReceiptImageUrl: vi.fn(async () => "https://example.test/signed"),
    removeObject: vi.fn(async () => true),
    deleteReceiptImage: vi.fn(async () => true),
    inspectReceiptImage: vi.fn(async () => ({ sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn(async () => storedBytes),
  };
});

import { prisma } from "../../src/config/prisma";
import { getScan, uploadAndScan } from "../../src/services/receiptScan.service";
import type { VisionReceipt } from "../../src/services/visionOcr.service";
import { WARNING_GUIDANCE } from "../../src/lib/receiptWarnings";
import { disconnectDb, makeOwnerWithProfile, resetDb, runReceiptWorkerAndWait } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

const CLEAN_RECEIPT = [
  "ABC SARI-SARI STORE",
  "123 Apas Road, Cebu City",
  "Date: 2026-07-20",
  "Rice 25kg          1220.00",
  "Cooking oil         180.00",
  "TOTAL              1400.00",
  "Thank you!",
].join("\n");

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

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  extractTextMock.mockReset();
  confidenceRef.value = 95;
  extractTextMock.mockResolvedValue(CLEAN_RECEIPT);
  categoriseMock.mockReset();
  categoriseMock.mockResolvedValue([]);
  visionMock.mockReset();
  visionMock.mockResolvedValue(null);
  verifierMock.mockReset();
  verifierMock.mockResolvedValue(null);
});

afterAll(disconnectDb);

async function upload() {
  const scan = await uploadAndScan(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    pages: [{ buffer: Buffer.from("fake-image-bytes"), mimetype: "image/jpeg", originalname: "receipt.jpg" }],
  });
  await runReceiptWorkerAndWait(scan.id);
  return getScan(ctx.user.id, scan.id);
}

describe("extractor versioning", () => {
  it("records which code read a deterministic scan", async () => {
    const scan = await upload();
    const row = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan!.id } });
    const versions = row.extractorVersions as Record<string, unknown>;

    // Parser and preprocessing always apply; the vision fields stay null
    // because the model was never invoked for a receipt OCR read cleanly.
    expect(versions.parserVersion).toBeTruthy();
    expect(versions.preprocessVersion).toBeTruthy();
    expect(versions.provider ?? null).toBeNull();
    expect(versions.model ?? null).toBeNull();
  });

  it("records the local trigger and closed provider gate without claiming a provider read", async () => {
    confidenceRef.value = 40;
    extractTextMock.mockResolvedValue("~~~ unreadable ~~~");
    visionMock.mockResolvedValue(
      visionReply({ date: "2026-07-20", vendor: "ABC STORE", amount: 1400, items: [{ name: "Rice 25kg", amount: 1400 }] }),
    );

    const scan = await upload();
    const row = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan!.id } });
    const versions = row.extractorVersions as Record<string, unknown>;

    expect(versions.provider).toBeNull();
    expect(versions.model).toBeNull();
    expect(versions.promptVersion).toBeTruthy();
    expect(versions.schemaVersion).toBeTruthy();
    expect(versions.visionTrigger).toBeTruthy();
    expect(versions.visionLatencyMs).toBeNull();
    expect(versions.providerGateCode).toBe("PROVIDER_NOT_REQUESTED");
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("does not record an un-gated legacy provider answer or its body-derived reason", async () => {
    confidenceRef.value = 40;
    extractTextMock.mockResolvedValue("~~~ unreadable ~~~");
    visionMock.mockResolvedValue({ receipt: null, rejectReason: "schema" });

    const scan = await upload();
    const row = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan!.id } });
    const versions = row.extractorVersions as Record<string, unknown>;

    expect(versions.visionRejectReason).toBeNull();
    expect(versions.providerGateCode).toBe("PROVIDER_NOT_REQUESTED");
    expect(scan!.visionAssisted).toBe(false);
    expect(visionMock).not.toHaveBeenCalled();
  });
});

describe("per-field evidence", () => {
  it("says which page and which printed line each field came from", async () => {
    const scan = await upload();
    const evidence = scan!.fieldEvidence as Record<
      string,
      { pageNumber: number | null; sourceText: string | null; source: string | null }
    > | null;

    expect(evidence).not.toBeNull();
    expect(evidence!.amount?.source).toBe("ocr");
    expect(evidence!.amount?.pageNumber).toBe(1);
    // The evidence must be text actually on the receipt, not a restatement
    // of the parsed value.
    expect(evidence!.amount?.sourceText).toContain("1400");
    expect(evidence!.vendor?.sourceText?.toUpperCase()).toContain("ABC");
  });

  it("does not manufacture field evidence from an un-gated vision reply", async () => {
    confidenceRef.value = 40;
    extractTextMock.mockResolvedValue("~~~ unreadable ~~~");
    visionMock.mockResolvedValue(
      visionReply({
        date: "2026-07-20",
        vendor: "ABC STORE",
        amount: 1400,
        items: [{ name: "Rice 25kg", amount: 1400, pageNumber: 1, sourceText: "Rice 25kg 1400.00" }],
      }),
    );

    const scan = await upload();
    const evidence = scan!.fieldEvidence as Record<string, { source: string | null }> | null;
    expect(evidence?.amount).toBeUndefined();
    expect(visionMock).not.toHaveBeenCalled();
  });
});

describe("machine-readable warnings", () => {
  it("carries no warnings for a clean, reconciling read", async () => {
    const scan = await upload();
    expect(scan!.warnings).toEqual([]);
  });

  it("flags an unexplained gap between the items and the printed total", async () => {
    confidenceRef.value = 95;
    extractTextMock.mockResolvedValue(["ABC STORE", "Date: 2026-07-20", "Rice 25kg  100.00", "TOTAL  980.00"].join("\n"));

    const scan = await upload();
    const codes = scan!.warnings.map((w) => w.code);
    expect(codes).toContain("UNEXPLAINED_GAP");
  });

  it("flags an ambiguous numeric date and keeps the visible text as evidence", async () => {
    confidenceRef.value = 95;
    extractTextMock.mockResolvedValue(["ABC STORE", "Date: 03/09/2026", "Rice 25kg 1400.00", "TOTAL 1400.00"].join("\n"));

    const scan = await upload();
    const ambiguous = scan!.warnings.find((w) => w.code === "AMBIGUOUS_DATE");
    expect(ambiguous).toBeDefined();
    expect(ambiguous!.detail).toContain("03/09/2026");
    // The documented Philippine DD/MM reading still wins — the warning says it
    // was a convention call, it does not change the answer.
    expect(scan!.extractedDate?.toISOString().slice(0, 10)).toBe("2026-09-03");
  });

  it("does not flag an unambiguous date", async () => {
    const scan = await upload();
    expect(scan!.warnings.map((w) => w.code)).not.toContain("AMBIGUOUS_DATE");
  });

  it("gives every warning one actionable guidance string from the server", async () => {
    confidenceRef.value = 95;
    extractTextMock.mockResolvedValue(["ABC STORE", "Date: 2026-07-20", "Rice 25kg  100.00", "TOTAL  980.00"].join("\n"));

    const scan = await upload();
    expect(scan!.warnings.length).toBeGreaterThan(0);
    for (const warning of scan!.warnings) {
      expect(warning.guidance).toBe(WARNING_GUIDANCE[warning.code]);
      expect(typeof warning.guidance).toBe("string");
    }
  });
});

describe("legacy verifier isolation", () => {
  /** OCR that reads no total, so a model-supplied one is unchecked → high risk. */
  function noTotalRead() {
    confidenceRef.value = 95;
    extractTextMock.mockResolvedValue(["ABC STORE", "Date: 2026-07-20", "some unreadable lines"].join("\n"));
    visionMock.mockResolvedValue(visionReply({ amount: 1400, items: [{ name: "Rice 25kg", amount: 1400 }] }));
  }

  it("does not invoke the legacy verifier or accept its reply outside the provider gate", async () => {
    noTotalRead();
    verifierMock.mockResolvedValue({ accept: true, rejectedFields: [] });

    const scan = await upload();
    expect(verifierMock).not.toHaveBeenCalled();
    expect(scan!.extractedAmount).toBeNull();
    const row = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan!.id } });
    expect((row.extractorVersions as Record<string, unknown>).verifier).toBeNull();
  });

  it("keeps the deterministic result when an un-gated verifier mock would reject", async () => {
    noTotalRead();
    verifierMock.mockResolvedValue({ accept: false, rejectedFields: ["amount"] });

    const scan = await upload();
    expect(scan!.extractedAmount).toBeNull();
    expect(scan!.warnings.map((warning) => warning.code)).not.toContain("VISION_INTERPRETED");
    const row = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan!.id } });
    expect((row.extractorVersions as Record<string, unknown>).verifier).toBeNull();
    expect(verifierMock).not.toHaveBeenCalled();
  });

  it("does not verify an un-gated legacy reply when OCR already read the total", async () => {
    confidenceRef.value = 95;
    extractTextMock.mockResolvedValue(["ABC STORE", "Date: 2026-07-20", "TOTAL 1400.00"].join("\n"));
    visionMock.mockResolvedValue(visionReply({ amount: 1400, items: [{ name: "Rice 25kg", amount: 1400 }] }));

    await upload();
    expect(verifierMock).not.toHaveBeenCalled();
  });

  it("keeps a missing local total reviewable when no gated rescue runs", async () => {
    noTotalRead();
    verifierMock.mockResolvedValue(null); // no key / provider down

    const scan = await upload();
    expect(scan!.extractedAmount).toBeNull();
    expect(verifierMock).not.toHaveBeenCalled();
  });

  it("never asks the legacy verifier directly", async () => {
    noTotalRead();
    verifierMock.mockResolvedValue({ accept: true, rejectedFields: [] });
    await upload();
    expect(verifierMock).not.toHaveBeenCalled();
  });
});
