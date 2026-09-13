import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import {
  getReceiptProviderConfiguration,
  type ReceiptProviderConfiguration,
} from "../config/receiptProvider";
import {
  RECEIPT_PROVIDER_CONTRACT_VERSION,
  mergeReceiptProviderOutcome,
  parseReceiptProviderRequest,
  validateReceiptProviderOutcome,
  type NormalizedReceiptExtraction,
  type ProviderDataClass,
  type ProviderMergeResult,
  type ReceiptProviderAdapter,
  type ReceiptProviderOutcome,
  normalizedReceiptExtractionSchema,
} from "./receiptProviderContract";
import { rescueDecisionSchema, type RescueDecision } from "./receiptRescueDecision";
import {
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "../lib/receiptUploadContract";

export type ReceiptProviderGateCode =
  | "PROVIDER_NOT_REQUESTED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_CONSENT_REQUIRED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_DISPATCH_ALREADY_ATTEMPTED"
  | "PROVIDER_EVIDENCE_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RESULT_REJECTED"
  | "PROVIDER_OK";

export interface ReceiptProviderEvidenceReference {
  pageNumber: number;
  dataClass: ProviderDataClass;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  inputSha256: string;
  loadBytes(): Promise<Buffer>;
}

export interface ReceiptProviderDispatchInput {
  businessProfileId: number;
  receiptScanId: number;
  rescueDecision: RescueDecision;
  localExtraction: NormalizedReceiptExtraction;
  pages: ReceiptProviderEvidenceReference[];
  preprocessingVersion: string;
  normalizedSchemaVersion: string;
}

export interface ReceiptProviderDispatchDependencies {
  adapter: ReceiptProviderAdapter & { readonly providerVersion: string };
  configuration?: ReceiptProviderConfiguration;
  loadConfiguration?: () => ReceiptProviderConfiguration;
  now?: () => Date;
}

export interface ReceiptProviderDispatchResult {
  code: ReceiptProviderGateCode;
  dispatched: boolean;
  dispatchStatus: "SKIPPED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "AMBIGUOUS";
  provider: "gemini" | "veryfi" | null;
  latencyMs: number | null;
  merge: ProviderMergeResult;
}

class GateRefusal extends Error {
  constructor(readonly code: ReceiptProviderGateCode) {
    super(code);
  }
}

type Reservation = {
  id: number;
  consentId: number;
  resourceBudgetId: number;
  businessBudgetId: number | null;
  reservedUnits: number;
  unitType: "PAGE" | "DOCUMENT";
  provider: "gemini" | "veryfi";
  cycleStart: Date;
  businessProfileId: number;
  status: "RESERVED" | "SUBMITTED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "AMBIGUOUS";
};

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cycleAt(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function skipped(local: NormalizedReceiptExtraction, code: ReceiptProviderGateCode): ReceiptProviderDispatchResult {
  return {
    code,
    dispatched: false,
    dispatchStatus: "SKIPPED",
    provider: null,
    latencyMs: null,
    merge: {
      receipt: local,
      appliedFields: [],
      providerResultAccepted: false,
      reason: "NOT_SUCCESSFUL",
    },
  };
}

function configurationReady(
  config: ReceiptProviderConfiguration,
  input: ReceiptProviderDispatchInput,
  adapter: ReceiptProviderDispatchDependencies["adapter"],
): config is ReceiptProviderConfiguration & {
  provider: "gemini" | "veryfi";
  providerVersion: string;
  providerRegion: string;
  providerRetentionHours: number;
  calibrationVersion: string;
  unitType: "PAGE" | "DOCUMENT";
} {
  return Boolean(
    config.operational &&
      config.provider &&
      config.providerVersion &&
      config.providerRegion &&
      config.providerRetentionHours !== null &&
      config.calibrationVersion &&
      config.unitType &&
      adapter.provider === config.provider &&
      adapter.providerVersion === config.providerVersion &&
      input.rescueDecision.providerRescueRequested &&
      input.rescueDecision.calibration.state === "CALIBRATED" &&
      input.rescueDecision.calibration.version === config.calibrationVersion,
  );
}

function evidenceMetadataValid(pages: ReceiptProviderEvidenceReference[]): boolean {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) return false;
  const pageNumbers = new Set<number>();
  return pages.every((page, index) => {
    if (!page || typeof page !== "object" || typeof page.loadBytes !== "function") return false;
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
      return false;
    }
    if (pageNumbers.has(page.pageNumber) || page.pageNumber !== index + 1) return false;
    pageNumbers.add(page.pageNumber);
    return (
      /^[a-f0-9]{64}$/.test(page.inputSha256) &&
      (page.dataClass === "RECEIPT_IMAGE" || page.dataClass === "DERIVED_RECEIPT_IMAGE") &&
      (page.mediaType === "image/jpeg" || page.mediaType === "image/png" || page.mediaType === "image/webp")
    );
  });
}

function dispatchMetadataValid(input: ReceiptProviderDispatchInput): boolean {
  return (
    Number.isSafeInteger(input.businessProfileId) &&
    input.businessProfileId > 0 &&
    Number.isSafeInteger(input.receiptScanId) &&
    input.receiptScanId > 0 &&
    /^[A-Za-z0-9._:-]{1,64}$/.test(input.preprocessingVersion) &&
    /^[A-Za-z0-9._:-]{1,64}$/.test(input.normalizedSchemaVersion)
  );
}

async function ensureBudget(
  tx: Prisma.TransactionClient,
  input: {
    businessProfileId: number | null;
    scope: "RESOURCE" | "BUSINESS";
    provider: "gemini" | "veryfi";
    unitType: "PAGE" | "DOCUMENT";
    cycleStart: Date;
    cycleEnd: Date;
    limitUnits: number;
  },
) {
  let budget = await tx.externalProviderBudget.findFirst({
    where: {
      businessProfileId: input.businessProfileId,
      scope: input.scope,
      provider: input.provider,
      unitType: input.unitType,
      cycleStart: input.cycleStart,
    },
  });
  if (!budget) {
    budget = await tx.externalProviderBudget.create({ data: input });
  }
  if (budget.limitUnits !== input.limitUnits) {
    const updated = await tx.$executeRaw`
      UPDATE "ExternalProviderBudget"
      SET "ExternalProviderBudget_LimitUnits" = ${input.limitUnits},
          "ExternalProviderBudget_UpdatedAt" = CURRENT_TIMESTAMP
      WHERE "ExternalProviderBudget_ID" = ${budget.id}
        AND "ExternalProviderBudget_Scope" = CAST(${input.scope} AS "ExternalProviderBudgetScope")
        AND "ExternalProviderBudget_Provider" = ${input.provider}
        AND "ExternalProviderBudget_UnitType" = CAST(${input.unitType} AS "ExternalProviderUnitType")
        AND "ExternalProviderBudget_CycleStart" = CAST(${input.cycleStart} AS DATE)
        AND "BusinessProfile_ID" IS NOT DISTINCT FROM CAST(${input.businessProfileId} AS INTEGER)
        AND "ExternalProviderBudget_ReservedUnits" + "ExternalProviderBudget_UsedUnits" <= ${input.limitUnits}
    `;
    if (updated !== 1) throw new GateRefusal("PROVIDER_QUOTA_EXHAUSTED");
  }
  return budget;
}

async function incrementReservation(
  tx: Prisma.TransactionClient,
  budget: {
    id: number;
    businessProfileId: number | null;
    scope: "RESOURCE" | "BUSINESS";
    provider: string;
    unitType: "PAGE" | "DOCUMENT" | "IMAGE_FEATURE";
    cycleStart: Date;
  },
  requestedUnits: number,
): Promise<void> {
  const updated = await tx.$executeRaw`
    UPDATE "ExternalProviderBudget"
    SET "ExternalProviderBudget_ReservedUnits" = "ExternalProviderBudget_ReservedUnits" + ${requestedUnits},
        "ExternalProviderBudget_UpdatedAt" = CURRENT_TIMESTAMP
    WHERE "ExternalProviderBudget_ID" = ${budget.id}
      AND "ExternalProviderBudget_Scope" = CAST(${budget.scope} AS "ExternalProviderBudgetScope")
      AND "ExternalProviderBudget_Provider" = ${budget.provider}
      AND "ExternalProviderBudget_UnitType" = CAST(${budget.unitType} AS "ExternalProviderUnitType")
      AND "ExternalProviderBudget_CycleStart" = CAST(${budget.cycleStart} AS DATE)
      AND "BusinessProfile_ID" IS NOT DISTINCT FROM CAST(${budget.businessProfileId} AS INTEGER)
      AND "ExternalProviderBudget_ReservedUnits"
          <= "ExternalProviderBudget_LimitUnits" - "ExternalProviderBudget_UsedUnits" - ${requestedUnits}
  `;
  if (updated !== 1) throw new GateRefusal("PROVIDER_QUOTA_EXHAUSTED");
}

async function reserve(
  input: ReceiptProviderDispatchInput,
  config: ReceiptProviderConfiguration & {
    provider: "gemini" | "veryfi";
    providerVersion: string;
    providerRegion: string;
    providerRetentionHours: number;
    calibrationVersion: string;
    unitType: "PAGE" | "DOCUMENT";
  },
  reservationKeyHash: string,
  inputHash: string,
  now: Date,
): Promise<Reservation> {
  const existing = await prisma.externalProviderDispatch.findUnique({ where: { reservationKeyHash } });
  if (existing) {
    if (
      existing.businessProfileId !== input.businessProfileId ||
      existing.receiptScanId !== input.receiptScanId ||
      existing.inputHash !== inputHash ||
      existing.provider !== config.provider ||
      existing.status !== "RESERVED"
    ) {
      throw new GateRefusal("PROVIDER_DISPATCH_ALREADY_ATTEMPTED");
    }
    return existing as Reservation;
  }

  const { start, end } = cycleAt(now);
  const reservedUnits = config.provider === "veryfi" ? input.pages.length : 2;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const receipt = await tx.receiptScan.findFirst({
            where: {
              id: input.receiptScanId,
              businessProfileId: input.businessProfileId,
              businessProfile: { archivedAt: null },
            },
            select: { id: true },
          });
          if (!receipt) throw new GateRefusal("PROVIDER_UNAVAILABLE");
          const consent = await tx.externalProcessingConsent.findFirst({
            where: {
              businessProfileId: input.businessProfileId,
              provider: config.provider,
              policyVersion: config.policyVersion,
              purpose: "RECEIPT_EXTRACTION",
              allowedDataClasses: { equals: [...config.allowedDataClasses] },
              processingRegion: config.providerRegion,
              providerRetentionHours: config.providerRetentionHours,
              providerTrainingAllowed: false,
              revokedAt: null,
            },
            orderBy: { id: "desc" },
          });
          if (!consent) throw new GateRefusal("PROVIDER_CONSENT_REQUIRED");

          const resource = await ensureBudget(tx, {
            businessProfileId: null,
            scope: "RESOURCE",
            provider: config.provider,
            unitType: config.unitType,
            cycleStart: start,
            cycleEnd: end,
            limitUnits: config.resourceMonthlyUnitLimit,
          });
          await incrementReservation(tx, resource, reservedUnits);

          let businessBudgetId: number | null = null;
          if (config.businessMonthlyUnitLimit !== null) {
            const business = await ensureBudget(tx, {
              businessProfileId: input.businessProfileId,
              scope: "BUSINESS",
              provider: config.provider,
              unitType: config.unitType,
              cycleStart: start,
              cycleEnd: end,
              limitUnits: config.businessMonthlyUnitLimit,
            });
            await incrementReservation(tx, business, reservedUnits);
            businessBudgetId = business.id;
          }

          const dispatch = await tx.externalProviderDispatch.create({
            data: {
              businessProfileId: input.businessProfileId,
              receiptScanId: input.receiptScanId,
              receiptScanBusinessProfileId: input.businessProfileId,
              consentId: consent.id,
              resourceBudgetId: resource.id,
              resourceBudgetScope: "RESOURCE",
              businessBudgetId,
              businessBudgetScope: businessBudgetId ? "BUSINESS" : null,
              businessBudgetProfileId: businessBudgetId ? input.businessProfileId : null,
              provider: config.provider,
              providerVersion: config.providerVersion,
              providerRegion: config.providerRegion,
              unitType: config.unitType,
              cycleStart: start,
              reservationKeyHash,
              inputHash,
              preprocessingVersion: input.preprocessingVersion,
              schemaVersion: input.normalizedSchemaVersion,
              rescueReasonCode: input.rescueDecision.reasons[0] ?? "LOCAL_VALIDATION_FAILED",
              reservedUnits,
              pageCount: input.pages.length,
              documentCount: 1,
              status: "RESERVED",
            },
          });
          return dispatch as Reservation;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof GateRefusal) throw error;
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");
      if (!retryable || attempt === 2) throw error;
      const raced = await prisma.externalProviderDispatch.findUnique({ where: { reservationKeyHash } });
      if (raced) {
        if (raced.status !== "RESERVED") throw new GateRefusal("PROVIDER_DISPATCH_ALREADY_ATTEMPTED");
        return raced as Reservation;
      }
    }
  }
  throw new GateRefusal("PROVIDER_UNAVAILABLE");
}

async function releaseOrConsume(
  reservation: Reservation,
  outcome: ReceiptProviderOutcome,
  now: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (outcome.status !== "AMBIGUOUS") {
      const finalUnits = outcome.finalBillableUnits;
      const release = async (budgetId: number, scope: "RESOURCE" | "BUSINESS", profileId: number | null) => {
        const changed = await tx.$executeRaw`
          UPDATE "ExternalProviderBudget"
          SET "ExternalProviderBudget_ReservedUnits" = "ExternalProviderBudget_ReservedUnits" - ${reservation.reservedUnits},
              "ExternalProviderBudget_UsedUnits" = "ExternalProviderBudget_UsedUnits" + ${finalUnits},
              "ExternalProviderBudget_UpdatedAt" = CURRENT_TIMESTAMP
          WHERE "ExternalProviderBudget_ID" = ${budgetId}
            AND "ExternalProviderBudget_Scope" = CAST(${scope} AS "ExternalProviderBudgetScope")
            AND "ExternalProviderBudget_Provider" = ${reservation.provider}
            AND "ExternalProviderBudget_UnitType" = CAST(${reservation.unitType} AS "ExternalProviderUnitType")
            AND "ExternalProviderBudget_CycleStart" = CAST(${reservation.cycleStart} AS DATE)
            AND "BusinessProfile_ID" IS NOT DISTINCT FROM CAST(${profileId} AS INTEGER)
            AND "ExternalProviderBudget_ReservedUnits" >= ${reservation.reservedUnits}
        `;
        if (changed !== 1) throw new GateRefusal("PROVIDER_UNAVAILABLE");
      };
      await release(reservation.resourceBudgetId, "RESOURCE", null);
      if (reservation.businessBudgetId !== null) {
        await release(reservation.businessBudgetId, "BUSINESS", reservation.businessProfileId);
      }
    }
    const changed = await tx.externalProviderDispatch.updateMany({
      where: { id: reservation.id, status: outcome.status === "CANCELLED" ? "RESERVED" : "SUBMITTED" },
      data: {
        status: outcome.status,
        outcomeCode: outcome.outcomeCode,
        finalBillableUnits: outcome.finalBillableUnits,
        providerRequestIdHash: outcome.providerRequestIdHash,
        latencyMs: outcome.latencyMs,
        completedAt: now,
      },
    });
    if (changed.count !== 1) throw new GateRefusal("PROVIDER_DISPATCH_ALREADY_ATTEMPTED");
  });
}

async function markFinalizationAmbiguous(reservation: Reservation, latencyMs: number, now: Date): Promise<void> {
  await prisma.externalProviderDispatch.updateMany({
    where: { id: reservation.id, status: "SUBMITTED" },
    data: {
      status: "AMBIGUOUS",
      outcomeCode: "FINALIZATION_UNKNOWN",
      finalBillableUnits: null,
      latencyMs,
      completedAt: now,
    },
  });
}

function cancelledOutcome(
  reservation: Reservation,
  config: ReceiptProviderConfiguration & { provider: "gemini" | "veryfi"; providerVersion: string; providerRegion: string },
  latencyMs: number,
): ReceiptProviderOutcome {
  return {
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider: config.provider,
    providerVersion: config.providerVersion,
    providerRegion: config.providerRegion,
    dispatchReference: `dispatch:${reservation.id}`,
    providerRequestIdHash: null,
    latencyMs,
    status: "CANCELLED",
    timeoutOutcome: "BEFORE_SUBMISSION",
    outcomeCode: "TIMEOUT_BEFORE_SUBMISSION",
    finalBillableUnits: 0,
    extraction: null,
  };
}

function ambiguousOutcome(
  reservation: Reservation,
  config: ReceiptProviderConfiguration & { provider: "gemini" | "veryfi"; providerVersion: string; providerRegion: string },
  latencyMs: number,
): ReceiptProviderOutcome {
  return {
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider: config.provider,
    providerVersion: config.providerVersion,
    providerRegion: config.providerRegion,
    dispatchReference: `dispatch:${reservation.id}`,
    providerRequestIdHash: null,
    latencyMs,
    status: "AMBIGUOUS",
    timeoutOutcome: "AFTER_SUBMISSION_UNKNOWN",
    outcomeCode: "TIMEOUT_AFTER_SUBMISSION",
    finalBillableUnits: null,
    extraction: null,
  };
}

function invalidOutcome(
  reservation: Reservation,
  config: ReceiptProviderConfiguration & { provider: "gemini" | "veryfi"; providerVersion: string; providerRegion: string },
  latencyMs: number,
): ReceiptProviderOutcome {
  return {
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider: config.provider,
    providerVersion: config.providerVersion,
    providerRegion: config.providerRegion,
    dispatchReference: `dispatch:${reservation.id}`,
    providerRequestIdHash: null,
    latencyMs,
    status: "FAILED",
    timeoutOutcome: "NOT_TIMED_OUT",
    outcomeCode: "INVALID_RESULT",
    finalBillableUnits: reservation.reservedUnits,
    extraction: null,
  };
}

/** The only route from a receipt worker to an external extraction provider. */
export async function dispatchReceiptProviderRescue(
  input: ReceiptProviderDispatchInput,
  dependencies: ReceiptProviderDispatchDependencies,
): Promise<ReceiptProviderDispatchResult> {
  if (!dispatchMetadataValid(input)) {
    return skipped(input.localExtraction, "PROVIDER_EVIDENCE_INVALID");
  }
  const parsedLocal = normalizedReceiptExtractionSchema.safeParse(input.localExtraction);
  if (!parsedLocal.success || parsedLocal.data.schemaVersion !== input.normalizedSchemaVersion) {
    return skipped(input.localExtraction, "PROVIDER_EVIDENCE_INVALID");
  }
  const localExtraction = parsedLocal.data;
  const parsedDecision = rescueDecisionSchema.safeParse(input.rescueDecision);
  if (!parsedDecision.success || !parsedDecision.data.providerRescueRequested) {
    return skipped(localExtraction, "PROVIDER_NOT_REQUESTED");
  }
  const loadConfiguration =
    dependencies.loadConfiguration ??
    (() => dependencies.configuration ?? getReceiptProviderConfiguration());
  const config = loadConfiguration();
  if (!configurationReady(config, input, dependencies.adapter)) return skipped(localExtraction, "PROVIDER_UNAVAILABLE");
  if (!evidenceMetadataValid(input.pages)) return skipped(localExtraction, "PROVIDER_EVIDENCE_INVALID");

  const inputHash = hash(
    input.pages
      .map((page) => `${page.pageNumber}:${page.dataClass}:${page.mediaType}:${page.inputSha256}`)
      .join("|"),
  );
  const reservationKeyHash = hash(
    [
      input.businessProfileId,
      input.receiptScanId,
      config.provider,
      config.providerVersion,
      config.providerRegion,
      config.policyVersion,
      input.preprocessingVersion,
      input.normalizedSchemaVersion,
      input.rescueDecision.version,
      config.calibrationVersion,
      [...input.rescueDecision.reasons].sort().join(","),
      inputHash,
    ].join(":"),
  );
  const clock = dependencies.now ?? (() => new Date());
  let reservation: Reservation;
  try {
    reservation = await reserve(input, config, reservationKeyHash, inputHash, clock());
  } catch (error) {
    return skipped(localExtraction, error instanceof GateRefusal ? error.code : "PROVIDER_UNAVAILABLE");
  }

  const loadStartedAt = Date.now();
  const pages = [] as {
    pageNumber: number;
    dataClass: ProviderDataClass;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
    inputSha256: string;
    bytes: Uint8Array;
  }[];
  let aggregateBytes = 0;
  try {
    for (const page of input.pages) {
      const bytes = await page.loadBytes();
      aggregateBytes += bytes.byteLength;
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > RECEIPT_UPLOAD_MAX_OBJECT_BYTES ||
        aggregateBytes > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES ||
        hash(bytes) !== page.inputSha256
      ) {
        throw new GateRefusal("PROVIDER_EVIDENCE_INVALID");
      }
      pages.push({
        pageNumber: page.pageNumber,
        dataClass: page.dataClass,
        mediaType: page.mediaType,
        inputSha256: page.inputSha256,
        bytes,
      });
    }
  } catch {
    const outcome = cancelledOutcome(reservation, config, Date.now() - loadStartedAt);
    await releaseOrConsume(reservation, outcome, clock()).catch(() => undefined);
    return skipped(localExtraction, "PROVIDER_EVIDENCE_INVALID");
  }

  let request;
  try {
    request = parseReceiptProviderRequest({
      contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
      provider: config.provider,
      providerVersion: config.providerVersion,
      providerRegion: config.providerRegion,
      normalizedSchemaVersion: input.normalizedSchemaVersion,
      preprocessingVersion: input.preprocessingVersion,
      timeoutMs: config.timeoutMs,
      consent: {
        reference: `consent:${reservation.consentId}`,
        status: "CURRENT",
        provider: config.provider,
        policyVersion: config.policyVersion,
        purpose: config.purpose,
        allowedDataClasses: [...config.allowedDataClasses],
        processingRegion: config.providerRegion,
        providerRetentionHours: config.providerRetentionHours,
        providerTrainingAllowed: false,
      },
      reservation: {
        status: "RESERVED",
        dispatchReference: `dispatch:${reservation.id}`,
        resourceReservationReference: `budget:${reservation.resourceBudgetId}`,
        businessReservationReference: reservation.businessBudgetId ? `budget:${reservation.businessBudgetId}` : null,
        unitType: reservation.unitType,
        reservedUnits: reservation.reservedUnits,
      },
      rescueDecision: input.rescueDecision,
      pages,
    });
  } catch {
    const outcome = cancelledOutcome(reservation, config, Date.now() - loadStartedAt);
    await releaseOrConsume(reservation, outcome, clock()).catch(() => undefined);
    return skipped(localExtraction, "PROVIDER_EVIDENCE_INVALID");
  }

  const currentConfig = loadConfiguration();
  if (
    !configurationReady(currentConfig, input, dependencies.adapter) ||
    currentConfig.provider !== config.provider ||
    currentConfig.providerVersion !== config.providerVersion ||
    currentConfig.providerRegion !== config.providerRegion ||
    currentConfig.policyVersion !== config.policyVersion ||
    currentConfig.providerRetentionHours !== config.providerRetentionHours ||
    currentConfig.calibrationVersion !== config.calibrationVersion ||
    currentConfig.unitType !== config.unitType ||
    currentConfig.resourceMonthlyUnitLimit !== config.resourceMonthlyUnitLimit ||
    currentConfig.businessMonthlyUnitLimit !== config.businessMonthlyUnitLimit
  ) {
    const outcome = cancelledOutcome(reservation, config, Date.now() - loadStartedAt);
    await releaseOrConsume(reservation, outcome, clock()).catch(() => undefined);
    return skipped(localExtraction, "PROVIDER_UNAVAILABLE");
  }

  const submittedAt = clock();
  const submitResult = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number }[]>`
      SELECT "ExternalProcessingConsent_ID" AS id
      FROM "ExternalProcessingConsent"
      WHERE "ExternalProcessingConsent_ID" = ${reservation.consentId}
      FOR UPDATE
    `;
    if (locked.length !== 1) return "CONSENT_REVOKED" as const;
    const consent = await tx.externalProcessingConsent.findFirst({
      where: {
        id: reservation.consentId,
        businessProfileId: input.businessProfileId,
        provider: config.provider,
        policyVersion: config.policyVersion,
        purpose: "RECEIPT_EXTRACTION",
        allowedDataClasses: { equals: [...config.allowedDataClasses] },
        processingRegion: config.providerRegion,
        providerRetentionHours: config.providerRetentionHours,
        providerTrainingAllowed: false,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (!consent) return "CONSENT_REVOKED" as const;
    const changed = await tx.externalProviderDispatch.updateMany({
      where: { id: reservation.id, status: "RESERVED" },
      data: { status: "SUBMITTED", submittedAt },
    });
    return changed.count === 1 ? ("SUBMITTED" as const) : ("RACED" as const);
  });
  if (submitResult === "CONSENT_REVOKED") {
    const outcome = cancelledOutcome(reservation, config, Date.now() - loadStartedAt);
    await releaseOrConsume(reservation, outcome, clock()).catch(() => undefined);
    return skipped(localExtraction, "PROVIDER_CONSENT_REQUIRED");
  }
  if (submitResult === "RACED") return skipped(localExtraction, "PROVIDER_DISPATCH_ALREADY_ATTEMPTED");

  const started = Date.now();
  let rawOutcome: unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    rawOutcome = await Promise.race([
      dependencies.adapter.extract(request),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new GateRefusal("PROVIDER_TIMEOUT")), config.timeoutMs);
        timeout.unref();
      }),
    ]);
  } catch {
    rawOutcome = ambiguousOutcome(reservation, config, Date.now() - started);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const validation = validateReceiptProviderOutcome(request, rawOutcome);
  const outcome =
    validation.ok && validation.outcome.status !== "CANCELLED"
      ? validation.outcome
      : invalidOutcome(reservation, config, Date.now() - started);
  try {
    await releaseOrConsume(reservation, outcome, clock());
  } catch {
    await markFinalizationAmbiguous(reservation, outcome.latencyMs, clock()).catch(() => undefined);
    return {
      ...skipped(localExtraction, "PROVIDER_RESULT_REJECTED"),
      dispatched: true,
      dispatchStatus: "AMBIGUOUS",
      provider: config.provider,
      latencyMs: outcome.latencyMs,
    };
  }

  const merge = mergeReceiptProviderOutcome(localExtraction, request, outcome);
  return {
    code: outcome.status === "SUCCEEDED" ? "PROVIDER_OK" : outcome.status === "AMBIGUOUS" ? "PROVIDER_TIMEOUT" : "PROVIDER_RESULT_REJECTED",
    dispatched: true,
    dispatchStatus: outcome.status,
    provider: config.provider,
    latencyMs: outcome.latencyMs,
    merge,
  };
}
