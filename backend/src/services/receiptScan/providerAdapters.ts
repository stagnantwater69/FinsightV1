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
    currency: { value: null, evidence: null },
    total: { value: receipt.amount, evidence: receipt.amount === null ? null : formatEvidence },
    items,
    itemsEvidence: items.length > 0 ? collectionEvidence : null,
  };
}

function metadata(request: ReceiptProviderRequest, latencyMs: number) {
  return {
    contractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    provider: request.provider,
    providerVersion: request.providerVersion,
    providerRegion: request.providerRegion,
    dispatchReference: request.reservation.dispatchReference,
    providerRequestIdHash: null,
    latencyMs,
  } as const;
}

function ambiguous(request: ReceiptProviderRequest, latencyMs: number): ReceiptProviderOutcome {
  return {
    ...metadata(request, latencyMs),
    status: "AMBIGUOUS",
    timeoutOutcome: "AFTER_SUBMISSION_UNKNOWN",
    outcomeCode: "TIMEOUT_AFTER_SUBMISSION",
    finalBillableUnits: null,
    extraction: null,
  };
}

function invalid(request: ReceiptProviderRequest, latencyMs: number, units: number): ReceiptProviderOutcome {
  return {
    ...metadata(request, latencyMs),
    status: "FAILED",
    timeoutOutcome: "NOT_TIMED_OUT",
    outcomeCode: "INVALID_RESULT",
    finalBillableUnits: units,
    extraction: null,
  };
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
      if (extraction.receipt === null) return invalid(request, Date.now() - started, 1);

      const verdict = await verifyVisionReceipt(pages, extraction.receipt);
      if (verdict === null) return ambiguous(request, Date.now() - started);
      if (!verdict.accept) return invalid(request, Date.now() - started, 2);
      return {
        ...metadata(request, Date.now() - started),
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
        ...metadata(request, Date.now() - started),
        status: "SUCCEEDED",
        timeoutOutcome: "NOT_TIMED_OUT",
        outcomeCode: "OK",
        finalBillableUnits: request.pages.length,
        extraction: normalized(request, result.receipt, false),
      } satisfies ReceiptProviderOutcome;
    },
  };
}
