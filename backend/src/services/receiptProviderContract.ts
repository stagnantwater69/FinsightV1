import { z } from "zod";
import { RESCUE_DECISION_VERSION, rescueDecisionSchema } from "./receiptRescueDecision";

export const RECEIPT_PROVIDER_CONTRACT_VERSION = "receipt-provider-contract-v1" as const;
export const DEFAULT_EXTERNAL_PROVIDER_UNIT_LIMIT = 0 as const;

export const receiptProviderSchema = z.enum(["gemini", "veryfi", "azure-document-intelligence"]);
export type ReceiptProvider = z.infer<typeof receiptProviderSchema>;

export const providerDataClassSchema = z.enum(["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"]);
export const providerUnitTypeSchema = z.enum(["PAGE", "DOCUMENT", "IMAGE_FEATURE"]);
export type ProviderDataClass = z.infer<typeof providerDataClassSchema>;
export type ProviderUnitType = z.infer<typeof providerUnitTypeSchema>;

const referenceSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const versionSchema = z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9._:-]+$/);
const regionSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const mediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const currentProviderConsentReferenceSchema = z
  .object({
    reference: referenceSchema,
    status: z.literal("CURRENT"),
    provider: receiptProviderSchema,
    policyVersion: versionSchema,
    purpose: z.literal("RECEIPT_EXTRACTION"),
    allowedDataClasses: z.array(providerDataClassSchema).min(1).max(2),
    processingRegion: regionSchema,
    providerRetentionHours: z.number().int().min(0).max(24),
    providerTrainingAllowed: z.literal(false),
  })
  .strict()
  .superRefine((consent, context) => {
    if (new Set(consent.allowedDataClasses).size !== consent.allowedDataClasses.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedDataClasses"],
        message: "duplicate data class",
      });
    }
  });
export type CurrentProviderConsentReference = z.infer<typeof currentProviderConsentReferenceSchema>;

export const reservedProviderUnitsSchema = z
  .object({
    status: z.literal("RESERVED"),
    dispatchReference: referenceSchema,
    resourceReservationReference: referenceSchema,
    businessReservationReference: referenceSchema.nullable(),
    unitType: providerUnitTypeSchema,
    reservedUnits: z.number().int().positive().max(100),
  })
  .strict();
export type ReservedProviderUnits = z.infer<typeof reservedProviderUnitsSchema>;

const providerPageSchema = z
  .object({
    pageNumber: z.number().int().min(1).max(8),
    dataClass: providerDataClassSchema,
    mediaType: mediaTypeSchema,
    inputSha256: sha256Schema,
    bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 10 * 1024 * 1024),
  })
  .strict();

export const receiptProviderRequestSchema = z
  .object({
    contractVersion: z.literal(RECEIPT_PROVIDER_CONTRACT_VERSION),
    provider: receiptProviderSchema,
    providerVersion: versionSchema,
    providerRegion: regionSchema,
    normalizedSchemaVersion: versionSchema,
    preprocessingVersion: versionSchema,
    timeoutMs: z.number().int().min(1_000).max(60_000),
    consent: currentProviderConsentReferenceSchema,
    reservation: reservedProviderUnitsSchema,
    rescueDecision: rescueDecisionSchema,
    pages: z.array(providerPageSchema).min(1).max(8),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.rescueDecision.providerRescueRequested) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rescueDecision", "providerRescueRequested"],
        message: "provider rescue was not requested",
      });
    }
    if (request.rescueDecision.calibration.state !== "CALIBRATED") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rescueDecision", "calibration"],
        message: "provider dispatch requires calibrated routing",
      });
    }
    if (request.rescueDecision.version !== RESCUE_DECISION_VERSION) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["rescueDecision", "version"], message: "version mismatch" });
    }
    if (request.consent.provider !== request.provider) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["consent", "provider"], message: "provider mismatch" });
    }
    if (request.consent.processingRegion !== request.providerRegion) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["consent", "processingRegion"], message: "region mismatch" });
    }

    const allowedDataClasses = new Set(request.consent.allowedDataClasses);
    const pageNumbers = new Set<number>();
    for (let index = 0; index < request.pages.length; index++) {
      const page = request.pages[index]!;
      if (!allowedDataClasses.has(page.dataClass)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", index, "dataClass"], message: "not consented" });
      }
      if (pageNumbers.has(page.pageNumber)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", index, "pageNumber"], message: "duplicate" });
      }
      pageNumbers.add(page.pageNumber);
    }

    if (request.reservation.unitType === "PAGE" && request.reservation.reservedUnits < request.pages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reservation", "reservedUnits"],
        message: "does not cover every page",
      });
    }
  });

declare const validatedRequest: unique symbol;
export type ReceiptProviderRequest = z.infer<typeof receiptProviderRequestSchema> & { readonly [validatedRequest]: true };

export function parseReceiptProviderRequest(input: unknown): ReceiptProviderRequest {
  return receiptProviderRequestSchema.parse(input) as ReceiptProviderRequest;
}

/** Adapters receive only a request that already passed consent, reservation, and shape validation. */
export interface ReceiptProviderAdapter {
  readonly provider: ReceiptProvider;
  extract(request: ReceiptProviderRequest): Promise<unknown>;
}

export const evidenceConfidenceBandSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export const evidenceCalibrationStateSchema = z.enum(["CALIBRATED", "UNCALIBRATED", "OUT_OF_SCOPE"]);
export const evidenceValidationStateSchema = z.enum(["VALIDATED", "UNVALIDATED", "CONFLICTING"]);
export const evidenceValidationCodeSchema = z.enum([
  "FORMAT_VALID",
  "ARITHMETIC_VALID",
  "LOCAL_MATCH",
  "LOCAL_CONFLICT",
  "REGION_UNAVAILABLE",
  "OWNER_REVIEW_REQUIRED",
]);
export type EvidenceConfidenceBand = z.infer<typeof evidenceConfidenceBandSchema>;
export type EvidenceCalibrationState = z.infer<typeof evidenceCalibrationStateSchema>;
export type EvidenceValidationState = z.infer<typeof evidenceValidationStateSchema>;
export type EvidenceValidationCode = z.infer<typeof evidenceValidationCodeSchema>;

export const receiptExtractionSourceSchema = z.enum([
  "local-tesseract",
  "gemini",
  "veryfi",
  "azure-document-intelligence",
  "merged",
]);
const normalizedPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
const normalizedRegionSchema = z.array(normalizedPointSchema).length(4);

export const normalizedEvidenceSchema = z
  .object({
    source: receiptExtractionSourceSchema,
    sourceVersion: versionSchema,
    pageNumber: z.number().int().min(1).max(8).nullable(),
    regionStatus: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    region: normalizedRegionSchema.nullable(),
    confidenceBand: evidenceConfidenceBandSchema,
    calibrationState: evidenceCalibrationStateSchema,
    validationState: evidenceValidationStateSchema,
    validationCodes: z.array(evidenceValidationCodeSchema).min(1).max(6),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.regionStatus === "AVAILABLE" && (evidence.region === null || evidence.pageNumber === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["region"], message: "available region needs page and polygon" });
    }
    if (evidence.regionStatus === "UNAVAILABLE" && evidence.region !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["region"], message: "unavailable region must be null" });
    }
    if (evidence.regionStatus === "UNAVAILABLE" && !evidence.validationCodes.includes("REGION_UNAVAILABLE")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validationCodes"],
        message: "missing REGION_UNAVAILABLE",
      });
    }
    if (evidence.confidenceBand === "HIGH" && evidence.calibrationState !== "CALIBRATED") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["confidenceBand"], message: "high evidence must be calibrated" });
    }
    if (evidence.confidenceBand === "HIGH" && evidence.validationState !== "VALIDATED") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["validationState"], message: "high evidence must be validated" });
    }
  });
export type NormalizedEvidence = z.infer<typeof normalizedEvidenceSchema>;
export type ReceiptExtractionSource = z.infer<typeof receiptExtractionSourceSchema>;

const realDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
});

function nullableFieldSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({ value: valueSchema.nullable(), evidence: normalizedEvidenceSchema.nullable() })
    .strict()
    .superRefine((field, context) => {
      if (field.value !== null && field.evidence === null) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "non-null value needs evidence" });
      }
    });
}

export const normalizedReceiptItemSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    quantity: z.number().positive().finite().nullable(),
    amount: z.number().positive().finite(),
    evidence: normalizedEvidenceSchema,
  })
  .strict();
export type NormalizedReceiptItem = z.infer<typeof normalizedReceiptItemSchema>;

export const normalizedReceiptExtractionSchema = z
  .object({
    schemaVersion: versionSchema,
    source: receiptExtractionSourceSchema,
    sourceVersion: versionSchema,
    date: nullableFieldSchema(realDateSchema),
    vendor: nullableFieldSchema(z.string().trim().min(1).max(150)),
    currency: nullableFieldSchema(z.string().regex(/^[A-Z]{3}$/)),
    total: nullableFieldSchema(z.number().positive().finite()),
    items: z.array(normalizedReceiptItemSchema).max(100),
    itemsEvidence: normalizedEvidenceSchema.nullable(),
  })
  .strict()
  .superRefine((extraction, context) => {
    if (extraction.items.length > 0 && extraction.itemsEvidence === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["itemsEvidence"], message: "items need collection evidence" });
    }
    const evidence = [
      extraction.date.evidence,
      extraction.vendor.evidence,
      extraction.currency.evidence,
      extraction.total.evidence,
      extraction.itemsEvidence,
      ...extraction.items.map((item) => item.evidence),
    ].filter((entry): entry is NormalizedEvidence => entry !== null);
    for (const [index, entry] of evidence.entries()) {
      if (extraction.source === "merged") break;
      if (entry.source !== extraction.source || entry.sourceVersion !== extraction.sourceVersion) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", index], message: "source mismatch" });
      }
    }
  });
export type NormalizedReceiptExtraction = z.infer<typeof normalizedReceiptExtractionSchema>;

const outcomeMetadataShape = {
  contractVersion: z.literal(RECEIPT_PROVIDER_CONTRACT_VERSION),
  provider: receiptProviderSchema,
  providerVersion: versionSchema,
  providerRegion: regionSchema,
  dispatchReference: referenceSchema,
  providerRequestIdHash: sha256Schema.nullable(),
  latencyMs: z.number().int().nonnegative().max(300_000),
} as const;

export const providerOutcomeCodeSchema = z.enum([
  "OK",
  "HTTP_ERROR",
  "TRANSPORT_ERROR",
  "INVALID_RESULT",
  "TIMEOUT_BEFORE_SUBMISSION",
  "TIMEOUT_AFTER_SUBMISSION",
]);

export const receiptProviderOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...outcomeMetadataShape,
      status: z.literal("SUCCEEDED"),
      timeoutOutcome: z.literal("NOT_TIMED_OUT"),
      outcomeCode: z.literal("OK"),
      finalBillableUnits: z.number().int().nonnegative(),
      extraction: normalizedReceiptExtractionSchema,
    })
    .strict(),
  z
    .object({
      ...outcomeMetadataShape,
      status: z.literal("FAILED"),
      timeoutOutcome: z.literal("NOT_TIMED_OUT"),
      outcomeCode: z.enum(["HTTP_ERROR", "TRANSPORT_ERROR", "INVALID_RESULT"]),
      finalBillableUnits: z.number().int().nonnegative(),
      extraction: z.null(),
    })
    .strict(),
  z
    .object({
      ...outcomeMetadataShape,
      status: z.literal("CANCELLED"),
      timeoutOutcome: z.literal("BEFORE_SUBMISSION"),
      outcomeCode: z.literal("TIMEOUT_BEFORE_SUBMISSION"),
      finalBillableUnits: z.literal(0),
      extraction: z.null(),
    })
    .strict(),
  z
    .object({
      ...outcomeMetadataShape,
      status: z.literal("AMBIGUOUS"),
      timeoutOutcome: z.literal("AFTER_SUBMISSION_UNKNOWN"),
      outcomeCode: z.literal("TIMEOUT_AFTER_SUBMISSION"),
      finalBillableUnits: z.null(),
      extraction: z.null(),
    })
    .strict(),
]);
export type ReceiptProviderOutcome = z.infer<typeof receiptProviderOutcomeSchema>;

export type ProviderOutcomeRejectReason =
  | "INVALID_OUTCOME"
  | "METADATA_MISMATCH"
  | "UNIT_OVERAGE"
  | "SCHEMA_VERSION_MISMATCH"
  | "EVIDENCE_SOURCE_MISMATCH";

export type ProviderOutcomeValidation =
  | { ok: true; outcome: ReceiptProviderOutcome }
  | { ok: false; reason: ProviderOutcomeRejectReason };

export function validateReceiptProviderOutcome(
  request: ReceiptProviderRequest,
  input: unknown,
): ProviderOutcomeValidation {
  const parsed = receiptProviderOutcomeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_OUTCOME" };
  const outcome = parsed.data;
  if (
    outcome.provider !== request.provider ||
    outcome.providerVersion !== request.providerVersion ||
    outcome.providerRegion !== request.providerRegion ||
    outcome.dispatchReference !== request.reservation.dispatchReference
  ) {
    return { ok: false, reason: "METADATA_MISMATCH" };
  }
  if (outcome.finalBillableUnits !== null && outcome.finalBillableUnits > request.reservation.reservedUnits) {
    return { ok: false, reason: "UNIT_OVERAGE" };
  }
  if (outcome.status === "SUCCEEDED") {
    if (outcome.extraction.schemaVersion !== request.normalizedSchemaVersion) {
      return { ok: false, reason: "SCHEMA_VERSION_MISMATCH" };
    }
    if (outcome.extraction.source !== request.provider || outcome.extraction.sourceVersion !== request.providerVersion) {
      return { ok: false, reason: "EVIDENCE_SOURCE_MISMATCH" };
    }
  }
  return { ok: true, outcome };
}

function evidenceStrength(evidence: NormalizedEvidence | null): number {
  if (evidence === null || evidence.validationState !== "VALIDATED") return 0;
  if (evidence.confidenceBand === "HIGH") return 3;
  if (evidence.confidenceBand === "MEDIUM") return 2;
  return 1;
}

function sameMoney(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100);
}

function mergeField<T>(
  local: { value: T | null; evidence: NormalizedEvidence | null },
  external: { value: T | null; evidence: NormalizedEvidence | null },
  equal: (left: T, right: T) => boolean,
  providerFirst: boolean,
): { field: typeof local; changed: boolean } {
  if (external.value === null || external.evidence === null) return { field: local, changed: false };
  if (local.value !== null && equal(local.value, external.value)) return { field: local, changed: false };
  if (providerFirst) {
    return evidenceStrength(external.evidence) >= 1 ? { field: external, changed: true } : { field: local, changed: false };
  }
  if (evidenceStrength(external.evidence) < 2 || evidenceStrength(external.evidence) <= evidenceStrength(local.evidence)) {
    return { field: local, changed: false };
  }
  return { field: external, changed: true };
}

export type ProviderMergeResult = {
  receipt: NormalizedReceiptExtraction;
  appliedFields: ("date" | "vendor" | "currency" | "total" | "items")[];
  providerResultAccepted: boolean;
  reason: ProviderOutcomeRejectReason | "NOT_SUCCESSFUL" | "NO_SAFER_FIELDS" | "MERGED";
  /**
   * True when `items` came from the provider without reconciling to the total.
   * They are prefilled for the owner to check against the paper, never booked
   * as validated; the worker turns this into a scan warning.
   */
  itemsOwnerReviewRequired: boolean;
};

function markedForOwnerReview(evidence: NormalizedEvidence): NormalizedEvidence {
  return {
    ...evidence,
    confidenceBand: "LOW",
    validationState: "UNVALIDATED",
    validationCodes: evidence.validationCodes.includes("OWNER_REVIEW_REQUIRED")
      ? evidence.validationCodes
      : [...evidence.validationCodes, "OWNER_REVIEW_REQUIRED"],
  };
}

/**
 * Which reading wins depends on why the provider was asked.
 *
 * RESCUE (the default): the provider was called because the local read
 * failed, and only a stronger validated provider field replaces a local one.
 * The local value stays on invalid, weaker, equal, or unvalidated external
 * evidence.
 *
 * ALWAYS routing: the operator chose the provider as the primary reader, so
 * its validated answer replaces the local one wherever it answered at all and
 * the local read is the fallback for what it left null. Items follow the
 * rule the pre-contract rescue used: the provider's list wins when it adds up
 * to the total or the local read found no items; a provider list that does
 * not add up never displaces a local list that does.
 *
 * In either mode, provider items that do not add up to the total are still
 * prefilled for owner review (UNVALIDATED / OWNER_REVIEW_REQUIRED) when the
 * provider was asked for every receipt or the local read found no items at
 * all. Dropping them left the owner typing a list the provider had already
 * read.
 */
export function mergeReceiptProviderOutcome(
  localInput: NormalizedReceiptExtraction,
  request: ReceiptProviderRequest,
  providerInput: unknown,
): ProviderMergeResult {
  const local = normalizedReceiptExtractionSchema.parse(localInput);
  const validation = validateReceiptProviderOutcome(request, providerInput);
  if (!validation.ok) {
    return {
      receipt: local,
      appliedFields: [],
      providerResultAccepted: false,
      reason: validation.reason,
      itemsOwnerReviewRequired: false,
    };
  }
  if (validation.outcome.status !== "SUCCEEDED") {
    return {
      receipt: local,
      appliedFields: [],
      providerResultAccepted: true,
      reason: "NOT_SUCCESSFUL",
      itemsOwnerReviewRequired: false,
    };
  }

  const external = validation.outcome.extraction;
  const alwaysRouted = request.rescueDecision.reasons.includes("PROVIDER_ROUTING_ALWAYS");
  const date = mergeField(local.date, external.date, (left, right) => left === right, alwaysRouted);
  const vendor = mergeField(
    local.vendor,
    external.vendor,
    (left, right) => left.trim().toLowerCase() === right.trim().toLowerCase(),
    alwaysRouted,
  );
  const currency = mergeField(local.currency, external.currency, (left, right) => left === right, alwaysRouted);
  const total = mergeField(local.total, external.total, sameMoney, alwaysRouted);

  const externalItemsStrength = evidenceStrength(external.itemsEvidence);
  const localItemsStrength = evidenceStrength(local.itemsEvidence);
  const replaceItems =
    external.items.length > 0
    && ((externalItemsStrength >= 2 && externalItemsStrength > localItemsStrength)
      || (alwaysRouted && externalItemsStrength >= 2));
  const prefillUnreconciledItems =
    !replaceItems &&
    external.items.length > 0 &&
    external.itemsEvidence !== null &&
    externalItemsStrength === 0 &&
    localItemsStrength === 0 &&
    (alwaysRouted || local.items.length === 0);
  const appliedFields: ProviderMergeResult["appliedFields"] = [];
  if (date.changed) appliedFields.push("date");
  if (vendor.changed) appliedFields.push("vendor");
  if (currency.changed) appliedFields.push("currency");
  if (total.changed) appliedFields.push("total");
  if (replaceItems || prefillUnreconciledItems) appliedFields.push("items");

  if (appliedFields.length === 0) {
    return {
      receipt: local,
      appliedFields,
      providerResultAccepted: true,
      reason: "NO_SAFER_FIELDS",
      itemsOwnerReviewRequired: false,
    };
  }

  const items = replaceItems
    ? external.items
    : prefillUnreconciledItems
      ? external.items.map((item) => ({ ...item, evidence: markedForOwnerReview(item.evidence) }))
      : local.items;
  const itemsEvidence = replaceItems
    ? external.itemsEvidence
    : prefillUnreconciledItems
      ? markedForOwnerReview(external.itemsEvidence!)
      : local.itemsEvidence;
  const merged = normalizedReceiptExtractionSchema.parse({
    ...local,
    source: "merged",
    sourceVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    date: date.field,
    vendor: vendor.field,
    currency: currency.field,
    total: total.field,
    items,
    itemsEvidence,
  });

  return {
    receipt: merged,
    appliedFields,
    providerResultAccepted: true,
    reason: "MERGED",
    itemsOwnerReviewRequired: prefillUnreconciledItems,
  };
}
