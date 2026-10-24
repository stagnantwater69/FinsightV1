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
  type VisionReceipt,
  type VisionVerifierFailure,
} from "../visionOcr.service";
import { extractReceiptWithVeryfi } from "../veryfiOcr.service";
import { isoIfValid, readNumericDate } from "../../lib/receiptDates";

export const VERYFI_RECEIPT_API_VERSION = "receipt-api-v8" as const;

/*
 * The prompt tells Gemini to read an open day/month order day-first, which
 * swaps the month-first dates most Metro Manila registers print (11 of 15 date
 * misses on 50 public receipts). Its copy of the printed characters is re-read
 * with the parser's rule instead (lib/receiptDates), so both readers settle the
 * same paper the same way. Applied only when Gemini's own date is one of the
 * two readings of those characters: printed text that disagrees with the
 * model's date is not trusted to overrule it.
 */
export function settleDateOrder(
  receipt: VisionReceipt,
  referenceDate: string | null,
): { receipt: VisionReceipt; dateOrderInferred: boolean } {
  const printedText = receipt.dateText
    ?? (receipt.warnings ?? []).find((warning) => warning.code === "AMBIGUOUS_DATE")?.detail
    ?? null;
  if (receipt.date === null || printedText === null) return { receipt, dateOrderInferred: false };
  const printed = readNumericDate(printedText, referenceDate);
  if (!printed) return { receipt, dateOrderInferred: false };
  const readings = [
    isoIfValid(printed.year, printed.second, printed.first),
    isoIfValid(printed.year, printed.first, printed.second),
  ];
  if (!readings.includes(receipt.date)) return { receipt, dateOrderInferred: false };
  return { receipt: { ...receipt, date: printed.iso }, dateOrderInferred: printed.ambiguous };
}

function evidence(
  source: "gemini" | "veryfi",
  sourceVersion: string,
  validationState: "VALIDATED" | "UNVALIDATED",
  validationCodes: ("FORMAT_VALID" | "ARITHMETIC_VALID" | "LOCAL_MATCH" | "REGION_UNAVAILABLE" | "OWNER_REVIEW_REQUIRED" | "DATE_ORDER_INFERRED")[],
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

function itemsAddUp(receipt: { amount: number | null; items: { amount: number }[] }): boolean {
  const itemSum = receipt.items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  const totalCents = receipt.amount === null ? null : Math.round(receipt.amount * 100);
  return receipt.items.length > 0 && totalCents !== null && itemSum === totalCents;
}

/*
 * WHEN THE SECOND GEMINI CALL IS SKIPPED. The verifier exists because one
 * model's reading of a photograph is not evidence on its own. It is skipped
 * when the reading is already checked another way:
 *
 *   - the local read corroborated the date and the total on the paper (the
 *     request carries them only then), Gemini read the same date and total,
 *     and Gemini's own lines add up to that total; or
 *   - Gemini's own lines add up exactly to the total it read. The total is
 *     then corroborated by arithmetic over figures printed on the paper.
 *
 * The second case was approved by the owner on 24 October 2026 after timing
 * real scans: the check cost 3.5-4.6 s on every scan, and the local read,
 * right on 18 of 49 totals, almost never corroborated anything, so the first
 * case alone rarely applied. Any lines that miss the total, and the verifier
 * runs as before.
 *
 * The store name and date are left unchecked by a second reader. Their
 * evidence stays OWNER_REVIEW_REQUIRED, as every provider field's does, and
 * the owner sees and can edit them on the review screen before saving.
 */
function agreesWithLocalRead(
  request: ReceiptProviderRequest,
  receipt: { date: string | null; amount: number | null; items: { amount: number }[] },
): boolean {
  const local = request.localCorroboration;
  if (!local || receipt.date === null || receipt.amount === null) return false;
  return receipt.date === local.date
    && Math.round(receipt.amount * 100) === Math.round(local.total * 100)
    && itemsAddUp(receipt);
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
  localMatch = false,
  dateOrderInferred = false,
): NormalizedReceiptExtraction {
  const source = request.provider as "gemini" | "veryfi";
  const formatEvidence = evidence(
    source,
    request.providerVersion,
    "VALIDATED",
    ["FORMAT_VALID", "REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
  );
  const inferredDateEvidence = evidence(
    source,
    request.providerVersion,
    "VALIDATED",
    ["FORMAT_VALID", "DATE_ORDER_INFERRED", "REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
  );
  // The local read checked this date and total against the paper and the
  // provider read the same values: say so, rather than claim a verifier ran.
  const localMatchEvidence = evidence(
    source,
    request.providerVersion,
    "VALIDATED",
    ["FORMAT_VALID", "LOCAL_MATCH", "REGION_UNAVAILABLE", "OWNER_REVIEW_REQUIRED"],
  );
  const itemsReconcile = itemsAddUp(receipt);
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
    date: {
      value: receipt.date,
      evidence: receipt.date === null
        ? null
        : dateOrderInferred ? inferredDateEvidence : localMatch ? localMatchEvidence : formatEvidence,
    },
    vendor: { value: receipt.vendor, evidence: receipt.vendor === null ? null : formatEvidence },
    currency: { value: currency, evidence: currency === null ? null : currencyEvidence },
    total: { value: receipt.amount, evidence: receipt.amount === null ? null : localMatch ? localMatchEvidence : formatEvidence },
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
      return failed(request, latencyMs, 0, "PROVIDER_SERVER_ERROR", failure.retryAfterMs, stageTimings);
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
 * The units billed when the extraction answered but its check did not.
 *
 * The extraction is one. Authentication and HTTP refusals of the check are
 * definitive, so it cost nothing more. Transport loss, cancellation and a
 * timeout after submission may have reached the provider, and an unusable
 * answer did: those count the check too, so the budget never under-counts.
 */
function uncheckedReadingUnits(failure: VisionVerifierFailure): 1 | 2 {
  switch (failure) {
    case "not_attempted":
    case "auth":
    case "rate_limited":
    case "server":
    case "http":
      return 1;
    case "timeout":
    case "cancelled":
    case "transport":
    case "unusable":
      return 2;
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
      const extraction = await extractReceiptWithVision(pages, {
        timeoutMs: request.timeoutMs,
      });
      if (extraction === null) return ambiguous(request, Date.now() - started);
      const extractionMs = extraction.requestMs ?? Date.now() - started;
      const extractionStages = { extractionMs, verificationMs: 0 };
      if (extraction.failure !== null && extraction.failure !== undefined) {
        return extractionUnavailable(request, Date.now() - started, extraction.failure, extractionStages);
      }
      if (extraction.receipt === null) return invalid(request, Date.now() - started, 1, extractionStages);
      const { receipt, dateOrderInferred } = settleDateOrder(extraction.receipt, request.referenceDate ?? null);

      if (agreesWithLocalRead(request, receipt)) {
        return {
          ...metadata(request, Date.now() - started, null, extractionStages),
          status: "SUCCEEDED",
          timeoutOutcome: "NOT_TIMED_OUT",
          outcomeCode: "OK",
          finalBillableUnits: 1,
          extraction: normalized(request, receipt, false, true, dateOrderInferred),
        } satisfies ReceiptProviderOutcome;
      }

      // Lines that add up to the printed total: see "WHEN THE SECOND GEMINI CALL IS SKIPPED".
      if (itemsAddUp(receipt)) {
        return {
          ...metadata(request, Date.now() - started, null, extractionStages),
          status: "SUCCEEDED",
          timeoutOutcome: "NOT_TIMED_OUT",
          outcomeCode: "OK",
          finalBillableUnits: 1,
          extraction: normalized(request, receipt, false, false, dateOrderInferred),
        } satisfies ReceiptProviderOutcome;
      }

      const verification = await verifyVisionReceipt(pages, receipt, {
        timeoutMs: request.timeoutMs,
      });
      const stageTimings = {
        extractionMs,
        verificationMs: verification.requestMs ?? Math.max(0, Date.now() - started - extractionMs),
      };
      if (verification.failure !== null) {
        /*
         * The check never answered, so the reading stands unchecked rather
         * than being thrown away for the local read, which on 50 public
         * receipts was right far less often (totals 18/49 against 49/49). A
         * scan whose check timed out kept "FENPOUBS LEVEL 3 GATEWAY Moll FOOD"
         * as its store this way. Its fields stay OWNER_REVIEW_REQUIRED, as
         * every provider field's do, and its lines are validated only if they
         * add up. A check that answers and REJECTS still falls back (below).
         */
        return {
          ...metadata(request, Date.now() - started, verification.retryAfterMs ?? null, stageTimings),
          status: "SUCCEEDED",
          timeoutOutcome: "NOT_TIMED_OUT",
          outcomeCode: "OK",
          finalBillableUnits: uncheckedReadingUnits(verification.failure),
          extraction: normalized(request, receipt, false, false, dateOrderInferred),
        } satisfies ReceiptProviderOutcome;
      }
      if (!verification.verdict.accept) return invalid(request, Date.now() - started, 2, stageTimings);
      return {
        ...metadata(request, Date.now() - started, null, stageTimings),
        status: "SUCCEEDED",
        timeoutOutcome: "NOT_TIMED_OUT",
        outcomeCode: "OK",
        finalBillableUnits: 2,
        extraction: normalized(request, receipt, true, false, dateOrderInferred),
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
