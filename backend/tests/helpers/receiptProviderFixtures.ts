import { createHash } from "node:crypto";
import {
  RECEIPT_PROVIDER_CONTRACT_VERSION,
  parseReceiptProviderRequest,
  type EvidenceCalibrationState,
  type EvidenceConfidenceBand,
  type EvidenceValidationState,
  type NormalizedEvidence,
  type NormalizedReceiptExtraction,
  type ReceiptProvider,
  type ReceiptProviderOutcome,
  type ReceiptProviderRequest,
} from "../../src/services/receiptProviderContract";
import { RESCUE_DECISION_VERSION, type RescueDecision } from "../../src/services/receiptRescueDecision";

export const MOCK_PROVIDER_BYTES = Buffer.from([1, 2, 3, 4]);
export const MOCK_PROVIDER_SHA256 = createHash("sha256").update(MOCK_PROVIDER_BYTES).digest("hex");

export function evidence(
  source: "local-tesseract" | "gemini" | "veryfi" | "azure-document-intelligence",
  options: {
    confidenceBand?: EvidenceConfidenceBand;
    calibrationState?: EvidenceCalibrationState;
    validationState?: EvidenceValidationState;
    sourceVersion?: string;
  } = {},
): NormalizedEvidence {
  return {
    source,
    sourceVersion: options.sourceVersion ?? (source === "local-tesseract" ? "tesseract-v1" : "provider-v1"),
    pageNumber: null,
    regionStatus: "UNAVAILABLE",
    region: null,
    confidenceBand: options.confidenceBand ?? "MEDIUM",
    calibrationState: options.calibrationState ?? "CALIBRATED",
    validationState: options.validationState ?? "VALIDATED",
    validationCodes: ["FORMAT_VALID", "REGION_UNAVAILABLE"],
  };
}

export function localExtraction(
  overrides: Partial<NormalizedReceiptExtraction> = {},
): NormalizedReceiptExtraction {
  const localEvidence = evidence("local-tesseract");
  return {
    schemaVersion: "normalized-v1",
    source: "local-tesseract",
    sourceVersion: "tesseract-v1",
    date: { value: "2026-09-13", evidence: localEvidence },
    vendor: { value: "Local Store", evidence: localEvidence },
    currency: { value: "PHP", evidence: localEvidence },
    total: { value: 100, evidence: localEvidence },
    items: [],
    itemsEvidence: null,
    ...overrides,
  };
}

export function rescueDecision(overrides: Partial<RescueDecision> = {}): RescueDecision {
  return {
    version: RESCUE_DECISION_VERSION,
    providerRescueRequested: true,
    reviewLevel: "FOCUSED",
    localResultDisposition: "KEEP_AS_FALLBACK",
    reasons: ["MISSING_CRITICAL_TOTAL"],
    calibration: { state: "CALIBRATED", version: "routing-v1" },
    ...overrides,
  };
}

export function providerExtraction(
  provider: "gemini" | "veryfi" | "azure-document-intelligence" = "gemini",
  overrides: Partial<NormalizedReceiptExtraction> = {},
): NormalizedReceiptExtraction {
  const sourceVersion = overrides.sourceVersion ??
    (provider === "gemini" ? "provider-v1" : provider === "veryfi" ? "receipt-api-v8" : "azure-v1");
  const providerEvidence = evidence(provider, { sourceVersion });
  return {
    schemaVersion: "normalized-v1",
    source: provider,
    sourceVersion,
    date: { value: "2026-09-14", evidence: providerEvidence },
    vendor: { value: "Provider Store", evidence: providerEvidence },
    currency: { value: "PHP", evidence: providerEvidence },
    total: { value: 125, evidence: providerEvidence },
    items: [],
    itemsEvidence: null,
    ...overrides,
  };
}

export function providerRequest(overrides: Record<string, unknown> = {}): ReceiptProviderRequest {
  const provider = (overrides.provider ?? "gemini") as ReceiptProvider;
  const providerVersion = (overrides.providerVersion ?? "provider-v1") as string;
  return parseReceiptProviderRequest({
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider,
    providerVersion,
    providerRegion: "global",
    normalizedSchemaVersion: "normalized-v1",
    preprocessingVersion: "preprocess-v1",
    timeoutMs: 20_000,
    consent: {
      reference: "consent:1",
      status: "CURRENT",
      provider,
      policyVersion: "receipt-provider-policy-v1",
      purpose: "RECEIPT_EXTRACTION",
      allowedDataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
      processingRegion: "global",
      providerRetentionHours: 0,
      providerTrainingAllowed: false,
    },
    reservation: {
      status: "RESERVED",
      dispatchReference: "dispatch:1",
      resourceReservationReference: "budget:1",
      businessReservationReference: null,
      unitType: "DOCUMENT",
      reservedUnits: 2,
    },
    rescueDecision: rescueDecision(),
    pages: [
      {
        pageNumber: 1,
        dataClass: "RECEIPT_IMAGE",
        mediaType: "image/jpeg",
        inputSha256: MOCK_PROVIDER_SHA256,
        bytes: MOCK_PROVIDER_BYTES,
      },
    ],
    ...overrides,
  });
}

export function successfulOutcome(
  request: ReceiptProviderRequest,
  overrides: Record<string, unknown> = {},
): ReceiptProviderOutcome {
  return {
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider: request.provider,
    providerVersion: request.providerVersion,
    providerRegion: request.providerRegion,
    dispatchReference: request.reservation.dispatchReference,
    providerRequestIdHash: null,
    latencyMs: 12,
    status: "SUCCEEDED",
    timeoutOutcome: "NOT_TIMED_OUT",
    outcomeCode: "OK",
    finalBillableUnits: request.reservation.reservedUnits,
    extraction: providerExtraction(request.provider as "gemini" | "veryfi" | "azure-document-intelligence", {
      sourceVersion: request.providerVersion,
      schemaVersion: request.normalizedSchemaVersion,
    }),
    ...overrides,
  } as ReceiptProviderOutcome;
}
