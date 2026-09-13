import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import {
  getReceiptProviderConfiguration,
  type ReceiptProviderConfiguration,
} from "../../src/config/receiptProvider";
import {
  dispatchReceiptProviderRescue,
  type ReceiptProviderDispatchInput,
} from "../../src/services/receiptProviderDispatch.service";
import {
  grantReceiptProviderConsent,
  revokeReceiptProviderConsent,
} from "../../src/services/receiptProviderConsent.service";
import type {
  ReceiptProviderAdapter,
  ReceiptProviderOutcome,
  ReceiptProviderRequest,
} from "../../src/services/receiptProviderContract";
import {
  MOCK_PROVIDER_BYTES,
  MOCK_PROVIDER_SHA256,
  localExtraction,
  rescueDecision,
  successfulOutcome,
} from "../helpers/receiptProviderFixtures";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

type Adapter = ReceiptProviderAdapter & { readonly providerVersion: string };

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
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) vi.stubEnv(key, undefined);
    else vi.stubEnv(key, value);
  }
}

function consentTerms() {
  return {
    provider: "gemini" as const,
    policyVersion: "receipt-provider-policy-v1",
    purpose: "RECEIPT_EXTRACTION" as const,
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] as [
      "RECEIPT_IMAGE",
      "DERIVED_RECEIPT_IMAGE",
    ],
    region: "global",
    retentionHours: 0,
    trainingAllowed: false as const,
  };
}

function adapter(
  implementation: (request: ReceiptProviderRequest) => Promise<unknown> = async (request) => successfulOutcome(request),
): Adapter & { extract: ReturnType<typeof vi.fn> } {
  return {
    provider: "gemini",
    providerVersion: "gemini-3.5-flash-lite",
    extract: vi.fn(implementation),
  };
}

async function scanFor(businessProfileId: number, suffix: string) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `${businessProfileId}/mocked-${suffix}.jpg`,
      confirmationStatus: "Pending",
      processingStatus: "Processing",
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

beforeEach(async () => {
  vi.unstubAllEnvs();
  enableMockedGeminiProvider();
  await resetDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await disconnectDb();
});

describe("mocked receipt provider dispatch gate", () => {
  it("performs zero dispatches when credentials exist but the server gate is incomplete", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("RECEIPT_PROVIDER", "gemini");
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "mocked-provider-key");
    const owner = await makeOwnerWithProfile();
    const scan = await scanFor(owner.profile.id, "credentials-only");
    const mockedAdapter = adapter();

    const result = await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, scan.id),
      { adapter: mockedAdapter, configuration: getReceiptProviderConfiguration() },
    );

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false, dispatchStatus: "SKIPPED" });
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
  });

  it("refuses a cross-profile receipt before reserving units or loading evidence", async () => {
    const owner = await makeOwnerWithProfile();
    const other = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const otherScan = await scanFor(other.profile.id, "other-profile");
    const loadBytes = vi.fn(async () => MOCK_PROVIDER_BYTES);
    const mockedAdapter = adapter();

    const result = await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, otherScan.id, {
        pages: [{
          pageNumber: 1,
          dataClass: "RECEIPT_IMAGE",
          mediaType: "image/jpeg",
          inputSha256: MOCK_PROVIDER_SHA256,
          loadBytes,
        }],
      }),
      { adapter: mockedAdapter, configuration: getReceiptProviderConfiguration() },
    );

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false });
    expect(loadBytes).not.toHaveBeenCalled();
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
  });

  it("requires an active exact-term consent before reserving or submitting", async () => {
    const owner = await makeOwnerWithProfile();
    const missingScan = await scanFor(owner.profile.id, "missing-consent");
    const mockedAdapter = adapter();
    const config = getReceiptProviderConfiguration();

    const missing = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, missingScan.id), {
      adapter: mockedAdapter,
      configuration: config,
    });
    expect(missing).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED", dispatched: false });

    await prisma.externalProcessingConsent.create({
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
    const staleScan = await scanFor(owner.profile.id, "stale-consent");
    const stale = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, staleScan.id), {
      adapter: mockedAdapter,
      configuration: config,
    });

    expect(stale).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED", dispatched: false });
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
  });

  it("atomically prevents concurrent resource and business reservations from exceeding their caps", async () => {
    enableMockedGeminiProvider({
      RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "4",
      RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT: "4",
    });
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scans = await Promise.all(Array.from({ length: 4 }, (_, index) => scanFor(owner.profile.id, `race-${index}`)));
    const mockedAdapter = adapter();
    const config = getReceiptProviderConfiguration();

    const results = await Promise.all(scans.map((scan) =>
      dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), { adapter: mockedAdapter, configuration: config })));

    const dispatched = results.filter((result) => result.dispatched);
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched.length).toBeLessThanOrEqual(2);
    expect(results.filter((result) => !result.dispatched)).toHaveLength(4 - dispatched.length);
    expect(mockedAdapter.extract).toHaveBeenCalledTimes(dispatched.length);
    const budgets = await prisma.externalProviderBudget.findMany({ orderBy: { scope: "asc" } });
    expect(budgets).toHaveLength(2);
    for (const budget of budgets) {
      expect(budget.limitUnits).toBe(4);
      expect(budget.usedUnits).toBe(dispatched.length * 2);
      expect(budget.reservedUnits).toBe(0);
      expect(budget.usedUnits + budget.reservedUnits).toBeLessThanOrEqual(budget.limitUnits);
    }
  });

  it("preserves local output and performs no call after the unit cap is exhausted", async () => {
    enableMockedGeminiProvider({
      RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "2",
      RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT: "2",
    });
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const firstScan = await scanFor(owner.profile.id, "fills-cap");
    const rejectedScan = await scanFor(owner.profile.id, "over-cap");
    const mockedAdapter = adapter();
    const config = getReceiptProviderConfiguration();

    expect(await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, firstScan.id), {
      adapter: mockedAdapter,
      configuration: config,
    })).toMatchObject({ code: "PROVIDER_OK", dispatched: true });
    const local = localExtraction({ vendor: { value: "LOCAL_ONLY", evidence: localExtraction().vendor.evidence } });
    const rejected = await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, rejectedScan.id, { localExtraction: local }),
      { adapter: mockedAdapter, configuration: config },
    );

    expect(rejected).toMatchObject({
      code: "PROVIDER_QUOTA_EXHAUSTED",
      dispatched: false,
      merge: { receipt: local, appliedFields: [], reason: "NOT_SUCCESSFUL" },
    });
    expect(mockedAdapter.extract).toHaveBeenCalledTimes(1);
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.usedUnits).toBe(2);
      expect(budget.reservedUnits).toBe(0);
    }
  });

  it("does not resubmit an already attempted reservation key", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "idempotent");
    const mockedAdapter = adapter();
    const input = dispatchInput(owner.profile.id, scan.id);
    const config = getReceiptProviderConfiguration();

    const first = await dispatchReceiptProviderRescue(input, { adapter: mockedAdapter, configuration: config });
    const repeated = await dispatchReceiptProviderRescue(input, { adapter: mockedAdapter, configuration: config });

    expect(first).toMatchObject({ code: "PROVIDER_OK", dispatched: true, dispatchStatus: "SUCCEEDED" });
    expect(repeated).toMatchObject({
      code: "PROVIDER_DISPATCH_ALREADY_ATTEMPTED",
      dispatched: false,
      dispatchStatus: "SKIPPED",
    });
    expect(mockedAdapter.extract).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProviderDispatch.count()).toBe(1);
  });

  it("rechecks the kill switch after reservation and releases the unused units", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "kill-switch");
    const mockedAdapter = adapter();
    const enabled = getReceiptProviderConfiguration();
    let configReads = 0;
    const loadConfiguration = (): ReceiptProviderConfiguration => {
      configReads += 1;
      return configReads === 1
        ? enabled
        : { ...enabled, killSwitchActive: true, operational: false };
    };

    const result = await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, scan.id),
      { adapter: mockedAdapter, loadConfiguration },
    );

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false });
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "CANCELLED", finalBillableUnits: 0 });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(0);
      expect(budget.usedUnits).toBe(0);
    }
  });

  it("rechecks consent immediately before submission and blocks every future dispatch after revoke", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const firstScan = await scanFor(owner.profile.id, "revoke-race");
    const mockedAdapter = adapter();
    const revokeDuringLoad = vi.fn(async () => {
      await revokeReceiptProviderConsent(owner.user.id, owner.profile.id);
      return MOCK_PROVIDER_BYTES;
    });
    const firstInput = dispatchInput(owner.profile.id, firstScan.id);
    firstInput.pages[0]!.loadBytes = revokeDuringLoad;

    const raced = await dispatchReceiptProviderRescue(firstInput, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });
    const secondScan = await scanFor(owner.profile.id, "after-revoke");
    const future = await dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, secondScan.id), {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(raced).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED", dispatched: false });
    expect(future).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED", dispatched: false });
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "CANCELLED", finalBillableUnits: 0 });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(0);
      expect(budget.usedUnits).toBe(0);
    }
  });

  it("cancels a reservation when stored evidence bytes no longer match the trusted hash", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "changed-evidence");
    const mockedAdapter = adapter();
    const changedBytes = Buffer.from("different mocked bytes");
    const input = dispatchInput(owner.profile.id, scan.id);
    input.pages[0]!.loadBytes = vi.fn(async () => changedBytes);

    const result = await dispatchReceiptProviderRescue(input, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_EVIDENCE_INVALID", dispatched: false });
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "CANCELLED" });
    expect(createHash("sha256").update(changedBytes).digest("hex")).not.toBe(MOCK_PROVIDER_SHA256);
  });

  it("keeps reserved units after a post-submission transport ambiguity and returns only safe state", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "ambiguous");
    const sensitiveProviderBody = "card=4111111111111111 receipt=PRIVATE_VENDOR";
    const mockedAdapter = adapter(async () => {
      throw new Error(sensitiveProviderBody);
    });
    const local = localExtraction({ vendor: { value: "LOCAL_FALLBACK_VENDOR", evidence: localExtraction().vendor.evidence } });

    const result = await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, scan.id, { localExtraction: local }),
      { adapter: mockedAdapter, configuration: getReceiptProviderConfiguration() },
    );

    expect(result).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      dispatched: true,
      dispatchStatus: "AMBIGUOUS",
      merge: { receipt: local, appliedFields: [], reason: "NOT_SUCCESSFUL" },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveProviderBody);
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
      status: "AMBIGUOUS",
      finalBillableUnits: null,
      outcomeCode: "TIMEOUT_AFTER_SUBMISSION",
    });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(2);
      expect(budget.usedUnits).toBe(0);
    }
  });

  it("times out a never-resolving submitted adapter without waiting for the production timeout", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "actual-timeout");
    const mockedAdapter = adapter(async () => new Promise<never>(() => undefined));
    let adapterStarted!: () => void;
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    mockedAdapter.extract.mockImplementationOnce(async () => {
      adapterStarted();
      return new Promise<never>(() => undefined);
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });
    await started;
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      dispatched: true,
      dispatchStatus: "AMBIGUOUS",
      merge: { receipt: localExtraction(), appliedFields: [], reason: "NOT_SUCCESSFUL" },
    });
    expect(mockedAdapter.extract).toHaveBeenCalledTimes(1);
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
      status: "AMBIGUOUS",
      outcomeCode: "TIMEOUT_AFTER_SUBMISSION",
      finalBillableUnits: null,
    });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(2);
      expect(budget.usedUnits).toBe(0);
    }
  });

  it("marks finalization ambiguous and preserves reservations when accounting cannot settle", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "finalization-unknown");
    const mockedAdapter = adapter();
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionCalls = 0;
    const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
      transactionCalls += 1;
      if (transactionCalls === 3) throw new Error("mocked accounting commit ambiguity");
      return (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(...args);
    }) as typeof prisma.$transaction);

    try {
      const local = localExtraction();
      const result = await dispatchReceiptProviderRescue(
        dispatchInput(owner.profile.id, scan.id, { localExtraction: local }),
        { adapter: mockedAdapter, configuration: getReceiptProviderConfiguration() },
      );

      expect(result).toMatchObject({
        code: "PROVIDER_RESULT_REJECTED",
        dispatched: true,
        dispatchStatus: "AMBIGUOUS",
        merge: { receipt: local, appliedFields: [], reason: "NOT_SUCCESSFUL" },
      });
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
        status: "AMBIGUOUS",
        outcomeCode: "FINALIZATION_UNKNOWN",
        finalBillableUnits: null,
      });
      for (const budget of await prisma.externalProviderBudget.findMany()) {
        expect(budget.reservedUnits).toBe(2);
        expect(budget.usedUnits).toBe(0);
      }
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("charges the reserved amount conservatively for invalid provider output and preserves local fields", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "invalid-output");
    const mockedAdapter = adapter(async () => ({ rawProviderBody: "PRIVATE_RECEIPT_TEXT" }));
    const local = localExtraction();

    const result = await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, scan.id, { localExtraction: local }),
      { adapter: mockedAdapter, configuration: getReceiptProviderConfiguration() },
    );

    expect(result).toMatchObject({
      code: "PROVIDER_RESULT_REJECTED",
      dispatched: true,
      dispatchStatus: "FAILED",
      merge: { receipt: local, appliedFields: [], providerResultAccepted: true, reason: "NOT_SUCCESSFUL" },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RECEIPT_TEXT");
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
      status: "FAILED",
      finalBillableUnits: 2,
      outcomeCode: "INVALID_RESULT",
    });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(0);
      expect(budget.usedUnits).toBe(2);
    }
  });

  it("stores no local receipt text, object path, provider body, or payment fragment in dispatch audit", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "PRIVATE_OBJECT_PATH");
    const mockedAdapter = adapter(async (request) => successfulOutcome(request) satisfies ReceiptProviderOutcome);
    const local = localExtraction({
      vendor: { value: "PRIVATE_VENDOR_TEXT", evidence: localExtraction().vendor.evidence },
    });

    await dispatchReceiptProviderRescue(
      dispatchInput(owner.profile.id, scan.id, { localExtraction: local }),
      { adapter: mockedAdapter, configuration: getReceiptProviderConfiguration() },
    );

    const audit = await prisma.externalProviderDispatch.findFirstOrThrow();
    const serialized = JSON.stringify(audit, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toMatch(/PRIVATE_VENDOR_TEXT|PRIVATE_OBJECT_PATH|4111111111111111|rawProviderBody/);
    expect(audit.reservationKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
