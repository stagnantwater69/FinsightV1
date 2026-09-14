import { createHash } from "node:crypto";
import { Prisma, ReceiptPurgeMode } from "@prisma/client";
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
import { firstProviderRescueReason, rescueDecisionSchema, type RescueDecision } from "./receiptRescueDecision";
import { grantReceiptProviderConsentByPolicy } from "./receiptProviderConsent.service";
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
  processingLease: {
    workerId: string;
    attempt: number;
  };
  rescueDecision: RescueDecision;
  localExtraction: NormalizedReceiptExtraction;
  pages: ReceiptProviderEvidenceReference[];
  preprocessingVersion: string;
  normalizedSchemaVersion: string;
}

export const RECEIPT_PROCESSING_LEASE_MS = 2 * 60 * 1000;
export const RECEIPT_PROVIDER_DISPATCH_STALE_MS = RECEIPT_PROCESSING_LEASE_MS;
const RECEIPT_PROVIDER_RECONCILIATION_BATCH_SIZE = 50;

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

export interface ReceiptProviderReconciliationResult {
  cancelled: number;
  ambiguous: number;
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

type ReconciliationCandidate = {
  id: number;
  businessProfileId: number;
  receiptScanId: number | null;
  receiptScanBusinessProfileId: number | null;
  resourceBudgetId: number;
  businessBudgetId: number | null;
  provider: string;
  unitType: "PAGE" | "DOCUMENT" | "IMAGE_FEATURE";
  cycleStart: Date;
  reservedUnits: number;
  status: "RESERVED" | "SUBMITTED";
  submittedAt: Date | null;
  createdAt: Date;
};

type ReconciliationOutcome = "NONE" | "CANCELLED" | "AMBIGUOUS";

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
  const lease = input.processingLease;
  return (
    Number.isSafeInteger(input.businessProfileId) &&
    input.businessProfileId > 0 &&
    Number.isSafeInteger(input.receiptScanId) &&
    input.receiptScanId > 0 &&
    Boolean(lease) &&
    (
      typeof lease.workerId === "string" &&
      lease.workerId.length >= 1 &&
      lease.workerId.length <= 100 &&
      Number.isSafeInteger(lease.attempt) &&
      lease.attempt >= 1
    ) &&
    /^[A-Za-z0-9._:-]{1,64}$/.test(input.preprocessingVersion) &&
    /^[A-Za-z0-9._:-]{1,64}$/.test(input.normalizedSchemaVersion)
  );
}

function dispatchableReceiptWhere(input: ReceiptProviderDispatchInput, now: Date): Prisma.ReceiptScanWhereInput {
  return {
    id: input.receiptScanId,
    businessProfileId: input.businessProfileId,
    businessProfile: { archivedAt: null },
    confirmationStatus: "Pending",
    processingStatus: "Processing",
    evidenceDeletionRequestedAt: null,
    purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    processingWorkerId: input.processingLease.workerId,
    processingAttemptCount: input.processingLease.attempt,
    processingHeartbeatAt: { gte: new Date(now.getTime() - RECEIPT_PROCESSING_LEASE_MS) },
  };
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

async function lockReconciliationBudget(
  tx: Prisma.TransactionClient,
  input: {
    id: number;
    scope: "RESOURCE" | "BUSINESS";
    businessProfileId: number | null;
    provider: string;
    unitType: "PAGE" | "DOCUMENT" | "IMAGE_FEATURE";
    cycleStart: Date;
  },
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT "ExternalProviderBudget_ID" AS id
    FROM "ExternalProviderBudget"
    WHERE "ExternalProviderBudget_ID" = ${input.id}
      AND "ExternalProviderBudget_Scope" = CAST(${input.scope} AS "ExternalProviderBudgetScope")
      AND "BusinessProfile_ID" IS NOT DISTINCT FROM CAST(${input.businessProfileId} AS INTEGER)
      AND "ExternalProviderBudget_Provider" = ${input.provider}
      AND "ExternalProviderBudget_UnitType" = CAST(${input.unitType} AS "ExternalProviderUnitType")
      AND "ExternalProviderBudget_CycleStart" = CAST(${input.cycleStart} AS DATE)
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new Error(`Provider reconciliation budget ${input.id} is unavailable`);
}

async function releaseReconciliationBudget(
  tx: Prisma.TransactionClient,
  input: {
    id: number;
    scope: "RESOURCE" | "BUSINESS";
    businessProfileId: number | null;
    provider: string;
    unitType: "PAGE" | "DOCUMENT" | "IMAGE_FEATURE";
    cycleStart: Date;
    reservedUnits: number;
  },
): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE "ExternalProviderBudget"
    SET "ExternalProviderBudget_ReservedUnits" = "ExternalProviderBudget_ReservedUnits" - ${input.reservedUnits},
        "ExternalProviderBudget_UpdatedAt" = CURRENT_TIMESTAMP
    WHERE "ExternalProviderBudget_ID" = ${input.id}
      AND "ExternalProviderBudget_Scope" = CAST(${input.scope} AS "ExternalProviderBudgetScope")
      AND "BusinessProfile_ID" IS NOT DISTINCT FROM CAST(${input.businessProfileId} AS INTEGER)
      AND "ExternalProviderBudget_Provider" = ${input.provider}
      AND "ExternalProviderBudget_UnitType" = CAST(${input.unitType} AS "ExternalProviderUnitType")
      AND "ExternalProviderBudget_CycleStart" = CAST(${input.cycleStart} AS DATE)
      AND "ExternalProviderBudget_ReservedUnits" >= ${input.reservedUnits}
  `;
  if (changed !== 1) throw new Error(`Provider reconciliation budget ${input.id} cannot release reserved units`);
}

function candidateIsStale(candidate: ReconciliationCandidate, cutoff: Date): boolean {
  return candidate.status === "RESERVED"
    ? candidate.createdAt <= cutoff
    : candidate.submittedAt !== null && candidate.submittedAt <= cutoff;
}

async function lockEligibleReceipt(
  tx: Prisma.TransactionClient,
  candidate: ReconciliationCandidate,
  heartbeatCutoff: Date,
): Promise<boolean> {
  if (candidate.receiptScanId === null || candidate.receiptScanBusinessProfileId === null) return false;
  const rows = await tx.$queryRaw<{
    confirmationStatus: string;
    processingStatus: string;
    evidenceDeletionRequestedAt: Date | null;
    processingWorkerId: string | null;
    processingAttemptCount: number;
    processingHeartbeatAt: Date | null;
    profileArchivedAt: Date | null;
    hasDeletePurge: boolean;
  }[]>`
    SELECT
      scan."ReceiptScan_ConfirmationStatus" AS "confirmationStatus",
      scan."ReceiptScan_ProcessingStatus" AS "processingStatus",
      scan."ReceiptScan_EvidenceDeletionRequestedAt" AS "evidenceDeletionRequestedAt",
      scan."ReceiptScan_ProcessingWorkerID" AS "processingWorkerId",
      scan."ReceiptScan_ProcessingAttemptCount" AS "processingAttemptCount",
      scan."ReceiptScan_ProcessingHeartbeatAt" AS "processingHeartbeatAt",
      profile."BusinessProfile_ArchivedAt" AS "profileArchivedAt",
      EXISTS (
        SELECT 1
        FROM "ReceiptPurgeJob" purge
        WHERE purge."ReceiptScan_ID" = scan."ReceiptScan_ID"
          AND purge."ReceiptScan_BusinessProfile_ID" = scan."BusinessProfile_ID"
          AND purge."ReceiptPurgeJob_Mode" = 'DELETE_SCAN'
      ) AS "hasDeletePurge"
    FROM "ReceiptScan" scan
    INNER JOIN "BusinessProfile" profile
      ON profile."BusinessProfile_ID" = scan."BusinessProfile_ID"
    WHERE scan."ReceiptScan_ID" = ${candidate.receiptScanId}
      AND scan."BusinessProfile_ID" = ${candidate.receiptScanBusinessProfileId}
    FOR UPDATE OF scan
  `;
  const receipt = rows[0];
  return Boolean(
    receipt &&
      receipt.profileArchivedAt === null &&
      receipt.confirmationStatus === "Pending" &&
      receipt.processingStatus === "Processing" &&
      receipt.evidenceDeletionRequestedAt === null &&
      receipt.processingWorkerId !== null &&
      receipt.processingAttemptCount >= 1 &&
      receipt.processingHeartbeatAt !== null &&
      receipt.processingHeartbeatAt >= heartbeatCutoff &&
      !receipt.hasDeletePurge,
  );
}

async function reconcileCandidate(
  candidateId: number,
  dispatchCutoff: Date,
  heartbeatCutoff: Date,
  completedAt: Date,
): Promise<ReconciliationOutcome> {
  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.externalProviderDispatch.findFirst({
      where: { id: candidateId, status: { in: ["RESERVED", "SUBMITTED"] } },
      select: {
        id: true,
        businessProfileId: true,
        receiptScanId: true,
        receiptScanBusinessProfileId: true,
        resourceBudgetId: true,
        businessBudgetId: true,
        provider: true,
        unitType: true,
        cycleStart: true,
        reservedUnits: true,
        status: true,
        submittedAt: true,
        createdAt: true,
      },
    });
    if (!snapshot || !candidateIsStale(snapshot as ReconciliationCandidate, dispatchCutoff)) return "NONE";
    const candidate = snapshot as ReconciliationCandidate;

    await lockReconciliationBudget(tx, {
      id: candidate.resourceBudgetId,
      scope: "RESOURCE",
      businessProfileId: null,
      provider: candidate.provider,
      unitType: candidate.unitType,
      cycleStart: candidate.cycleStart,
    });
    if (candidate.businessBudgetId !== null) {
      await lockReconciliationBudget(tx, {
        id: candidate.businessBudgetId,
        scope: "BUSINESS",
        businessProfileId: candidate.businessProfileId,
        provider: candidate.provider,
        unitType: candidate.unitType,
        cycleStart: candidate.cycleStart,
      });
    }

    const eligibleReceipt = candidate.status === "RESERVED"
      ? await lockEligibleReceipt(tx, candidate, heartbeatCutoff)
      : false;
    const lockedRows = await tx.$queryRaw<ReconciliationCandidate[]>`
      SELECT
        "ExternalProviderDispatch_ID" AS id,
        "BusinessProfile_ID" AS "businessProfileId",
        "ReceiptScan_ID" AS "receiptScanId",
        "ReceiptScan_BusinessProfile_ID" AS "receiptScanBusinessProfileId",
        "ExternalProviderDispatch_ResourceBudget_ID" AS "resourceBudgetId",
        "ExternalProviderDispatch_BusinessBudget_ID" AS "businessBudgetId",
        "ExternalProviderDispatch_Provider" AS provider,
        "ExternalProviderDispatch_UnitType" AS "unitType",
        "ExternalProviderDispatch_CycleStart" AS "cycleStart",
        "ExternalProviderDispatch_ReservedUnits" AS "reservedUnits",
        "ExternalProviderDispatch_Status" AS status,
        "ExternalProviderDispatch_SubmittedAt" AS "submittedAt",
        "ExternalProviderDispatch_CreatedAt" AS "createdAt"
      FROM "ExternalProviderDispatch"
      WHERE "ExternalProviderDispatch_ID" = ${candidate.id}
      FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (
      !locked ||
      (locked.status !== "RESERVED" && locked.status !== "SUBMITTED") ||
      !candidateIsStale(locked, dispatchCutoff) ||
      locked.resourceBudgetId !== candidate.resourceBudgetId ||
      locked.businessBudgetId !== candidate.businessBudgetId ||
      locked.businessProfileId !== candidate.businessProfileId ||
      locked.receiptScanId !== candidate.receiptScanId ||
      locked.receiptScanBusinessProfileId !== candidate.receiptScanBusinessProfileId ||
      locked.provider !== candidate.provider ||
      locked.unitType !== candidate.unitType ||
      locked.cycleStart.getTime() !== candidate.cycleStart.getTime() ||
      locked.reservedUnits !== candidate.reservedUnits
    ) {
      return "NONE";
    }

    if (locked.status === "SUBMITTED") {
      const changed = await tx.externalProviderDispatch.updateMany({
        where: { id: locked.id, status: "SUBMITTED", submittedAt: { lte: dispatchCutoff } },
        data: {
          status: "AMBIGUOUS",
          outcomeCode: "RECONCILED_STALE_SUBMISSION",
          completedAt,
        },
      });
      return changed.count === 1 ? "AMBIGUOUS" : "NONE";
    }
    if (eligibleReceipt) return "NONE";

    await releaseReconciliationBudget(tx, {
      id: locked.resourceBudgetId,
      scope: "RESOURCE",
      businessProfileId: null,
      provider: locked.provider,
      unitType: locked.unitType,
      cycleStart: locked.cycleStart,
      reservedUnits: locked.reservedUnits,
    });
    if (locked.businessBudgetId !== null) {
      await releaseReconciliationBudget(tx, {
        id: locked.businessBudgetId,
        scope: "BUSINESS",
        businessProfileId: locked.businessProfileId,
        provider: locked.provider,
        unitType: locked.unitType,
        cycleStart: locked.cycleStart,
        reservedUnits: locked.reservedUnits,
      });
    }
    const changed = await tx.externalProviderDispatch.updateMany({
      where: { id: locked.id, status: "RESERVED", createdAt: { lte: dispatchCutoff } },
      data: {
        status: "CANCELLED",
        outcomeCode: "RECONCILED_STALE_RESERVATION",
        finalBillableUnits: 0,
        completedAt,
      },
    });
    if (changed.count !== 1) throw new Error(`Provider reconciliation lost dispatch ${locked.id}`);
    return "CANCELLED";
  });
}

export async function reconcileStaleReceiptProviderDispatches(
  now = new Date(),
): Promise<ReceiptProviderReconciliationResult> {
  const dispatchCutoff = new Date(now.getTime() - RECEIPT_PROVIDER_DISPATCH_STALE_MS);
  const heartbeatCutoff = new Date(now.getTime() - RECEIPT_PROCESSING_LEASE_MS);
  const candidates = await prisma.$queryRaw<{ id: number }[]>`
    SELECT dispatch."ExternalProviderDispatch_ID" AS id
    FROM "ExternalProviderDispatch" dispatch
    WHERE (
      dispatch."ExternalProviderDispatch_Status" = 'SUBMITTED'
      AND dispatch."ExternalProviderDispatch_SubmittedAt" <= ${dispatchCutoff}
    ) OR (
      dispatch."ExternalProviderDispatch_Status" = 'RESERVED'
      AND dispatch."ExternalProviderDispatch_CreatedAt" <= ${dispatchCutoff}
      AND NOT EXISTS (
        SELECT 1
        FROM "ReceiptScan" scan
        INNER JOIN "BusinessProfile" profile
          ON profile."BusinessProfile_ID" = scan."BusinessProfile_ID"
        WHERE scan."ReceiptScan_ID" = dispatch."ReceiptScan_ID"
          AND scan."BusinessProfile_ID" = dispatch."ReceiptScan_BusinessProfile_ID"
          AND profile."BusinessProfile_ArchivedAt" IS NULL
          AND scan."ReceiptScan_ConfirmationStatus" = 'Pending'
          AND scan."ReceiptScan_ProcessingStatus" = 'Processing'
          AND scan."ReceiptScan_EvidenceDeletionRequestedAt" IS NULL
          AND scan."ReceiptScan_ProcessingWorkerID" IS NOT NULL
          AND scan."ReceiptScan_ProcessingAttemptCount" >= 1
          AND scan."ReceiptScan_ProcessingHeartbeatAt" >= ${heartbeatCutoff}
          AND NOT EXISTS (
            SELECT 1
            FROM "ReceiptPurgeJob" purge
            WHERE purge."ReceiptScan_ID" = scan."ReceiptScan_ID"
              AND purge."ReceiptScan_BusinessProfile_ID" = scan."BusinessProfile_ID"
              AND purge."ReceiptPurgeJob_Mode" = 'DELETE_SCAN'
          )
      )
    )
    ORDER BY dispatch."ExternalProviderDispatch_CreatedAt", dispatch."ExternalProviderDispatch_ID"
    LIMIT ${RECEIPT_PROVIDER_RECONCILIATION_BATCH_SIZE}
  `;
  const result: ReceiptProviderReconciliationResult = { cancelled: 0, ambiguous: 0 };
  for (const candidate of candidates) {
    const outcome = await reconcileCandidate(candidate.id, dispatchCutoff, heartbeatCutoff, now);
    if (outcome === "CANCELLED") result.cancelled += 1;
    if (outcome === "AMBIGUOUS") result.ambiguous += 1;
  }
  return result;
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
            where: dispatchableReceiptWhere(input, now),
            select: { id: true },
          });
          if (!receipt) throw new GateRefusal("PROVIDER_UNAVAILABLE");
          const consent =
            (await tx.externalProcessingConsent.findFirst({
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
              select: { id: true },
            })) ?? (await grantReceiptProviderConsentByPolicy(tx, input.businessProfileId, config));
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
              rescueReasonCode: firstProviderRescueReason(input.rescueDecision.reasons) ?? "LOCAL_VALIDATION_FAILED",
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

  const submitResult = await prisma.$transaction(async (tx) => {
    const lockedReceipt = await tx.$queryRaw<{ id: number }[]>`
      SELECT scan."ReceiptScan_ID" AS id
      FROM "ReceiptScan" scan
      INNER JOIN "BusinessProfile" profile
        ON profile."BusinessProfile_ID" = scan."BusinessProfile_ID"
      WHERE scan."ReceiptScan_ID" = ${input.receiptScanId}
        AND scan."BusinessProfile_ID" = ${input.businessProfileId}
        AND profile."BusinessProfile_ArchivedAt" IS NULL
      FOR UPDATE OF scan
    `;
    if (lockedReceipt.length !== 1) return "SCAN_UNAVAILABLE" as const;

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
    const submittedAt = clock();
    const receipt = await tx.receiptScan.findFirst({
      where: dispatchableReceiptWhere(input, submittedAt),
      select: { id: true },
    });
    if (!receipt) return "SCAN_UNAVAILABLE" as const;
    const changed = await tx.externalProviderDispatch.updateMany({
      where: {
        id: reservation.id,
        businessProfileId: input.businessProfileId,
        receiptScanId: input.receiptScanId,
        status: "RESERVED",
      },
      data: { status: "SUBMITTED", submittedAt },
    });
    return changed.count === 1 ? ("SUBMITTED" as const) : ("RACED" as const);
  });
  if (submitResult === "CONSENT_REVOKED") {
    const outcome = cancelledOutcome(reservation, config, Date.now() - loadStartedAt);
    await releaseOrConsume(reservation, outcome, clock()).catch(() => undefined);
    return skipped(localExtraction, "PROVIDER_CONSENT_REQUIRED");
  }
  if (submitResult === "SCAN_UNAVAILABLE") {
    const outcome = cancelledOutcome(reservation, config, Date.now() - loadStartedAt);
    await releaseOrConsume(reservation, outcome, clock()).catch(() => undefined);
    return skipped(localExtraction, "PROVIDER_UNAVAILABLE");
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
