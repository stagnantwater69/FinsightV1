import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-3 dispatch safety, kept apart from receiptProviderDispatch.test.ts
 * and receiptProviderModes.test.ts so it can be run and reviewed on its own:
 *
 * - the new log lines ("receipt provider gate", the consent-by-policy grant)
 *   carry ids and codes only, never OCR text, provider items, amounts or
 *   merchant names;
 * - the dispatch audit row holds no receipt content; the stored outcome that
 *   does is its own row and dies with the scan;
 * - a stored outcome is re-validated on replay: tampered content, or page
 *   bytes that no longer match, do not replay and never trigger a second
 *   provider call;
 * - unreconciled provider items are prefilled UNVALIDATED with the
 *   UNVERIFIED_ITEMS warning, not booked.
 */

const PRIVATE = {
  localVendor: "PRIVATE_LOCAL_VENDOR_Q9",
  providerVendor: "PRIVATE_PROVIDER_VENDOR_Q9",
  item: "PRIVATE_ITEM_NAME_Q9",
  amount: "4321.87",
};

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
    extractReceipt: vi.fn(async () => ({
      text: `${PRIVATE.localVendor}\n2026-09-01\nTOTAL PHP ${PRIVATE.amount}`,
      confidence: 95,
      lines: [],
    })),
  };
});

const { adapterExtract } = vi.hoisted(() => ({ adapterExtract: { current: vi.fn() } }));

vi.mock("../../src/services/receiptScan/providerAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/receiptScan/providerAdapters")>();
  const { evidence, providerExtraction, successfulOutcome } = await import("../helpers/receiptProviderFixtures");
  return {
    ...actual,
    createGeminiReceiptAdapter: () => ({
      provider: "gemini" as const,
      providerVersion: "gemini-3.5-flash-lite",
      extract: adapterExtract.current.mockImplementation(async (request) => {
        const unvalidated = evidence("gemini", {
          sourceVersion: request.providerVersion,
          validationState: "UNVALIDATED",
          confidenceBand: "LOW",
        });
        return successfulOutcome(request, {
          extraction: providerExtraction("gemini", {
            sourceVersion: request.providerVersion,
            schemaVersion: request.normalizedSchemaVersion,
            vendor: { value: PRIVATE.providerVendor, evidence: evidence("gemini", { sourceVersion: request.providerVersion }) },
            total: { value: Number(PRIVATE.amount), evidence: evidence("gemini", { sourceVersion: request.providerVersion }) },
            // Items that do not add up to the total, and nothing validated them.
            items: [
              { name: PRIVATE.item, quantity: null, amount: 1000, evidence: unvalidated },
              { name: `${PRIVATE.item}_2`, quantity: null, amount: 500, evidence: unvalidated },
            ],
            itemsEvidence: unvalidated,
          }),
        });
      }),
    }),
  };
});

import { logger } from "../../src/config/logger";
import { prisma } from "../../src/config/prisma";
import { getReceiptProviderConfiguration } from "../../src/config/receiptProvider";
import {
  dispatchReceiptProviderRescue,
  type ReceiptProviderDispatchInput,
} from "../../src/services/receiptProviderDispatch.service";
import { runReceiptWorkerOnce } from "../../src/services/receiptScan/worker";
import {
  MOCK_PROVIDER_BYTES,
  MOCK_PROVIDER_SHA256,
  localExtraction,
  rescueDecision,
  successfulOutcome,
} from "../helpers/receiptProviderFixtures";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const TEST_WORKER_ID = "receipt-provider-safety-worker";
const PRIVATE_PATTERN = new RegExp(Object.values(PRIVATE).join("|"));

function enableMockedGeminiProvider(overrides: NodeJS.ProcessEnv = {}) {
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
    GOOGLE_GEMINI_API_KEY: "mocked-provider-key",
    RECEIPT_PROVIDER_ROUTING: "always",
    RECEIPT_PROVIDER_CONSENT_MODE: "automatic",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

async function queuedScan(businessProfileId: number, suffix: string) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `${businessProfileId}/${suffix}.jpg`,
      processingStatus: "Processing",
      confirmationStatus: "Pending",
      pages: { create: [{ pageNumber: 1, imageFile: `${businessProfileId}/${suffix}.jpg` }] },
    },
  });
}

async function leasedScan(businessProfileId: number, suffix: string) {
  const now = new Date();
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `${businessProfileId}/${suffix}.jpg`,
      confirmationStatus: "Pending",
      processingStatus: "Processing",
      processingWorkerId: TEST_WORKER_ID,
      processingAttemptCount: 1,
      processingStartedAt: now,
      processingHeartbeatAt: now,
    },
  });
}

function dispatchInput(
  businessProfileId: number,
  receiptScanId: number,
  overrides: Partial<ReceiptProviderDispatchInput> = {},
): ReceiptProviderDispatchInput {
  return {
    businessProfileId,
    receiptScanId,
    processingLease: { workerId: TEST_WORKER_ID, attempt: 1 },
    rescueDecision: rescueDecision({ reasons: ["PROVIDER_ROUTING_ALWAYS"] }),
    localExtraction: localExtraction(),
    pages: [{
      pageNumber: 1,
      dataClass: "RECEIPT_IMAGE",
      mediaType: "image/jpeg",
      inputSha256: MOCK_PROVIDER_SHA256,
      loadBytes: vi.fn(async () => MOCK_PROVIDER_BYTES),
    }],
    preprocessingVersion: "preprocess-v1",
    normalizedSchemaVersion: "normalized-v1",
    ...overrides,
  };
}

function directAdapter() {
  return {
    provider: "gemini" as const,
    providerVersion: "gemini-3.5-flash-lite",
    extract: vi.fn(async (request) => successfulOutcome(request)),
  };
}

function logCalls(spies: ReturnType<typeof vi.spyOn>[]) {
  return spies.flatMap((spy) => spy.mock.calls);
}

let logSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  adapterExtract.current = vi.fn();
  enableMockedGeminiProvider();
  await resetDb();
  logSpies = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(logger, level));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await disconnectDb();
});

describe("receipt provider gate and consent-by-policy log hygiene", () => {
  it("logs ids and codes only, and keeps receipt content out of the dispatch audit row", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await queuedScan(owner.profile.id, "log-hygiene");

    expect(await runReceiptWorkerOnce()).toBe(true);
    expect(adapterExtract.current).toHaveBeenCalledTimes(1);

    const calls = logCalls(logSpies);
    const gate = calls.find(([, message]) => message === "receipt provider gate");
    expect(gate, "the gate line must be emitted").toBeDefined();
    expect(Object.keys(gate![0] as object).sort()).toEqual([
      "appliedFields",
      "code",
      "dispatched",
      "localItemCount",
      "mergeReason",
      // Stage timings: millisecond counts only, never receipt content.
      "ocrMs",
      "persistMs",
      "persisted",
      "provider",
      "providerItemCount",
      "providerMs",
      "reasons",
      "rescueRequested",
      "scanId",
      "totalMs",
    ]);
    expect(gate![0]).toMatchObject({ scanId: scan.id, code: "PROVIDER_OK", dispatched: true, provider: "gemini", persisted: true });

    const policy = calls.find(([, message]) => message === "receipt provider consent granted by policy");
    expect(policy, "the consent-by-policy line must be emitted").toBeDefined();
    expect(Object.keys(policy![0] as object).sort()).toEqual([
      "businessProfileId",
      "consentId",
      "source",
      "supersededConsentId",
    ]);
    expect(policy![0]).toMatchObject({ businessProfileId: owner.profile.id, source: "operator-policy" });

    const serialised = JSON.stringify(calls, (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value));
    expect(serialised).not.toMatch(PRIVATE_PATTERN);

    const dispatch = await prisma.externalProviderDispatch.findFirstOrThrow();
    expect(JSON.stringify(dispatch)).not.toMatch(PRIVATE_PATTERN);
    expect(dispatch).toMatchObject({ businessProfileId: owner.profile.id, receiptScanId: scan.id, status: "SUCCEEDED" });

    // The content lives in the outcome row, scoped to the same profile and scan.
    const outcomes = await prisma.externalProviderDispatchOutcome.findMany();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      dispatchId: dispatch.id,
      businessProfileId: owner.profile.id,
      receiptScanId: scan.id,
      receiptScanBusinessProfileId: owner.profile.id,
    });
    expect(JSON.stringify(outcomes[0]!.outcome)).toContain(PRIVATE.item);
  });

  it("prefills unreconciled provider items for owner review with the UNVERIFIED_ITEMS warning and never books them", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await queuedScan(owner.profile.id, "unverified-items");

    expect(await runReceiptWorkerOnce()).toBe(true);

    const stored = await prisma.receiptScan.findUniqueOrThrow({
      where: { id: scan.id },
      include: { items: { orderBy: { lineNumber: "asc" } } },
    });
    expect(stored.processingStatus).toBe("Complete");
    expect(stored.confirmationStatus).toBe("Pending");
    expect(JSON.stringify(stored.warnings)).toContain("UNVERIFIED_ITEMS");
    expect(stored.items.map((item) => item.name)).toEqual([PRIVATE.item, `${PRIVATE.item}_2`]);
    expect((stored.extractorVersions as Record<string, unknown>).providerGateCode).toBe("PROVIDER_OK");
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("deletes the stored outcome with the scan while the audit row survives with its scan columns cleared", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await queuedScan(owner.profile.id, "cascade");
    expect(await runReceiptWorkerOnce()).toBe(true);
    const dispatch = await prisma.externalProviderDispatch.findFirstOrThrow();
    expect(await prisma.externalProviderDispatchOutcome.count({ where: { dispatchId: dispatch.id } })).toBe(1);

    await prisma.receiptScan.delete({ where: { id: scan.id } });

    expect(await prisma.externalProviderDispatchOutcome.count()).toBe(0);
    expect(await prisma.externalProviderDispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).toMatchObject({
      status: "SUCCEEDED",
      receiptScanId: null,
      receiptScanBusinessProfileId: null,
    });
  });
});

describe("stored-outcome replay is re-validated", () => {
  it("replays once, then refuses a tampered stored outcome without a second provider call", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await leasedScan(owner.profile.id, "replay-tamper");
    const adapter = directAdapter();
    const input = dispatchInput(owner.profile.id, scan.id);
    const configuration = getReceiptProviderConfiguration();

    const first = await dispatchReceiptProviderRescue(input, { adapter, configuration });
    expect(first).toMatchObject({ code: "PROVIDER_OK", dispatched: true, dispatchStatus: "SUCCEEDED" });
    const replay = await dispatchReceiptProviderRescue(input, { adapter, configuration });
    expect(replay).toMatchObject({ code: "PROVIDER_OK", dispatched: true, dispatchStatus: "SUCCEEDED" });
    expect(replay.merge).toEqual(first.merge);
    expect(adapter.extract).toHaveBeenCalledTimes(1);

    const dispatch = await prisma.externalProviderDispatch.findFirstOrThrow();
    const stored = await prisma.externalProviderDispatchOutcome.findUniqueOrThrow({ where: { dispatchId: dispatch.id } });
    // Graft the stored answer onto another dispatch; replay must re-validate and refuse.
    await prisma.externalProviderDispatchOutcome.update({
      where: { dispatchId: dispatch.id },
      data: { outcome: { ...(stored.outcome as object), dispatchReference: `dispatch:${dispatch.id + 1}` } },
    });

    const tampered = await dispatchReceiptProviderRescue(input, { adapter, configuration });
    expect(tampered).toMatchObject({ code: "PROVIDER_DISPATCH_ALREADY_ATTEMPTED", dispatched: false });
    expect(tampered.merge.appliedFields).toEqual([]);
    expect(adapter.extract).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProviderDispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).toMatchObject({
      status: "SUCCEEDED",
      finalBillableUnits: 2,
    });
  });

  it("refuses a stored outcome whose status is not SUCCEEDED or whose extraction is malformed", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await leasedScan(owner.profile.id, "replay-malformed");
    const adapter = directAdapter();
    const input = dispatchInput(owner.profile.id, scan.id);
    const configuration = getReceiptProviderConfiguration();
    await dispatchReceiptProviderRescue(input, { adapter, configuration });
    const dispatch = await prisma.externalProviderDispatch.findFirstOrThrow();

    await prisma.externalProviderDispatchOutcome.update({
      where: { dispatchId: dispatch.id },
      data: { outcome: { not: "an outcome" } },
    });
    expect(await dispatchReceiptProviderRescue(input, { adapter, configuration })).toMatchObject({
      code: "PROVIDER_DISPATCH_ALREADY_ATTEMPTED",
      dispatched: false,
    });
    expect(adapter.extract).toHaveBeenCalledTimes(1);
  });

  it("does not replay when the page bytes no longer hash to the reservation's evidence", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await leasedScan(owner.profile.id, "replay-bytes");
    const adapter = directAdapter();
    const configuration = getReceiptProviderConfiguration();
    await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), { adapter, configuration });

    const changedBytes = dispatchInput(owner.profile.id, scan.id, {
      pages: [{
        pageNumber: 1,
        dataClass: "RECEIPT_IMAGE",
        mediaType: "image/jpeg",
        inputSha256: MOCK_PROVIDER_SHA256,
        loadBytes: vi.fn(async () => Buffer.from([9, 9, 9, 9])),
      }],
    });
    const result = await dispatchReceiptProviderRescue(changedBytes, { adapter, configuration });
    expect(result).toMatchObject({ code: "PROVIDER_EVIDENCE_INVALID", dispatched: false });
    expect(adapter.extract).toHaveBeenCalledTimes(1);
    // A replay settles nothing: the billed row is untouched.
    expect(await prisma.externalProviderDispatch.findFirstOrThrow()).toMatchObject({
      status: "SUCCEEDED",
      finalBillableUnits: 2,
    });
    expect(await prisma.externalProviderDispatchOutcome.count()).toBe(1);
  });

  it("never serves one profile's stored outcome to another profile", async () => {
    const owner = await makeOwnerWithProfile();
    const bystander = await makeOwnerWithProfile();
    const scan = await leasedScan(owner.profile.id, "replay-cross-profile");
    const adapter = directAdapter();
    const configuration = getReceiptProviderConfiguration();
    await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), { adapter, configuration });

    // Same scan id, other profile: different reservation key, and not theirs to dispatch.
    const foreign = await dispatchReceiptProviderRescue(dispatchInput(bystander.profile.id, scan.id), {
      adapter,
      configuration,
    });
    expect(foreign.code).not.toBe("PROVIDER_OK");
    expect(foreign.dispatched).toBe(false);
    expect(adapter.extract).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProviderDispatchOutcome.count()).toBe(1);
    expect(await prisma.externalProviderDispatch.count({ where: { businessProfileId: bystander.profile.id } })).toBe(0);
    expect(await prisma.externalProviderDispatch.count({ where: { status: "SUCCEEDED" } })).toBe(1);
  });
});
