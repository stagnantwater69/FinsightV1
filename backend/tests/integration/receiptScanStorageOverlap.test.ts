import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Storage calls are the slowest thing a scan does after the provider itself:
 * 0.2-1.1 s each, measured from a laptop. These pin that the worker overlaps
 * them instead of making them one after another.
 */

const storage = vi.hoisted(() => ({
  inFlight: { inspect: 0, download: 0 },
  peak: { inspect: 0, download: 0 },
  downloads: [] as string[],
}));

async function slow<T>(kind: "inspect" | "download", value: T): Promise<T> {
  storage.inFlight[kind] += 1;
  storage.peak[kind] = Math.max(storage.peak[kind], storage.inFlight[kind]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  storage.inFlight[kind] -= 1;
  return value;
}

vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    inspectReceiptImage: vi.fn(() => slow("inspect", { sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn((path: string) => {
      storage.downloads.push(path);
      return slow("download", storedBytes);
    }),
  };
});

vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractReceipt: vi.fn(async () => ({ text: "LOCAL STORE\n2026-09-01\nRice 100.00\nTOTAL PHP 100.00", confidence: 95, lines: [] })),
  };
});

const providerDownloadsInFlightAtCall = vi.hoisted(() => ({ value: -1, downloadsBefore: -1 }));
vi.mock("../../src/services/receiptScan/providerAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/receiptScan/providerAdapters")>();
  const { successfulOutcome } = await import("../helpers/receiptProviderFixtures");
  return {
    ...actual,
    createGeminiReceiptAdapter: () => ({
      provider: "gemini" as const,
      providerVersion: "gemini-3.5-flash-lite",
      extract: async (request: Parameters<typeof successfulOutcome>[0]) => {
        providerDownloadsInFlightAtCall.downloadsBefore = storage.downloads.length;
        return successfulOutcome(request);
      },
    }),
  };
});

import { prisma } from "../../src/config/prisma";
import { grantReceiptProviderConsent } from "../../src/services/receiptProviderConsent.service";
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
  // Consent needs the provider configured, so it follows the settings.
  return grantReceiptProviderConsent(owner.user.id, owner.profile.id, {
    provider: "gemini",
    policyVersion: "receipt-provider-policy-v1",
    purpose: "RECEIPT_EXTRACTION",
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    region: "global",
    retentionHours: 0,
    trainingAllowed: false,
  });
}

async function scanWithPages(pages: number, withProcessed: boolean) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId: owner.profile.id,
      imageFile: `${owner.profile.id}/overlap.jpg`,
      processingStatus: "Processing",
      confirmationStatus: "Pending",
      pages: {
        create: Array.from({ length: pages }, (_, index) => ({
          pageNumber: index + 1,
          imageFile: `${owner.profile.id}/page-${index + 1}.jpg`,
          ...(withProcessed ? { processedImageFile: `${owner.profile.id}/page-${index + 1}-processed.jpg` } : {}),
        })),
      },
    },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.unstubAllEnvs();
  storage.inFlight = { inspect: 0, download: 0 };
  storage.peak = { inspect: 0, download: 0 };
  storage.downloads = [];
  providerDownloadsInFlightAtCall.downloadsBefore = -1;
  owner = await makeOwnerWithProfile({}, ["Inventory"]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await disconnectDb();
});

describe("receipt scan storage overlap", () => {
  it("inspects every stored image of a multi-page scan at once", async () => {
    await enableProvider("rescue");
    await scanWithPages(3, true);

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(storage.peak.inspect).toBe(6);
  });

  it("re-downloads every page for the provider under always routing, all at once, before the call", async () => {
    await enableProvider("always");
    const scan = await scanWithPages(3, false);

    expect(await runReceiptWorkerOnce()).toBe(true);

    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(stored.processingStatus).toBe("Complete");
    // Three reads for OCR and three fresh reads for the provider.
    expect(storage.downloads).toHaveLength(6);
    expect(providerDownloadsInFlightAtCall.downloadsBefore).toBe(6);
    expect(storage.peak.download).toBeGreaterThanOrEqual(3);
  });

  it("downloads nothing extra under rescue routing when no provider is called", async () => {
    await enableProvider("rescue");
    await scanWithPages(1, false);

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(storage.downloads).toHaveLength(1);
  });
});
