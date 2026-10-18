import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local read's headline fields are visible while the provider is still
 * reading, and only then. They are display-only: confirmation waits for the
 * finished read.
 */

vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    inspectReceiptImage: vi.fn(async () => ({ sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn(async () => storedBytes),
  };
});

const { ocrText } = vi.hoisted(() => ({
  ocrText: { value: "LOCAL STORE\n2026-09-01\nRice 100.00\nTOTAL PHP 100.00" },
}));

vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return { ...actual, extractReceipt: vi.fn(async () => ({ text: ocrText.value, confidence: 95, lines: [] })) };
});

const during = vi.hoisted(() => ({ scanId: 0, userId: 0, seen: null as unknown, extract: async (): Promise<void> => {} }));

vi.mock("../../src/services/receiptScan/providerAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/receiptScan/providerAdapters")>();
  const { successfulOutcome } = await import("../helpers/receiptProviderFixtures");
  return {
    ...actual,
    createGeminiReceiptAdapter: () => ({
      provider: "gemini" as const,
      providerVersion: "gemini-3.5-flash-lite",
      extract: async (request: Parameters<typeof successfulOutcome>[0]) => {
        await during.extract();
        return successfulOutcome(request);
      },
    }),
  };
});

import { prisma } from "../../src/config/prisma";
import { grantReceiptProviderConsent } from "../../src/services/receiptProviderConsent.service";
import { getScan } from "../../src/services/receiptScan/queue";
import { runReceiptWorkerOnce } from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

async function enableProvider(routing: "always" | "rescue") {
  const values: NodeJS.ProcessEnv = {
    RECEIPT_PROVIDER_DISPATCH_ENABLED: "true",
    RECEIPT_PROVIDER_KILL_SWITCH: "false",
    RECEIPT_PROVIDER_DATA_TERMS_APPROVED: "true",
    RECEIPT_PROVIDER: "gemini",
    RECEIPT_PROVIDER_VERSION: "gemini-3.5-flash-lite",
    RECEIPT_PROVIDER_REGION: "global",
    RECEIPT_PROVIDER_RETENTION_HOURS: "0",
    RECEIPT_PROVIDER_ROUTING_CALIBRATED: "true",
    RECEIPT_PROVIDER_CALIBRATION_VERSION: "routing-v1",
    RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "10",
    RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT: "10",
    RECEIPT_PROVIDER_ROUTING: routing,
    GOOGLE_GEMINI_API_KEY: "mocked-provider-key",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  await grantReceiptProviderConsent(owner.user.id, owner.profile.id, {
    provider: "gemini",
    policyVersion: "receipt-provider-policy-v1",
    purpose: "RECEIPT_EXTRACTION",
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    region: "global",
    retentionHours: 0,
    trainingAllowed: false,
  });
}

async function queuedScan() {
  const scan = await prisma.receiptScan.create({
    data: {
      businessProfileId: owner.profile.id,
      imageFile: `${owner.profile.id}/preview.jpg`,
      processingStatus: "Processing",
      confirmationStatus: "Pending",
      pages: { create: [{ pageNumber: 1, imageFile: `${owner.profile.id}/preview.jpg` }] },
    },
  });
  during.scanId = scan.id;
  during.userId = owner.user.id;
  return scan;
}

beforeEach(async () => {
  await resetDb();
  vi.unstubAllEnvs();
  ocrText.value = "LOCAL STORE\n2026-09-01\nRice 100.00\nTOTAL PHP 100.00";
  during.seen = null;
  during.extract = async () => {
    during.seen = (await getScan(during.userId, during.scanId)).localPreview;
  };
  owner = await makeOwnerWithProfile({}, ["Inventory"]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await disconnectDb();
});

describe("receipt local preview", () => {
  it("shows the local read while the provider reads, and clears it once the scan completes", async () => {
    await enableProvider("always");
    const scan = await queuedScan();

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(during.seen).toEqual({ date: "2026-09-01", vendor: "LOCAL STORE", amount: 100 });
    const finished = await getScan(owner.user.id, scan.id);
    expect(finished.processingStatus).toBe("Complete");
    expect(finished.localPreview).toBeNull();
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.extractorVersions).not.toHaveProperty("localPreview");
  });

  it("writes nothing when no provider is called, because the local read is already final", async () => {
    await enableProvider("rescue");
    const scan = await queuedScan();
    const updates = vi.spyOn(prisma.receiptScan, "updateMany");

    expect(await runReceiptWorkerOnce()).toBe(true);

    const previewWrites = updates.mock.calls.filter(([args]) =>
      JSON.stringify((args as { data?: unknown }).data ?? {}).includes("localPreview"));
    expect(previewWrites).toHaveLength(0);
    expect((await getScan(owner.user.id, scan.id)).localPreview).toBeNull();
    updates.mockRestore();
  });

  it("writes nothing when the local read found neither a date nor a total", async () => {
    await enableProvider("always");
    ocrText.value = "~~~ unreadable ~~~";
    await queuedScan();

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(during.seen).toBeNull();
  });

  it("writes no preview from a worker whose lease was taken over during the read", async () => {
    await enableProvider("always");
    const scan = await queuedScan();
    const { extractReceipt } = await import("../../src/services/ocr.service");
    vi.mocked(extractReceipt).mockImplementationOnce(async () => {
      // Another worker reclaims the scan while this one is still reading.
      await prisma.receiptScan.update({ where: { id: scan.id }, data: { processingWorkerId: "another-worker", processingAttemptCount: 9 } });
      return { text: ocrText.value, confidence: 95, lines: [] };
    });

    await runReceiptWorkerOnce();

    expect(during.seen).toBeNull();
    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.extractorVersions ?? {}).not.toHaveProperty("localPreview");
  });

  it("refuses to confirm while the provider is still reading, preview or not", async () => {
    await enableProvider("always");
    const scan = await queuedScan();
    const { confirmReceipt } = await import("../../src/services/receiptScan/reconciliation");
    let refusal: unknown = null;
    during.extract = async () => {
      expect((await getScan(during.userId, during.scanId)).localPreview).not.toBeNull();
      refusal = await confirmReceipt(owner.user.id, scan.id, {
        date: "2026-09-01",
        description: "Purchase from LOCAL STORE",
        amount: 100,
        splits: [{ categoryId: owner.categories.Inventory!, amount: 100 }],
      } as never).then(() => null, (error: unknown) => error);
    };

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(refusal).toMatchObject({ status: 400, message: "This receipt is still being read. Try again in a moment." });
  });
});
