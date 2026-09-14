import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import {
  getReceiptProviderConfiguration,
  type ReceiptProviderConfiguration,
} from "../../src/config/receiptProvider";
import {
  dispatchReceiptProviderRescue,
  reconcileStaleReceiptProviderDispatches,
  RECEIPT_PROVIDER_DISPATCH_STALE_MS,
  RECEIPT_PROCESSING_LEASE_MS,
  type ReceiptProviderDispatchInput,
} from "../../src/services/receiptProviderDispatch.service";
import {
  grantReceiptProviderConsent,
  revokeReceiptProviderConsent,
} from "../../src/services/receiptProviderConsent.service";
import { requestReceiptScanDeletion } from "../../src/services/receiptPurge.service";
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
const TEST_WORKER_ID = "receipt-provider-test-worker";
let reconciliationSeed = 0;

async function waitForBlockedQuery(fragment: string): Promise<{ pid: number; blockingPids: number[] }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number; blockingPids: number[] }[]>`
      SELECT pid, pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${fragment}%`}
    `;
    const blocked = rows.find((row) => row.blockingPids.length > 0);
    if (blocked) return blocked;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const waits = await prisma.$queryRaw<{
    pid: number;
    waitEventType: string | null;
    waitEvent: string | null;
    blockingPids: number[];
    query: string;
  }[]>`
    SELECT
      pid,
      wait_event_type AS "waitEventType",
      wait_event AS "waitEvent",
      pg_blocking_pids(pid) AS "blockingPids",
      query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state <> 'idle'
  `;
  throw new Error(`No PostgreSQL lock wait observed for ${fragment}: ${JSON.stringify(waits)}`);
}

type PausedTransactionLock = {
  acquired: Promise<number>;
  resume(): void;
  restore(): void;
};

function rawQueryText(value: unknown): string {
  if (Array.isArray(value)) return value.join("");
  if (value && typeof value === "object" && "strings" in value) {
    const strings = (value as { strings?: unknown }).strings;
    if (Array.isArray(strings)) return strings.join("");
  }
  return "";
}

function pauseAfterTransactionLock(fragment: string): PausedTransactionLock {
  let acquired!: (pid: number) => void;
  let resume!: () => void;
  const acquiredPromise = new Promise<number>((resolve) => { acquired = resolve; });
  const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
  const originalTransaction = prisma.$transaction.bind(prisma);
  let paused = false;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
    const operation = args[0];
    if (typeof operation !== "function") {
      return (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(...args);
    }
    return (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(
      async (tx: Prisma.TransactionClient) => {
        const proxied = new Proxy(tx, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "$queryRaw" || typeof value !== "function") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...queryArgs: unknown[]) => {
              const result = await (value as (...rawArgs: unknown[]) => Promise<unknown>).apply(target, queryArgs);
              if (!paused && rawQueryText(queryArgs[0]).includes(fragment)) {
                paused = true;
                const pids = await target.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                acquired(pids[0]?.pid ?? -1);
                await resumePromise;
              }
              return result;
            };
          },
        });
        return (operation as (client: Prisma.TransactionClient) => Promise<unknown>)(proxied);
      },
      args[1],
    );
  }) as typeof prisma.$transaction);
  return { acquired: acquiredPromise, resume, restore: () => spy.mockRestore() };
}

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
  const now = new Date();
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `${businessProfileId}/mocked-${suffix}.jpg`,
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

async function providerBudgetPair(businessProfileId: number, reservedUnits: number, now: Date) {
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const cycleEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resource = await prisma.externalProviderBudget.create({
    data: {
      businessProfileId: null,
      scope: "RESOURCE",
      provider: "gemini",
      unitType: "DOCUMENT",
      cycleStart,
      cycleEnd,
      limitUnits: 20,
      reservedUnits,
    },
  });
  const business = await prisma.externalProviderBudget.create({
    data: {
      businessProfileId,
      scope: "BUSINESS",
      provider: "gemini",
      unitType: "DOCUMENT",
      cycleStart,
      cycleEnd,
      limitUnits: 20,
      reservedUnits,
    },
  });
  return { resource, business, cycleStart };
}

async function seededProviderDispatch(input: {
  businessProfileId: number;
  receiptScanId: number;
  consentId: number;
  resourceBudgetId: number;
  businessBudgetId: number;
  cycleStart: Date;
  status: "RESERVED" | "SUBMITTED";
  createdAt: Date;
  submittedAt?: Date;
}) {
  reconciliationSeed += 1;
  return prisma.externalProviderDispatch.create({
    data: {
      businessProfileId: input.businessProfileId,
      receiptScanId: input.receiptScanId,
      receiptScanBusinessProfileId: input.businessProfileId,
      consentId: input.consentId,
      resourceBudgetId: input.resourceBudgetId,
      resourceBudgetScope: "RESOURCE",
      businessBudgetId: input.businessBudgetId,
      businessBudgetScope: "BUSINESS",
      businessBudgetProfileId: input.businessProfileId,
      provider: "gemini",
      providerVersion: "gemini-3.5-flash-lite",
      providerRegion: "global",
      unitType: "DOCUMENT",
      cycleStart: input.cycleStart,
      reservationKeyHash: createHash("sha256").update(`reconciliation-reservation-${reconciliationSeed}`).digest("hex"),
      inputHash: createHash("sha256").update(`reconciliation-input-${reconciliationSeed}`).digest("hex"),
      preprocessingVersion: "preprocess-v1",
      schemaVersion: "normalized-v1",
      rescueReasonCode: "LOCAL_VALIDATION_FAILED",
      reservedUnits: 2,
      pageCount: 1,
      documentCount: 1,
      status: input.status,
      submittedAt: input.status === "SUBMITTED" ? input.submittedAt : null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  });
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

  it("cancels a reserved dispatch when receipt deletion commits before provider submission", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "delete-before-submit");
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: {
        processingWorkerId: "receipt-worker-a",
        processingAttemptCount: 1,
        processingStartedAt: new Date(),
        processingHeartbeatAt: new Date(),
      },
    });
    const mockedAdapter = adapter();
    const loadBytes = vi.fn(async () => {
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "RESERVED" });
      await requestReceiptScanDeletion(owner.user.id, scan.id, "delete-before-provider-submit");
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
        confirmationStatus: "Deletion Pending",
        processingStatus: "Failed",
        evidenceDeletionRequestedAt: expect.any(Date),
      });
      return MOCK_PROVIDER_BYTES;
    });
    const input = dispatchInput(owner.profile.id, scan.id, {
      processingLease: { workerId: "receipt-worker-a", attempt: 1 },
    });
    input.pages[0]!.loadBytes = loadBytes;

    const result = await dispatchReceiptProviderRescue(input, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false, dispatchStatus: "SKIPPED" });
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
      status: "CANCELLED",
      finalBillableUnits: 0,
    });
    expect(await prisma.receiptPurgeJob.findFirst({ where: { receiptScanId: scan.id } })).toMatchObject({
      status: "PENDING",
      mode: "DELETE_SCAN",
    });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(0);
      expect(budget.usedUnits).toBe(0);
    }
  });

  it("linearizes deletion first while provider submission is waiting on the receipt row lock", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "postgres-deletion-first");
    const mockedAdapter = adapter();
    let evidenceLoadStarted!: () => void;
    let allowEvidenceLoad!: () => void;
    const evidenceLoadStartedPromise = new Promise<void>((resolve) => { evidenceLoadStarted = resolve; });
    const allowEvidenceLoadPromise = new Promise<void>((resolve) => { allowEvidenceLoad = resolve; });
    const input = dispatchInput(owner.profile.id, scan.id);
    input.pages[0]!.loadBytes = vi.fn(async () => {
      evidenceLoadStarted();
      await allowEvidenceLoadPromise;
      return MOCK_PROVIDER_BYTES;
    });
    let pause: PausedTransactionLock | undefined;
    let pendingDeletion: ReturnType<typeof requestReceiptScanDeletion> | undefined;
    let pendingDispatch: ReturnType<typeof dispatchReceiptProviderRescue> | undefined;

    try {
      pendingDispatch = dispatchReceiptProviderRescue(input, {
        adapter: mockedAdapter,
        configuration: getReceiptProviderConfiguration(),
      });
      await evidenceLoadStartedPromise;
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "RESERVED" });

      pause = pauseAfterTransactionLock('profile."User_ID"');
      pendingDeletion = requestReceiptScanDeletion(owner.user.id, scan.id, "postgres-deletion-first");
      const deletionPid = await pause.acquired;
      allowEvidenceLoad();
      const providerWait = await waitForBlockedQuery('profile."BusinessProfile_ArchivedAt"');
      expect(providerWait.blockingPids).toContain(deletionPid);
      expect(mockedAdapter.extract).not.toHaveBeenCalled();

      pause.resume();
      const [deletion, dispatch] = await Promise.all([pendingDeletion, pendingDispatch]);

      expect(deletion).toMatchObject({ status: "PENDING", mode: "DELETE_SCAN" });
      expect(dispatch).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false, dispatchStatus: "SKIPPED" });
      expect(mockedAdapter.extract).not.toHaveBeenCalled();
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
        status: "CANCELLED",
        finalBillableUnits: 0,
      });
      for (const budget of await prisma.externalProviderBudget.findMany()) {
        expect(budget.reservedUnits).toBe(0);
        expect(budget.usedUnits).toBe(0);
      }
    } finally {
      allowEvidenceLoad();
      pause?.resume();
      await Promise.allSettled([pendingDeletion, pendingDispatch].filter(Boolean) as Promise<unknown>[]);
      pause?.restore();
    }
  });

  it("linearizes provider submission first while deletion is waiting on the receipt row lock", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "postgres-provider-first");
    const mockedAdapter = adapter();
    const pause = pauseAfterTransactionLock('profile."BusinessProfile_ArchivedAt"');
    let pendingDeletion: ReturnType<typeof requestReceiptScanDeletion> | undefined;
    let pendingDispatch: ReturnType<typeof dispatchReceiptProviderRescue> | undefined;

    try {
      pendingDispatch = dispatchReceiptProviderRescue(dispatchInput(owner.profile.id, scan.id), {
        adapter: mockedAdapter,
        configuration: getReceiptProviderConfiguration(),
      });
      const providerPid = await pause.acquired;

      pendingDeletion = requestReceiptScanDeletion(owner.user.id, scan.id, "postgres-provider-first");
      const deletionWait = await waitForBlockedQuery('profile."User_ID"');
      expect(deletionWait.blockingPids).toContain(providerPid);
      expect(mockedAdapter.extract).not.toHaveBeenCalled();

      pause.resume();
      const [dispatch, deletion] = await Promise.all([pendingDispatch, pendingDeletion]);

      expect(dispatch).toMatchObject({ code: "PROVIDER_OK", dispatched: true, dispatchStatus: "SUCCEEDED" });
      expect(deletion).toMatchObject({ status: "PENDING", mode: "DELETE_SCAN" });
      expect(mockedAdapter.extract).toHaveBeenCalledTimes(1);
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
        status: "SUCCEEDED",
        finalBillableUnits: 2,
      });
      for (const budget of await prisma.externalProviderBudget.findMany()) {
        expect(budget.reservedUnits).toBe(0);
        expect(budget.usedUnits).toBe(2);
      }
    } finally {
      pause.resume();
      await Promise.allSettled([pendingDeletion, pendingDispatch].filter(Boolean) as Promise<unknown>[]);
      pause.restore();
    }
  });

  it("idempotently reconciles stale dispatches without releasing possibly billable submissions", async () => {
    const now = new Date();
    const staleAt = new Date(now.getTime() - RECEIPT_PROVIDER_DISPATCH_STALE_MS - 1_000);
    const freshAt = new Date(now.getTime() - RECEIPT_PROVIDER_DISPATCH_STALE_MS + 60_000);
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const consent = await prisma.externalProcessingConsent.findFirstOrThrow({
      where: { businessProfileId: owner.profile.id, revokedAt: null },
    });
    const [abandonedScan, submittedScan, activeScan, freshReservationScan] = await Promise.all([
      scanFor(owner.profile.id, "reconcile-abandoned"),
      scanFor(owner.profile.id, "reconcile-submitted"),
      scanFor(owner.profile.id, "reconcile-active"),
      scanFor(owner.profile.id, "reconcile-fresh"),
    ]);
    await prisma.receiptScan.updateMany({
      where: { id: { in: [abandonedScan.id, submittedScan.id, freshReservationScan.id] } },
      data: { processingStartedAt: staleAt, processingHeartbeatAt: staleAt },
    });
    await prisma.receiptScan.update({
      where: { id: activeScan.id },
      data: { processingStartedAt: now, processingHeartbeatAt: now },
    });
    const budgets = await providerBudgetPair(owner.profile.id, 8, now);
    const abandoned = await seededProviderDispatch({
      businessProfileId: owner.profile.id,
      receiptScanId: abandonedScan.id,
      consentId: consent.id,
      resourceBudgetId: budgets.resource.id,
      businessBudgetId: budgets.business.id,
      cycleStart: budgets.cycleStart,
      status: "RESERVED",
      createdAt: staleAt,
    });
    const submitted = await seededProviderDispatch({
      businessProfileId: owner.profile.id,
      receiptScanId: submittedScan.id,
      consentId: consent.id,
      resourceBudgetId: budgets.resource.id,
      businessBudgetId: budgets.business.id,
      cycleStart: budgets.cycleStart,
      status: "SUBMITTED",
      createdAt: new Date(staleAt.getTime() - 1_000),
      submittedAt: staleAt,
    });
    const active = await seededProviderDispatch({
      businessProfileId: owner.profile.id,
      receiptScanId: activeScan.id,
      consentId: consent.id,
      resourceBudgetId: budgets.resource.id,
      businessBudgetId: budgets.business.id,
      cycleStart: budgets.cycleStart,
      status: "RESERVED",
      createdAt: staleAt,
    });
    const fresh = await seededProviderDispatch({
      businessProfileId: owner.profile.id,
      receiptScanId: freshReservationScan.id,
      consentId: consent.id,
      resourceBudgetId: budgets.resource.id,
      businessBudgetId: budgets.business.id,
      cycleStart: budgets.cycleStart,
      status: "RESERVED",
      createdAt: freshAt,
    });

    vi.stubEnv("RECEIPT_PROVIDER_DISPATCH_ENABLED", "false");
    expect(getReceiptProviderConfiguration().operational).toBe(false);
    const passes = await Promise.all(Array.from({ length: 6 }, () => reconcileStaleReceiptProviderDispatches(now)));
    expect(passes.reduce((total, pass) => total + pass.cancelled, 0)).toBe(1);
    expect(passes.reduce((total, pass) => total + pass.ambiguous, 0)).toBe(1);
    expect(await reconcileStaleReceiptProviderDispatches(now)).toEqual({ cancelled: 0, ambiguous: 0 });

    expect(await prisma.externalProviderDispatch.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({
      status: "CANCELLED",
      outcomeCode: "RECONCILED_STALE_RESERVATION",
      finalBillableUnits: 0,
      completedAt: now,
    });
    expect(await prisma.externalProviderDispatch.findUniqueOrThrow({ where: { id: submitted.id } })).toMatchObject({
      status: "AMBIGUOUS",
      outcomeCode: "RECONCILED_STALE_SUBMISSION",
      finalBillableUnits: null,
      completedAt: now,
    });
    expect(await prisma.externalProviderDispatch.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({
      status: "RESERVED",
      completedAt: null,
    });
    expect(await prisma.externalProviderDispatch.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({
      status: "RESERVED",
      completedAt: null,
    });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(6);
      expect(budget.usedUnits).toBe(0);
      expect(budget.reservedUnits).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects an unclaimed attempt-zero scan even when a caller supplies a nullable lease", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "unclaimed-attempt-zero");
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: {
        processingWorkerId: null,
        processingAttemptCount: 0,
        processingStartedAt: null,
        processingHeartbeatAt: null,
      },
    });
    const mockedAdapter = adapter();
    const loadBytes = vi.fn(async () => MOCK_PROVIDER_BYTES);
    const validInput = dispatchInput(owner.profile.id, scan.id);
    validInput.pages[0]!.loadBytes = loadBytes;
    const malformedInput = { ...validInput, processingLease: null } as unknown as ReceiptProviderDispatchInput;

    const result = await dispatchReceiptProviderRescue(malformedInput, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_EVIDENCE_INVALID", dispatched: false });
    expect(loadBytes).not.toHaveBeenCalled();
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
  });

  it("refuses an expired processing heartbeat before reserving or loading evidence", async () => {
    const now = new Date();
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "expired-heartbeat");
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: {
        processingStartedAt: new Date(now.getTime() - RECEIPT_PROCESSING_LEASE_MS - 1),
        processingHeartbeatAt: new Date(now.getTime() - RECEIPT_PROCESSING_LEASE_MS - 1),
      },
    });
    const mockedAdapter = adapter();
    const loadBytes = vi.fn(async () => MOCK_PROVIDER_BYTES);
    const input = dispatchInput(owner.profile.id, scan.id);
    input.pages[0]!.loadBytes = loadBytes;

    const result = await dispatchReceiptProviderRescue(input, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
      now: () => now,
    });

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false });
    expect(loadBytes).not.toHaveBeenCalled();
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
  });

  it("cancels a reservation when the processing heartbeat expires while evidence loads", async () => {
    let now = new Date();
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "heartbeat-expires-before-submit");
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: { processingStartedAt: now, processingHeartbeatAt: now },
    });
    const mockedAdapter = adapter();
    const loadBytes = vi.fn(async () => {
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "RESERVED" });
      now = new Date(now.getTime() + RECEIPT_PROCESSING_LEASE_MS + 1);
      return MOCK_PROVIDER_BYTES;
    });
    const input = dispatchInput(owner.profile.id, scan.id);
    input.pages[0]!.loadBytes = loadBytes;

    const result = await dispatchReceiptProviderRescue(input, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
      now: () => now,
    });

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false });
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
      status: "CANCELLED",
      finalBillableUnits: 0,
    });
    for (const budget of await prisma.externalProviderBudget.findMany()) {
      expect(budget.reservedUnits).toBe(0);
      expect(budget.usedUnits).toBe(0);
    }
  });

  it("refuses a stale processing lease before reserving or loading evidence", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "stale-worker-lease");
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: {
        processingWorkerId: "receipt-worker-b",
        processingAttemptCount: 2,
        processingStartedAt: new Date(),
        processingHeartbeatAt: new Date(),
      },
    });
    const mockedAdapter = adapter();
    const loadBytes = vi.fn(async () => MOCK_PROVIDER_BYTES);
    const input = dispatchInput(owner.profile.id, scan.id, {
      processingLease: { workerId: "receipt-worker-a", attempt: 1 },
    });
    input.pages[0]!.loadBytes = loadBytes;

    const result = await dispatchReceiptProviderRescue(input, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false });
    expect(loadBytes).not.toHaveBeenCalled();
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.count()).toBe(0);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
  });

  it("cancels a reservation when the processing lease is lost while evidence loads", async () => {
    const owner = await makeOwnerWithProfile();
    await grantReceiptProviderConsent(owner.user.id, owner.profile.id, consentTerms());
    const scan = await scanFor(owner.profile.id, "lease-lost-before-submit");
    await prisma.receiptScan.update({
      where: { id: scan.id },
      data: {
        processingWorkerId: "receipt-worker-a",
        processingAttemptCount: 1,
        processingStartedAt: new Date(),
        processingHeartbeatAt: new Date(),
      },
    });
    const mockedAdapter = adapter();
    const loadBytes = vi.fn(async () => {
      expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({ status: "RESERVED" });
      await prisma.receiptScan.update({
        where: { id: scan.id },
        data: {
          processingWorkerId: "receipt-worker-b",
          processingAttemptCount: 2,
          processingStartedAt: new Date(),
          processingHeartbeatAt: new Date(),
        },
      });
      return MOCK_PROVIDER_BYTES;
    });
    const input = dispatchInput(owner.profile.id, scan.id, {
      processingLease: { workerId: "receipt-worker-a", attempt: 1 },
    });
    input.pages[0]!.loadBytes = loadBytes;

    const result = await dispatchReceiptProviderRescue(input, {
      adapter: mockedAdapter,
      configuration: getReceiptProviderConfiguration(),
    });

    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: false });
    expect(mockedAdapter.extract).not.toHaveBeenCalled();
    expect(await prisma.externalProviderDispatch.findFirst()).toMatchObject({
      status: "CANCELLED",
      finalBillableUnits: 0,
    });
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
