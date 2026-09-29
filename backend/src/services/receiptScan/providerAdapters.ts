import {
  RECEIPT_PROVIDER_CONTRACT_VERSION,
  type NormalizedEvidence,
  type NormalizedReceiptExtraction,
  type ReceiptProviderAdapter,
  type ReceiptProviderOutcome,
  type ReceiptProviderRequest,
} from "../receiptProviderContract";
import {
  extractReceiptWithVision,
  verifyVisionReceipt,
  VISION_MODEL,
  type VisionProviderFailure,
  type VisionVerifierFailure,
} from "../visionOcr.service";
import { extractReceiptWithVeryfi } from "../veryfiOcr.service";

export const VERYFI_RECEIPT_API_VERSION = "receipt-api-v8" as const;

function evidence(
  source: "gemini" | "veryfi",
  sourceVersion: string,
  validationState: "VALIDATED" | "UNVALIDATED",
  validationCodes: ("FORMAT_VALID" | "ARITHMETIC_VALID" | "REGION_UNAVAILABLE" | "OWNER_REVIEW_REQUIRED")[],
  pageNumber: number | null = null,
): NormalizedEvidence {
  return {
    source,
    sourceVersion,
    pageNumber,
    regionStatus: "UNAVAILABLE",
    region: null,
    confidenceBand: validationState === "VALIDATED" ? "MEDIUM" : "LOW",
    calibrationState: "UNCALIBRATED",
    validationState,
    validationCodes,
  };
}

function normalized(
  request: ReceiptProviderRequest,
  receipt: {
    date: string | null;
    vendor: string | null;
    currency?: string | null;
    amount: number | null;
    items: { name: string; quantity: number | null; amount: number; pageNumber?: number | null }[];
  },
  verifierAccepted: boolean,
): NormalizedReceiptExtraction {
  const source = request.provider as "gemini" | "veryfi";
  const formatEvidence = evidence(
    source,
    request.providerVersion,
    "VALIDATED",
    ["FORMAT_VALID", "REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
  );
  const itemSum = receipt.items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  const totalCents = receipt.amount === null ? null : Math.round(receipt.amount * 100);
  const itemsReconcile = receipt.items.length > 0 && totalCents !== null && itemSum === totalCents;
  // Only the arithmetic may validate the collection. A verifier pass is a second
  // model agreeing with the first, so it supports the claim but never replaces it:
  // 100 + 100 + 100 against a printed 350 must reach the owner marked for review.
  const collectionEvidence = evidence(
    source,
    request.providerVersion,
    itemsReconcile ? "VALIDATED" : "UNVALIDATED",
    [
      ...(itemsReconcile
        ? (["ARITHMETIC_VALID"] as const)
        : (["OWNER_REVIEW_REQUIRED"] as const)),
      ...(verifierAccepted ? (["FORMAT_VALID"] as const) : ([] as const)),
      "REGION_UNAVAILABLE",
    ],
  );
  // Nothing on the paper corroborates a currency the provider merely asserts,
  // so it is offered UNVALIDATED and cannot displace the printed local reading.
  const currency = receipt.currency ?? null;
  const currencyEvidence = evidence(
    source,
    request.providerVersion,
    "UNVALIDATED",
    ["REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
  );
  const items = receipt.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    amount: item.amount,
    evidence: evidence(
      source,
      request.providerVersion,
      "VALIDATED",
      ["FORMAT_VALID", "REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
      item.pageNumber ?? null,
    ),
  }));
  return {
    schemaVersion: request.normalizedSchemaVersion,
    source,
    sourceVersion: request.providerVersion,
    date: { value: receipt.date, evidence: receipt.date === null ? null : formatEvidence },
    vendor: { value: receipt.vendor, evidence: receipt.vendor === null ? null : formatEvidence },
    currency: { value: currency, evidence: currency === null ? null : currencyEvidence },
    total: { value: receipt.amount, evidence: receipt.amount === null ? null : formatEvidence },
    items,
    itemsEvidence: items.length > 0 ? collectionEvidence : null,
  };
}

type ProviderStageTimings = {
  extractionMs: number;
  verificationMs: number;
};

function metadata(
  request: ReceiptProviderRequest,
  latencyMs: number,
  retryAfterMs: number | null = null,
  stageTimings?: ProviderStageTimings,
) {
  return {
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider: request.provider,
    providerVersion: request.providerVersion,
    providerRegion: request.providerRegion,
    dispatchReference: request.reservation.dispatchReference,
    providerRequestIdHash: null,
    latencyMs,
    retryAfterMs,
    ...(stageTimings ? { stageTimings } : {}),
  } as const;
}

function ambiguous(
  request: ReceiptProviderRequest,
  latencyMs: number,
  outcomeCode: "TIMEOUT_AFTER_SUBMISSION" | "TRANSPORT_ERROR" | "REQUEST_CANCELLED" = "TIMEOUT_AFTER_SUBMISSION",
  stageTimings?: ProviderStageTimings,
): ReceiptProviderOutcome {
  return {
    ...metadata(request, latencyMs, null, stageTimings),
    status: "AMBIGUOUS",
    timeoutOutcome: "AFTER_SUBMISSION_UNKNOWN",
    outcomeCode,
    finalBillableUnits: null,
    extraction: null,
  };
}

function failed(
  request: ReceiptProviderRequest,
  latencyMs: number,
  units: number,
  outcomeCode:
    | "AUTH_ERROR"
    | "RATE_LIMITED"
    | "PROVIDER_SERVER_ERROR"
    | "HTTP_ERROR"
    | "TRANSPORT_ERROR"
    | "INVALID_RESULT",
  retryAfterMs: number | null = null,
  stageTimings?: ProviderStageTimings,
): ReceiptProviderOutcome {
  return {
    ...metadata(request, latencyMs, retryAfterMs, stageTimings),
    status: "FAILED",
    timeoutOutcome: "NOT_TIMED_OUT",
    outcomeCode,
    finalBillableUnits: units,
    extraction: null,
  };
}

function invalid(
  request: ReceiptProviderRequest,
  latencyMs: number,
  units: number,
  stageTimings?: ProviderStageTimings,
): ReceiptProviderOutcome {
  return failed(request, latencyMs, units, "INVALID_RESULT", null, stageTimings);
}

function extractionUnavailable(
  request: ReceiptProviderRequest,
  latencyMs: number,
  failure: VisionProviderFailure,
  stageTimings: ProviderStageTimings,
): ReceiptProviderOutcome {
  switch (failure.kind) {
    case "not_attempted":
    case "auth":
      return failed(request, latencyMs, 0, "AUTH_ERROR", null, stageTimings);
    case "rate_limited":
      return failed(request, latencyMs, 0, "RATE_LIMITED", failure.retryAfterMs, stageTimings);
    case "server":
      return failed(request, latencyMs, 0, "PROVIDER_SERVER_ERROR", null, stageTimings);
    case "http":
      return failed(request, latencyMs, 0, "HTTP_ERROR", null, stageTimings);
    case "transport":
      return ambiguous(request, latencyMs, "TRANSPORT_ERROR", stageTimings);
    case "cancelled":
      return ambiguous(request, latencyMs, "REQUEST_CANCELLED", stageTimings);
    case "timeout":
      return ambiguous(request, latencyMs, "TIMEOUT_AFTER_SUBMISSION", stageTimings);
    case "unusable":
      return invalid(request, latencyMs, 1, stageTimings);
  }
}

/**
 * How an absent verifier verdict is recorded.
 *
 * AMBIGUOUS / TIMEOUT_AFTER_SUBMISSION is a claim about billing: reached,
 * possibly charged, outcome unknown. Recording every absent verdict that way
 * put spend in the telemetry that a rotated key or a dropped connection never
 * incurred, and hid the misconfiguration behind a plausible timeout. Only a
 * real timeout is ambiguous; the rest are billed for the extraction alone.
 */
function verifierUnavailable(
  request: ReceiptProviderRequest,
  latencyMs: number,
  failure: VisionVerifierFailure,
  retryAfterMs: number | null,
  stageTimings: ProviderStageTimings,
): ReceiptProviderOutcome {
  switch (failure) {
    case "timeout":
      return ambiguous(request, latencyMs, "TIMEOUT_AFTER_SUBMISSION", stageTimings);
    case "cancelled":
      return ambiguous(request, latencyMs, "REQUEST_CANCELLED", stageTimings);
    case "not_attempted":
    case "auth":
      return failed(request, latencyMs, 1, "AUTH_ERROR", null, stageTimings);
    case "rate_limited":
      return failed(request, latencyMs, 1, "RATE_LIMITED", retryAfterMs, stageTimings);
    case "server":
      return failed(request, latencyMs, 1, "PROVIDER_SERVER_ERROR", null, stageTimings);
    case "transport":
      return failed(request, latencyMs, 1, "TRANSPORT_ERROR", null, stageTimings);
    case "http":
      return failed(request, latencyMs, 1, "HTTP_ERROR", null, stageTimings);
    case "unusable":
      return failed(request, latencyMs, 2, "INVALID_RESULT", null, stageTimings);
  }
}

function bytesAsBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function createGeminiReceiptAdapter(): ReceiptProviderAdapter & { readonly providerVersion: string } {
  const providerVersion = VISION_MODEL ?? "unavailable";
  return {
    provider: "gemini",
    providerVersion,
    async extract(request) {
      const started = Date.now();
      const pages = request.pages.map((page) => ({ buffer: bytesAsBuffer(page.bytes), mimetype: page.mediaType }));
      const extraction = await extractReceiptWithVision(pages);
      if (extraction === null) return ambiguous(request, Date.now() - started);
      const extractionMs = extraction.requestMs ?? Date.now() - started;
      const extractionStages = { extractionMs, verificationMs: 0 };
      if (extraction.failure !== null && extraction.failure !== undefined) {
        return extractionUnavailable(request, Date.now() - started, extraction.failure, extractionStages);
      }
      if (extraction.receipt === null) return invalid(request, Date.now() - started, 1, extractionStages);

      const verification = await verifyVisionReceipt(pages, extraction.receipt);
      const stageTimings = {
        extractionMs,
        verificationMs: verification.requestMs ?? Math.max(0, Date.now() - started - extractionMs),
      };
      if (verification.failure !== null) {
        return verifierUnavailable(
          request,
          Date.now() - started,
          verification.failure,
          verification.retryAfterMs ?? null,
          stageTimings,
        );
      }
      if (!verification.verdict.accept) return invalid(request, Date.now() - started, 2, stageTimings);
      return {
        ...metadata(request, Date.now() - started, null, stageTimings),
        status: "SUCCEEDED",
        timeoutOutcome: "NOT_TIMED_OUT",
        outcomeCode: "OK",
        finalBillableUnits: 2,
        extraction: normalized(request, extraction.receipt, true),
      } satisfies ReceiptProviderOutcome;
    },
  };
}

export function createVeryfiReceiptAdapter(): ReceiptProviderAdapter & { readonly providerVersion: string } {
  return {
    provider: "veryfi",
    providerVersion: VERYFI_RECEIPT_API_VERSION,
    async extract(request) {
      const started = Date.now();
      const result = await extractReceiptWithVeryfi(
        request.pages.map((page) => ({ buffer: bytesAsBuffer(page.bytes), mimetype: page.mediaType })),
      );
      if (result === null) return ambiguous(request, Date.now() - started);
      if (result.receipt === null) return invalid(request, Date.now() - started, request.pages.length);
      return {
        ...metadata(request, Date.now() - started, null, {
          extractionMs: Date.now() - started,
          verificationMs: 0,
        }),
        status: "SUCCEEDED",
        timeoutOutcome: "NOT_TIMED_OUT",
        outcomeCode: "OK",
        finalBillableUnits: request.pages.length,
        extraction: normalized(request, result.receipt, false),
      } satisfies ReceiptProviderOutcome;
    },
  };
}
