import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opt-in provider modes (RECEIPT_PROVIDER_ROUTING=always and
 * RECEIPT_PROVIDER_CONSENT_MODE=automatic). Every test here also pins the
 * default: with neither setting present the gate behaves exactly as Phase 2
 * shipped it — Tesseract first, provider only as rescue, explicit owner tap.
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
  return {
    ...actual,
    extractReceipt: vi.fn(async () => ({ text: ocrText.value, confidence: 95, lines: [] })),
  };
});

const { adapterExtract, adapterMode, adapterExtraction } = vi.hoisted(() => ({
  adapterExtract: { current: vi.fn() },
  adapterMode: { value: "succeed" as "succeed" | "throw" },
  /** Field overrides applied to the provider's normalized extraction. */
  adapterExtraction: { value: {} as Record<string, unknown> },
}));

vi.mock("../../src/services/receiptScan/providerAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/receiptScan/providerAdapters")>();
  const { successfulOutcome } = await import("../helpers/receiptProviderFixtures");
  return {
    ...actual,
    createGeminiReceiptAdapter: () => ({
      provider: "gemini" as const,
      providerVersion: "gemini-3.5-flash-lite",
      extract: adapterExtract.current.mockImplementation(async (request) => {
        if (adapterMode.value === "throw") throw new Error("mocked provider outage");
        const outcome = successfulOutcome(request);
        return { ...outcome, extraction: { ...outcome.extraction, ...adapterExtraction.value } };
      }),
    }),
  };
});

import { prisma } from "../../src/config/prisma";
import { getReceiptProviderConfiguration } from "../../src/config/receiptProvider";
import {
  getReceiptProviderConsentState,
  grantReceiptProviderConsent,
  revokeReceiptProviderConsent,
} from "../../src/services/receiptProviderConsent.service";
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

const TEST_WORKER_ID = "receipt-provider-modes-worker";

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
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

function consentTerms() {
  return {
    provider: "gemini" as const,
    policyVersion: "receipt-provider-policy-v1",
    purpose: "RECEIPT_EXTRACTION" as const,
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] as ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    region: "global",
    retentionHours: 0,
    trainingAllowed: false as const,
  };
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
    rescueDecision: rescueDecision(),
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

async function extractorVersions(scanId: number) {
  const scan = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scanId } });
  return {
    processingStatus: scan.processingStatus,
    processingErrorCode: scan.processingErrorCode,
    vendor: scan.extractedVendor,
    versions: scan.extractorVersions as Record<string, unknown>,
  };
}

async function storedFields(scanId: number) {
  const scan = await prisma.receiptScan.findUniqueOrThrow({ where: { id: scanId }, include: { items: true } });
  const evidence = (scan.fieldEvidence ?? {}) as Record<string, { source: string }>;
  return {
    items: scan.items.map((item) => item.name),
    vendor: scan.extractedVendor,
    date: scan.extractedDate?.toISOString().slice(0, 10) ?? null,
    amount: scan.extractedAmount === null ? null : Number(scan.extractedAmount),
    sources: Object.fromEntries(Object.entries(evidence).map(([field, entry]) => [field, entry.source])),
    warnings: ((scan.warnings ?? []) as { code: string; field?: string }[]).map((w) => `${w.code}:${w.field ?? ""}`),
  };
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  adapterExtract.current = vi.fn();
  adapterMode.value = "succeed";
  adapterExtraction.value = {};
  ocrText.value = "LOCAL STORE\n2026-09-01\nRice 100.00\nTOTAL PHP 100.00";
  enableMockedGeminiProvider();
  await resetDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await disconnectDb();
});

describe("RECEIPT_PROVIDER_ROUTING", () => {
  it("keeps a clean local read off the provider by default", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await queuedScan(owner.profile.id, "default-clean");

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(adapterExtract.current).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    const stored = await extractorVersions(scan.id);
    expect(stored).toMatchObject({ processingStatus: "Complete", processingErrorCode: null, vendor: "LOCAL STORE" });
    expect(stored.versions.providerGateCode).toBe("PROVIDER_NOT_REQUESTED");
    expect(stored.versions.rescueReasonCodes).not.toContain("PROVIDER_ROUTING_ALWAYS");
  });

  it("sends a clean local read to the provider under always routing and records the policy reason", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_ROUTING: "always" });
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await queuedScan(owner.profile.id, "always-clean");

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(adapterExtract.current).toHaveBeenCalledTimes(1);
    const dispatch = await prisma.externalProviderDispatch.findFirstOrThrow();
    expect(dispatch).toMatchObject({
      businessProfileId: owner.profile.id,
      receiptScanId: scan.id,
      status: "SUCCEEDED",
      rescueReasonCode: "PROVIDER_ROUTING_ALWAYS",
    });
    const stored = await extractorVersions(scan.id);
    expect(stored).toMatchObject({ processingStatus: "Complete", processingErrorCode: null });
    expect(stored.versions.providerGateCode).toBe("PROVIDER_OK");
    expect(stored.versions.rescueReasonCodes).toContain("PROVIDER_ROUTING_ALWAYS");
  });

  it("keeps the local result when the provider fails under always routing", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_ROUTING: "always" });
    adapterMode.value = "throw";
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await queuedScan(owner.profile.id, "always-outage");

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(adapterExtract.current).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProviderDispatch.count()).toBe(1);
    const stored = await extractorVersions(scan.id);
    expect(stored).toMatchObject({ processingStatus: "Complete", vendor: "LOCAL STORE" });
    expect(stored.versions.providerGateCode).not.toBe("PROVIDER_OK");
  });

  it("does not request the provider under always routing while the configuration is not operational", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_ROUTING: "always", RECEIPT_PROVIDER_KILL_SWITCH: "true" });
    const owner = await makeOwnerWithProfile();
    const scan = await queuedScan(owner.profile.id, "always-killed");

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(adapterExtract.current).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    const stored = await extractorVersions(scan.id);
    expect(stored).toMatchObject({ processingStatus: "Complete", vendor: "LOCAL STORE" });
    expect(stored.versions.rescueReasonCodes).not.toContain("PROVIDER_ROUTING_ALWAYS");
  });

  it("dispatches an always-routing decision through the gate once and replays it, never calling twice", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_ROUTING: "always" });
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await leasedScan(owner.profile.id, "always-direct");
    const adapter = directAdapter();
    const input = dispatchInput(owner.profile.id, scan.id, {
      rescueDecision: rescueDecision({ reasons: ["PROVIDER_ROUTING_ALWAYS"] }),
    });

    const first = await dispatchReceiptProviderRescue(input, { adapter, configuration: getReceiptProviderConfiguration() });
    const budgetsAfterFirst = await prisma.externalProviderBudget.findMany({ orderBy: { id: "asc" } });
    const second = await dispatchReceiptProviderRescue(input, { adapter, configuration: getReceiptProviderConfiguration() });

    expect(first).toMatchObject({ code: "PROVIDER_OK", dispatched: true, dispatchStatus: "SUCCEEDED" });
    expect(second).toMatchObject({ code: "PROVIDER_OK", dispatched: true, dispatchStatus: "SUCCEEDED" });
    expect(second.merge).toEqual(first.merge);
    expect(adapter.extract).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProviderDispatch.count()).toBe(1);
    expect(await prisma.externalProviderDispatch.findFirstOrThrow()).toMatchObject({
      rescueReasonCode: "PROVIDER_ROUTING_ALWAYS",
      finalBillableUnits: 2,
    });
    expect(await prisma.externalProviderBudget.findMany({ orderBy: { id: "asc" } })).toEqual(budgetsAfterFirst);
  });
});

/*
 * Which reading wins under always routing: the provider's, wherever it
 * answered; the local read fills what it left null. The one exception is a
 * locale-ambiguous date the provider merely read the other way round.
 */
describe("provider merge against the local read", () => {
  const providerField = (value: string | number) => ({
    value,
    evidence: {
      source: "gemini",
      sourceVersion: "gemini-3.5-flash-lite",
      pageNumber: null,
      regionStatus: "UNAVAILABLE",
      region: null,
      confidenceBand: "MEDIUM",
      calibrationState: "UNCALIBRATED",
      validationState: "VALIDATED",
      validationCodes: ["FORMAT_VALID", "REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
    },
  });

  async function readWithProvider(suffix: string) {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_ROUTING: "always" });
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await queuedScan(owner.profile.id, suffix);
    expect(await runReceiptWorkerOnce()).toBe(true);
    expect(adapterExtract.current).toHaveBeenCalledTimes(1);
    expect((await extractorVersions(scan.id)).versions.providerGateCode).toBe("PROVIDER_OK");
    return storedFields(scan.id);
  }

  it("replaces a misread vendor, an ambiguous date and an unreconciled total with the provider's reading", async () => {
    // A garbage header, "03/09/2026" (both parts <= 12), and an item that does not reach the total.
    ocrText.value = "bn eee ippines, Inc. i\n03/09/2026\nRice 60.00\nTOTAL PHP 100.00";
    adapterExtraction.value = { date: providerField("2026-09-14"), total: providerField(125) };

    const stored = await readWithProvider("merge-corrects");

    expect(stored).toMatchObject({ vendor: "Provider Store", date: "2026-09-14", amount: 125 });
    expect(stored.sources).toEqual({ vendor: "vision", date: "vision", amount: "vision" });
    expect(stored.warnings).not.toContain("AMBIGUOUS_DATE:date");
  });

  it("reads the provider first even over a clean local read, and keeps the local items it did not replace", async () => {
    // A loyalty-card expiry the parser mistakes for the date, plus items that reconcile locally.
    ocrText.value = "LOCAL STORE\nCard Expiry : 12/30/2056\nRice 100.00\nTOTAL PHP 100.00";
    adapterExtraction.value = { date: providerField("2026-09-01"), total: providerField(100) };

    const stored = await readWithProvider("merge-provider-first");

    expect(stored).toMatchObject({ vendor: "Provider Store", date: "2026-09-01", amount: 100 });
    expect(stored.sources).toMatchObject({ vendor: "vision", date: "vision", amount: "ocr" });
    expect(stored.items).toEqual(["Rice"]);
  });

  /*
   * Rescue routing, not always routing: the provider was called because the
   * local read failed, so it may only replace a field whose evidence is
   * genuinely weaker. A total with no items read is unverified, not
   * contradicted — nothing on the receipt disputes it — so it holds against a
   * provider total of equal strength.
   */
  it("keeps a printed total that no items contradict when the provider is only a rescue", async () => {
    enableMockedGeminiProvider();
    ocrText.value = "2026-09-01\nTOTAL 100.00";
    adapterExtraction.value = { total: providerField(125) };
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await queuedScan(owner.profile.id, "rescue-total-holds");

    expect(await runReceiptWorkerOnce()).toBe(true);
    expect(adapterExtract.current).toHaveBeenCalledTimes(1);

    const stored = await storedFields(scan.id);
    expect(stored.amount).toBe(100);
    expect(stored.sources.amount).toBe("ocr");
  });

  it("keeps the parser's DD/MM reading of an ambiguous date when the provider only swaps day and month", async () => {
    ocrText.value = "LOCAL STORE\n03/09/2026\nRice 100.00\nTOTAL PHP 100.00";
    adapterExtraction.value = { date: providerField("2026-03-09") };

    const stored = await readWithProvider("merge-date-swap");

    expect(stored.date).toBe("2026-09-03");
    expect(stored.sources.date).toBe("ocr");
    expect(stored.warnings).toContain("AMBIGUOUS_DATE:date");
  });
});

describe("RECEIPT_PROVIDER_CONSENT_MODE", () => {
  it("still requires an owner grant in explicit mode", async () => {
    const owner = await makeOwnerWithProfile();
    const scan = await leasedScan(owner.profile.id, "explicit-missing");
    const adapter = directAdapter();

    const result = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), {
      adapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED", dispatched: false });
    expect(adapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProcessingConsent.count()).toBe(0);
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
  });

  it("grants by policy on first dispatch in automatic mode and reuses that grant afterwards", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_CONSENT_MODE: "automatic" });
    const owner = await makeOwnerWithProfile();
    const bystander = await makeOwnerWithProfile();
    const first = await leasedScan(owner.profile.id, "automatic-first");
    const second = await leasedScan(owner.profile.id, "automatic-second");
    const adapter = directAdapter();

    const firstResult = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, first.id), {
      adapter,
      configuration: getReceiptProviderConfiguration(),
    });
    const secondResult = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, second.id), {
      adapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(firstResult).toMatchObject({ code: "PROVIDER_OK", dispatched: true });
    expect(secondResult).toMatchObject({ code: "PROVIDER_OK", dispatched: true });
    expect(adapter.extract).toHaveBeenCalledTimes(2);
    const consents = await prisma.externalProcessingConsent.findMany();
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      businessProfileId: owner.profile.id,
      actorUserId: owner.user.id,
      provider: "gemini",
      policyVersion: "receipt-provider-policy-v1",
      purpose: "RECEIPT_EXTRACTION",
      allowedDataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
      processingRegion: "global",
      providerRetentionHours: 0,
      providerTrainingAllowed: false,
      revokedAt: null,
      source: "OPERATOR_POLICY",
    });
    expect(await prisma.externalProcessingConsent.count({ where: { businessProfileId: bystander.profile.id } })).toBe(0);
    for (const dispatch of await prisma.externalProviderDispatch.findMany()) {
      expect(dispatch.consentId).toBe(consents[0]!.id);
    }
  });

  it("supersedes an open grant on stale terms in automatic mode, as an owner re-grant would", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_CONSENT_MODE: "automatic" });
    const owner = await makeOwnerWithProfile();
    const stale = await prisma.externalProcessingConsent.create({
      data: {
        businessProfileId: owner.profile.id,
        actorUserId: owner.user.id,
        provider: "gemini",
        policyVersion: "superseded-policy-v0",
        purpose: "RECEIPT_EXTRACTION",
        allowedDataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
        processingRegion: "global",
        providerRetentionHours: 0,
        providerTrainingAllowed: false,
      },
    });
    const scan = await leasedScan(owner.profile.id, "automatic-stale");
    const adapter = directAdapter();

    const result = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), {
      adapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_OK", dispatched: true });
    const rows = await prisma.externalProcessingConsent.findMany({ orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: stale.id, policyVersion: "superseded-policy-v0" });
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({
      policyVersion: "receipt-provider-policy-v1",
      revokedAt: null,
      actorUserId: owner.user.id,
      source: "OPERATOR_POLICY",
    });
    expect(await prisma.externalProviderDispatch.findFirstOrThrow()).toMatchObject({ consentId: rows[1]!.id });
  });

  it("lets an explicit revoke win over automatic mode", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_CONSENT_MODE: "automatic" });
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    await revokeReceiptProviderConsent(owner.user.id, owner.profile.id);
    const scan = await leasedScan(owner.profile.id, "automatic-revoked");
    const adapter = directAdapter();

    const result = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), {
      adapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED", dispatched: false });
    expect(adapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProcessingConsent.count()).toBe(1);
    expect(await prisma.externalProcessingConsent.count({ where: { revokedAt: null } })).toBe(0);
    expect(await prisma.externalProcessingConsent.findFirstOrThrow()).toMatchObject({ source: "OWNER" });
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await getReceiptProviderConsentState(owner.user.id, owner.profile.id)).toMatchObject({
      mode: "automatic",
      consent: null,
      policyBlocked: true,
    });

    // An owner grant after the revoke lifts the block and dispatch resumes.
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    expect(await getReceiptProviderConsentState(owner.user.id, owner.profile.id)).toMatchObject({
      mode: "automatic",
      policyBlocked: false,
    });
    const resumed = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), {
      adapter,
      configuration: getReceiptProviderConfiguration(),
    });
    expect(resumed).toMatchObject({ code: "PROVIDER_OK", dispatched: true });
    expect(adapter.extract).toHaveBeenCalledTimes(1);
  });

  it("reads every receipt with no owner tap when both opt-ins are set together", async () => {
    enableMockedGeminiProvider({ RECEIPT_PROVIDER_ROUTING: "always", RECEIPT_PROVIDER_CONSENT_MODE: "automatic" });
    const owner = await makeOwnerWithProfile();
    const scan = await queuedScan(owner.profile.id, "both-modes");

    expect(await runReceiptWorkerOnce()).toBe(true);

    expect(adapterExtract.current).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProcessingConsent.count({ where: { businessProfileId: owner.profile.id, revokedAt: null } })).toBe(1);
    const stored = await extractorVersions(scan.id);
    expect(stored).toMatchObject({ processingStatus: "Complete", processingErrorCode: null });
    expect(stored.versions.providerGateCode).toBe("PROVIDER_OK");
  });
});
