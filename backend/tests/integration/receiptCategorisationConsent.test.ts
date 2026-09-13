import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    inspectReceiptImage: vi.fn(async () => ({ sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn(async () => storedBytes),
  };
});

const { ocrText } = vi.hoisted(() => ({
  ocrText: { value: "LOCAL STORE\nRice 100.00\nTOTAL 100.00" },
}));

vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractReceipt: vi.fn(async () => ({
      text: ocrText.value,
      confidence: 95,
      lines: [],
    })),
  };
});

import { prisma } from "../../src/config/prisma";
import { runReceiptWorkerOnce } from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("GOOGLE_GEMINI_API_KEY", "generic-ai-key");
  vi.stubEnv("OPENROUTER_API_KEY", "generic-fallback-key");
  vi.stubEnv("RECEIPT_PROVIDER_DISPATCH_ENABLED", "false");
  vi.stubEnv("RECEIPT_PROVIDER_KILL_SWITCH", "true");
  ocrText.value = "LOCAL STORE\nRice 100.00\nTOTAL 100.00";
  await resetDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await disconnectDb();
});

describe("receipt categorisation external-processing boundary", () => {
  it("sends no receipt-derived text to general AI providers without current consent and a reservation", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/private-receipt.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        pages: { create: [{ pageNumber: 1, imageFile: `${owner.profile.id}/private-receipt.jpg` }] },
      },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("An external categorisation request must not be attempted");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.externalProcessingConsent.count()).toBe(0);
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored).toMatchObject({
      processingStatus: "Complete",
      extractedVendor: "LOCAL STORE",
    });
    expect(Number(stored.extractedAmount)).toBe(100);
  });

  it("reuses the owner's confirmed exact item and vendor choice locally without a provider call", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
    await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/confirmed.jpg`,
        processingStatus: "Complete",
        confirmationStatus: "Confirmed",
        extractedVendor: "LOCAL STORE",
        items: {
          create: [{
            lineNumber: 1,
            name: "  RICE   25KG ",
            amount: 100,
            categoryId: owner.categories.Inventory,
          }],
        },
      },
    });
    const queued = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/queued.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        pages: { create: [{ pageNumber: 1, imageFile: `${owner.profile.id}/queued.jpg` }] },
      },
    });
    ocrText.value = "LOCAL STORE\nRice 25kg 100.00\nTOTAL 100.00";
    const fetchMock = vi.fn(async () => {
      throw new Error("Local receipt categorisation must not dispatch");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.receiptScanItem.findFirst({ where: { receiptScanId: queued.id } })).toMatchObject({
      name: "Rice 25kg",
      categoryId: owner.categories.Inventory,
    });
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
  });
});
