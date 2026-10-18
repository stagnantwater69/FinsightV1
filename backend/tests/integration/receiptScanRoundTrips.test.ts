import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Database round trips for one receipt scan through the worker, with the
 * slow parts that are not the database taken out: storage, local OCR and the
 * provider all answer instantly here. What is left is the worker's own
 * database work, which a remote database multiplies.
 */

vi.mock("../../src/services/storage.service", async () => {
  const { tinyReceiptJpeg } = await import("../helpers/receiptImageFixtures");
  const storedBytes = tinyReceiptJpeg();
  return {
    inspectReceiptImage: vi.fn(async () => ({ sizeBytes: storedBytes.length, mimetype: "image/jpeg" })),
    downloadReceiptImageBounded: vi.fn(async () => storedBytes),
  };
});

vi.mock("../../src/services/ocr.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ocr.service")>();
  return {
    ...actual,
    extractReceipt: vi.fn(async () => ({ text: "LOCAL STORE\n2026-09-01\nRice 100.00\nTOTAL PHP 100.00", confidence: 95, lines: [] })),
  };
});

vi.mock("../../src/services/receiptScan/providerAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/receiptScan/providerAdapters")>();
  const { successfulOutcome } = await import("../helpers/receiptProviderFixtures");
  return {
    ...actual,
    createGeminiReceiptAdapter: () => ({
      provider: "gemini" as const,
      providerVersion: "gemini-3.5-flash-lite",
      extract: async (request: Parameters<typeof successfulOutcome>[0]) => successfulOutcome(request),
    }),
  };
});

import { prisma } from "../../src/config/prisma";
import { countDbOperations } from "../../src/lib/requestTiming";
import { grantReceiptProviderConsent } from "../../src/services/receiptProviderConsent.service";
import { runReceiptWorkerOnce } from "../../src/services/receiptScan/worker";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/** Counts measured on 2026-10-18. Adding round trips fails; removing them should lower these. */
const BUDGET: Record<number, number> = { 1: 49, 3: 55 };

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const measured: string[] = [];

function enableAlwaysRouting() {
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
    RECEIPT_PROVIDER_ROUTING: "always",
    GOOGLE_GEMINI_API_KEY: "mocked-provider-key",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

beforeEach(async () => {
  await resetDb();
  vi.unstubAllEnvs();
  owner = await makeOwnerWithProfile({}, ["Inventory"]);
});

afterAll(async () => {
  console.log(`\nreceipt scan round trips\n${measured.join("\n")}`);
  vi.unstubAllEnvs();
  await disconnectDb();
});

describe("database round trips per receipt scan", () => {
  it.each([1, 3])("a %i-page scan under always routing", async (pages) => {
    enableAlwaysRouting();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, {
      provider: "gemini",
      policyVersion: "receipt-provider-policy-v1",
      purpose: "RECEIPT_EXTRACTION",
      dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
      region: "global",
      retentionHours: 0,
      trainingAllowed: false,
    });
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/probe.jpg`,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        pages: { create: Array.from({ length: pages }, (_, index) => ({ pageNumber: index + 1, imageFile: `${owner.profile.id}/probe-${index + 1}.jpg` })) },
      },
    });

    const started = performance.now();
    const { result: claimed, dbOperations } = await countDbOperations(() => runReceiptWorkerOnce());
    const ms = performance.now() - started;
    expect(claimed).toBe(true);

    const stored = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } });
    const timings = (stored.extractorVersions as { scanTimings?: Record<string, number | null> } | null)?.scanTimings ?? {};
    measured.push(`  ${pages} page(s): ${dbOperations} ops, ${Math.round(ms)} ms, status=${stored.processingStatus}, stages=${JSON.stringify(timings)}`);
    expect(stored.processingStatus).toBe("Complete");
    expect(dbOperations, `${pages}-page scan made ${dbOperations} round trips`).toBeLessThanOrEqual(BUDGET[pages]!);
  });
});
