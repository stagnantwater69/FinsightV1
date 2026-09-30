import { prisma } from "../../config/prisma";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  downloadReceiptImageBounded,
  inspectReceiptImage,
  type ReceiptImageObjectInfo,
} from "../storage.service";
import {
  confidenceForValue,
  documentConfidence,
  extractReceipt,
  locateItemLines,
  overallConfidence,
  parseLineItems,
  parseReceiptFields,
  PARSER_VERSION,
  PREPROCESS_VERSION,
  reconcileItems,
  type OcrResult,
} from "../ocr.service";
import { PROMPT_VERSION, SCHEMA_VERSION } from "../visionOcr.service";
import { assessImageQuality } from "../../lib/imageQuality";
import { Prisma, ReceiptPurgeMode } from "@prisma/client";
import { logger } from "../../config/logger";
import { persistCategorisedItems } from "./categorisation";
import {
  buildFieldEvidence,
  buildScanWarnings,
  determineRescueTrigger,
  seamRepeatWarnings,
  snapVendorToHistory,
} from "./extraction";
import type { ReceiptCaptureMetadata, ReceiptItemEvidenceInput, RescuedFields } from "./types";
import { selectOcrCandidate } from "./ocrCandidateSelection";
import { readReceiptPagesWithinOcrBudget } from "./ocrPageScheduling";
import { assessReceiptLikelihood } from "../../lib/receiptLikelihood";
import { parseReceiptDetails, providerReportedCurrency } from "../../lib/receiptDetails";
import { validateReceiptUpload } from "../../lib/receiptUploadValidation";
import {
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "../../lib/receiptUploadContract";
import { decideReceiptRescue, RESCUE_DECISION_VERSION } from "../receiptRescueDecision";
import {
  RECEIPT_PROVIDER_CONTRACT_VERSION,
  type NormalizedEvidence,
  type NormalizedReceiptExtraction,
} from "../receiptProviderContract";
import { OVERLAP_RESOLVER_VERSION } from "../../lib/receiptOverlapItems";
import { readLocalItems } from "./localItems";
import {
  dispatchReceiptProviderRescue,
  RECEIPT_PROCESSING_LEASE_MS,
} from "../receiptProviderDispatch.service";
import { getReceiptProviderConfiguration } from "../../config/receiptProvider";
import { createGeminiReceiptAdapter, createVeryfiReceiptAdapter } from "./providerAdapters";
import {
  lockReceiptCaptureBatchForMutation,
  refreshReceiptCaptureBatchStatus,
} from "../receiptCaptureBatch.service";
import { refreshReceiptDuplicateCandidatesForScan } from "../receiptDuplicate.service";

const RECEIPT_WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const MAX_PROCESSING_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000] as const;

export class ReceiptLeaseLostError extends Error {}

type ReceiptProcessingErrorCode =
  | "RECEIPT_EVIDENCE_UNAVAILABLE"
  | "RECEIPT_EVIDENCE_INVALID"
  | "RECEIPT_PROCESSING_FAILED";

class ReceiptProcessingFailure extends Error {
  constructor(readonly code: ReceiptProcessingErrorCode, readonly publicMessage: string) {
    super(code);
  }
}

function safeProcessingFailure(error: unknown): ReceiptProcessingFailure {
  if (error instanceof ReceiptProcessingFailure) return error;
  return new ReceiptProcessingFailure(
    "RECEIPT_PROCESSING_FAILED",
    "The receipt could not be read. Try again or enter the values manually.",
  );
}

/**
 * Enough to diagnose a crash without copying receipt text into the log: the
 * error class, and for schema errors only the paths and codes. Messages are
 * kept only for classes that never carry payload values.
 */
function safeErrorDetail(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { errorType: typeof err };
  const detail: Record<string, unknown> = { errorType: err.constructor.name };
  const issues = (err as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    detail.issues = issues.slice(0, 10).map((issue) => {
      const record = issue as { path?: unknown[]; code?: unknown };
      return { path: Array.isArray(record.path) ? record.path.join(".") : "", code: record.code };
    });
  } else if (
    // PrismaClientValidationError repeats query arguments, so it stays out.
    /^(TypeError|RangeError|ReferenceError|PrismaClientKnownRequestError|PrismaClientInitializationError|PrismaClientRustPanicError)$/.test(err.constructor.name)
  ) {
    detail.errorMessage = err.message.slice(0, 200);
  }
  return detail;
}

type StoredEvidence = { path: string; info: ReceiptImageObjectInfo };
type StoredPage = {
  pageNumber: number;
  original: StoredEvidence;
  processed: StoredEvidence | null;
  metadata?: ReceiptCaptureMetadata;
};
type StoredInput = { businessProfileId: number; pages: StoredPage[] };

export interface ReceiptProcessingLease {
  workerId: string;
  attempt: number;
}

export interface ReceiptPageProcessingOutput {
  pageNumber: number;
  data: Prisma.ReceiptScanPageUpdateManyMutationInput;
}

export interface ReceiptItemProcessingOutput {
  parsedItems: { name: string; quantity: number | null; unitPrice: number | null; amount: number }[];
  vendor: string | null;
  extractedByVision: boolean;
  amountConfidences: (number | null)[];
  itemEvidence: (ReceiptItemEvidenceInput | null)[];
}

export interface ReceiptProcessingOutput {
  scan: Prisma.ReceiptScanUpdateManyMutationInput;
  pages: ReceiptPageProcessingOutput[];
  items: ReceiptItemProcessingOutput;
  /**
   * Whether the provider actually read the paper on this pass. False carries an
   * earlier pass's currency forward, so a re-scan that never reached the
   * provider cannot clear a refusal a pass that did reach it had earned. A pass
   * that did read replaces it, null included: that is a re-reading, not silence.
   */
  providerRead: boolean;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readStoredCandidate(evidence: StoredEvidence, withQuality: boolean) {
  const buffer = await downloadReceiptImageBounded(evidence.path, RECEIPT_UPLOAD_MAX_OBJECT_BYTES, evidence.info);
  await validateReceiptUpload({ buffer, mimetype: evidence.info.mimetype });
  const digest = sha256(buffer);
  const quality = withQuality ? await assessImageQuality(buffer) : null;
  /*
   * The download and validation above stay fatal: without the evidence there
   * is nothing to read. A failure of the READ is the page's, not the
   * receipt's — the page's other image may still read, and the caller decides
   * what a page neither image of which read costs the scan.
   */
  let ocr: OcrResult | null = null;
  let ocrError: unknown = null;
  try {
    ocr = await extractReceipt(buffer);
  } catch (error) {
    ocrError = error;
  }
  // The buffer deliberately does not escape: nothing downstream needs the
  // bytes, and returning them is how they used to stay resident for the whole
  // scan. The provider gate re-downloads the page it actually sends.
  return { ocr, ocrError, digest, quality };
}

/** What an unreadable page contributes to the text: nothing, and no confidence to average. */
const UNREAD_PAGE: OcrResult = { text: "", confidence: 0, lines: [] };

function localEvidence(validated: boolean, arithmetic = false): NormalizedEvidence {
  return {
    source: "local-tesseract",
    sourceVersion: PARSER_VERSION,
    pageNumber: null,
    regionStatus: "UNAVAILABLE",
    region: null,
    confidenceBand: validated ? "MEDIUM" : "LOW",
    calibrationState: "UNCALIBRATED",
    validationState: validated ? "VALIDATED" : "UNVALIDATED",
    validationCodes: [
      arithmetic ? "ARITHMETIC_VALID" : "FORMAT_VALID",
      "REGION_UNAVAILABLE",
      ...(validated ? [] : (["OWNER_REVIEW_REQUIRED"] as const)),
    ],
  };
}

/*
 * What the local read can honestly claim for each field, in the vocabulary
 * the provider merge compares on. The merge keeps a VALIDATED local value over
 * a provider value of equal strength, so anything marked validated here is
 * out of the provider's reach — and the rescue decision above reports an
 * ambiguous date and an unreconciled total as conflicts to be resolved. The
 * two must agree: a field only counts as validated when something on the
 * receipt corroborated it.
 *
 *   - date: validated unless the parser flagged it locale-ambiguous.
 *   - vendor: never validated; it is the parser's guess at a header line and
 *     nothing on the receipt checks it.
 *   - total: contradicted only when items WERE read and do not add up to it;
 *     no items at all leaves it unverified, not disproved. This is the same
 *     predicate the rescue decision uses for `validation`, and the two must
 *     not disagree about the same receipt.
 *   - currency: a symbol or code printed on the receipt; validated as read.
 */
function localNormalizedExtraction(
  parsed: ReturnType<typeof parseReceiptFields>,
  items: ReturnType<typeof parseLineItems>,
  currency: string | null,
  reconciled: boolean,
): NormalizedReceiptExtraction {
  // reconcileItems reports `reconciled: true` for "not-comparable" — no total
  // to check against. That is the absence of arithmetic, not passing it, so
  // items may not claim ARITHMETIC_VALID on a receipt with no printed total.
  const itemsCorroborated = items.length > 0 && parsed.amount !== null && reconciled;
  const itemEvidence = localEvidence(itemsCorroborated, itemsCorroborated);
  const dateValidated = !parsed.dateAmbiguous;
  const totalReconciled = items.length > 0 && reconciled;
  const totalValidated = items.length === 0 || reconciled;
  return {
    schemaVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    source: "local-tesseract",
    sourceVersion: PARSER_VERSION,
    date: { value: parsed.date, evidence: parsed.date ? localEvidence(dateValidated) : null },
    vendor: { value: parsed.vendor, evidence: parsed.vendor ? localEvidence(false) : null },
    currency: { value: currency, evidence: currency ? localEvidence(true) : null },
    total: { value: parsed.amount, evidence: parsed.amount ? localEvidence(totalValidated, totalReconciled) : null },
    items: items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      amount: item.amount,
      evidence: itemEvidence,
    })),
    itemsEvidence: items.length > 0 ? itemEvidence : null,
  };
}

/** True when two ISO dates are the same year with day and month exchanged. */
function isDayMonthSwap(left: string, right: string): boolean {
  const [ly, lm, ld] = left.split("-");
  const [ry, rm, rd] = right.split("-");
  return ly === ry && lm === rd && ld === rm && lm !== ld;
}

function mergeIntoRescuedFields(
  parsed: ReturnType<typeof parseReceiptFields>,
  localItems: ReturnType<typeof parseLineItems>,
  gate: Awaited<ReturnType<typeof dispatchReceiptProviderRescue>>,
  trigger: string | null,
  providerVersion: string | null,
): RescuedFields {
  const applied = new Set(gate.merge.appliedFields);
  const receipt = gate.merge.receipt;
  const items = receipt.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: null,
    amount: item.amount,
  }));
  const providerItems = applied.has("items");
  /*
   * A locale-ambiguous local date ("03/09/2026") is offered to the provider
   * as unvalidated, so its answer normally replaces it. The one answer that
   * settles nothing is the same digits read the other way round: measured
   * across repeat runs the model resolves that case inconsistently, whereas
   * the parser applies the DD/MM convention every time. Then the parser's
   * reading stands and stays flagged for the owner; a provider date that is
   * not the swap is a different reading of the paper and wins as any other
   * field does.
   */
  const providerDateIsSwap =
    applied.has("date")
    && parsed.dateAmbiguous
    && parsed.date !== null
    && receipt.date.value !== null
    && isDayMonthSwap(parsed.date, receipt.date.value);
  const dateApplied = applied.has("date") && !providerDateIsSwap;
  return {
    date: dateApplied ? receipt.date.value : parsed.date,
    vendor: receipt.vendor.value,
    description: receipt.vendor.value ? `Purchase from ${receipt.vendor.value}` : "Receipt purchase",
    amount: receipt.total.value,
    items: providerItems ? items : localItems,
    dateAmbiguous: dateApplied ? false : parsed.dateAmbiguous,
    dateSourceText: dateApplied ? null : parsed.dateSourceText,
    visionAssisted: applied.size > 0,
    itemsFromVision: providerItems,
    visionTrigger: trigger,
    visionLatencyMs: gate.latencyMs,
    visionProvider: gate.dispatched ? gate.provider : null,
    visionModel: gate.dispatched ? providerVersion : null,
    visionRejectReason: null,
    verifier: gate.provider === "gemini" && gate.code === "PROVIDER_OK" ? "accepted" : null,
    visionWarnings: [
      ...(gate.merge.itemsOwnerReviewRequired ? [{ code: "UNVERIFIED_ITEMS" as const }] : []),
      ...(providerItems ? seamRepeatWarnings(gate.merge.seamRepeats) : []),
    ],
    itemEvidence: providerItems
      ? receipt.items.map((item, index) => {
        const flagged = gate.merge.seamRepeats?.flagged.find((repeat) => repeat.itemIndex === index);
        return {
          pageNumber: item.evidence.pageNumber,
          sourceText: null,
          ...(flagged
            ? { possibleRepeatOf: { pageNumber: flagged.originalPageNumber, name: flagged.originalName, amount: flagged.amount } }
            : {}),
        };
      })
      : null,
  };
}

/**
 * Puts a carried-forward currency back into the versions blob this pass built.
 * An absent blob is left absent: the column would otherwise be overwritten
 * with a fragment, losing the very record being preserved.
 */
function withProviderCurrency(
  versions: Prisma.ReceiptScanUpdateManyMutationInput["extractorVersions"],
  currency: string,
): Prisma.InputJsonValue | undefined {
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) return undefined;
  return { ...(versions as Record<string, unknown>), providerCurrency: currency } as Prisma.InputJsonValue;
}

/** Commit every derived receipt value only while this attempt still owns the lease. */
export async function persistReceiptProcessingOutput(
  scanId: number,
  businessProfileId: number,
  lease: ReceiptProcessingLease,
  output: ReceiptProcessingOutput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const batchLink = await tx.receiptScan.findFirst({
      where: {
        id: scanId,
        businessProfileId,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        evidenceDeletionRequestedAt: null,
        purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
      },
      select: { captureBatchId: true, extractorVersions: true },
    });
    if (!batchLink) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);
    // Read under the same lease predicate as the write below, so the value
    // carried forward is the one this attempt is still entitled to overwrite.
    const carriedCurrency = output.providerRead ? null : providerReportedCurrency(batchLink.extractorVersions);
    if (
      batchLink.captureBatchId !== null
      && !(await lockReceiptCaptureBatchForMutation(tx, batchLink.captureBatchId))
    ) {
      throw new ReceiptLeaseLostError(`Receipt scan ${scanId} no longer belongs to its receipt batch`);
    }

    // This conditional UPDATE both proves ownership and locks the scan row
    // until every dependent write below commits or rolls back with it.
    const scanUpdated = await tx.receiptScan.updateMany({
      where: {
        id: scanId,
        businessProfileId,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        evidenceDeletionRequestedAt: null,
        purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
      },
      data: {
        ...output.scan,
        ...(carriedCurrency === null ? {} : { extractorVersions: withProviderCurrency(output.scan.extractorVersions, carriedCurrency) }),
        processingStatus: "Processing",
        processingCompletedAt: null,
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
        processingHeartbeatAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
    if (scanUpdated.count !== 1) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);

    for (const page of output.pages) {
      const pageUpdated = await tx.receiptScanPage.updateMany({
        where: { receiptScanId: scanId, pageNumber: page.pageNumber },
        data: page.data,
      });
      if (pageUpdated.count !== 1) throw new Error("Receipt scan page missing during processing commit");
    }

    await persistCategorisedItems(
      businessProfileId,
      scanId,
      output.items.parsedItems,
      output.items.vendor,
      output.items.extractedByVision,
      output.items.amountConfidences,
      output.items.itemEvidence,
      tx,
    );

    const completedAt = new Date();
    const completed = await tx.receiptScan.updateMany({
      where: {
        id: scanId,
        businessProfileId,
        processingStatus: "Processing",
        confirmationStatus: "Pending",
        evidenceDeletionRequestedAt: null,
        purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
      },
      data: {
        processingStatus: "Complete",
        processingCompletedAt: completedAt,
        processingError: null,
        processingWorkerId: null,
        processingHeartbeatAt: null,
        // Completion starts the abandoned-scan clock: seven days of owner
        // silence from here and the sweep purges it.
        lastActivityAt: completedAt,
      },
    });
    if (completed.count !== 1) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);
    await refreshReceiptDuplicateCandidatesForScan(tx, scanId, businessProfileId);
    if (batchLink.captureBatchId !== null) {
      await refreshReceiptCaptureBatchStatus(tx, batchLink.captureBatchId);
    }
  }, { timeout: 15_000 });
}

/**
 * Validate and OCR one stored candidate at a time, preserve that local draft,
 * then offer only a doubtful result to the selected provider through the
 * consent and budget gate.
 *
 * Runs after the HTTP response has already gone out, so it CANNOT report a
 * failure by throwing — nobody is listening. Every failure path instead lands
 * the scan in "Failed" with a message the polling client can show, which is
 * why the whole body sits inside one try/catch rather than letting individual
 * steps propagate.
 *
 * The row itself is the queue. A conditional update claims a short lease, so
 * multiple worker instances cannot process the same scan and a restart can
 * reclaim work after the heartbeat expires. Every attempt restores the
 * receipt from private Storage after the worker owns the lease.
 */
async function processScan(
  scanId: number,
  input: StoredInput,
  attempt: number,
  claimedAt: number = performance.now(),
): Promise<void> {
  // OCR on one difficult photo can outlast the normal scheduler interval.
  // Refresh independently of page boundaries so another replica never
  // mistakes a healthy long-running read for an abandoned lease.
  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    void heartbeatScan(scanId, attempt).catch((error) => {
      if (error instanceof ReceiptLeaseLostError) {
        leaseLost = true;
        return;
      }
      logger.error({ scanId, code: "RECEIPT_HEARTBEAT_FAILED" }, "receipt scan heartbeat failed");
    });
  }, 30_000);
  heartbeatTimer.unref();
  let logProviderGate: ((persisted: boolean) => void) | null = null;
  try {
    const ocrResults: OcrResult[] = [];
    const originalOcrResults: (OcrResult | null)[] = [];
    const processedOcrResults: (OcrResult | null)[] = [];
    /** Pages neither image of which could be read, on the attempt that may not retry. */
    const unreadPages: number[] = [];
    const ocrSources: ("original" | "processed")[] = [];
    const pageQualities: Awaited<ReturnType<typeof assessImageQuality>>[] = [];
    const selectedEvidence: {
      pageNumber: number;
      dataClass: "RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE";
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      inputSha256: string;
      loadBytes: () => Promise<Buffer>;
    }[] = [];
    // Stage clocks for the gate log line: millisecond counts only, no receipt content.
    let ocrMs = 0;
    let providerMs = 0;
    let persistMs = 0;
    const ocrStartedAt = performance.now();
    const pageReads = await readReceiptPagesWithinOcrBudget(input.pages, async (page) => {
      const [original, processed] = await Promise.all([
        readStoredCandidate(page.original, true),
        page.processed ? readStoredCandidate(page.processed, false) : Promise.resolve(null),
      ]);
      return { page, original, processed };
    });
    ocrMs = performance.now() - ocrStartedAt;
    for (const { page, original, processed } of pageReads) {
      /*
       * One page's failed read no longer costs the whole receipt.
       *
       * Where one of a page's two images read, that reading is used. Where
       * neither did, the attempt fails and is retried as before — most such
       * failures are transient — until the last attempt, which keeps every
       * page that DID read and names the one that did not, rather than
       * discarding a long receipt for one bad photograph. The unread page
       * still goes to the provider gate as evidence, where a model may read
       * it.
       */
      if (!original.ocr && !processed?.ocr) {
        if (attempt < MAX_PROCESSING_ATTEMPTS) throw original.ocrError ?? processed?.ocrError;
        unreadPages.push(page.pageNumber);
      }
      if (original.ocrError !== null || (processed !== null && processed.ocrError !== null)) {
        logger.warn(
          { scanId, pageNumber: page.pageNumber, code: "RECEIPT_PAGE_OCR_FAILED", ...safeErrorDetail(original.ocrError ?? processed?.ocrError) },
          "receipt page image could not be read",
        );
      }
      const selected = original.ocr
        ? selectOcrCandidate(original.ocr, processed?.ocr ?? null)
        : processed?.ocr
          ? { source: "processed" as const, result: processed.ocr }
          : { source: "original" as const, result: UNREAD_PAGE };
      const chosenEvidence = selected.source === "processed" && page.processed ? page.processed : page.original;
      const chosen = selected.source === "processed" && processed ? processed : original;
      originalOcrResults.push(original.ocr);
      processedOcrResults.push(processed?.ocr ?? null);
      ocrResults.push(selected.result);
      ocrSources.push(selected.source);
      pageQualities.push(original.quality!);
      selectedEvidence.push({
        pageNumber: page.pageNumber,
        dataClass: selected.source === "processed" ? "DERIVED_RECEIPT_IMAGE" : "RECEIPT_IMAGE",
        mediaType: chosenEvidence.info.mimetype,
        inputSha256: chosen.digest,
        /*
         * RE-DOWNLOADED ON DEMAND, not held from the read above.
         *
         * Closing over the decoded buffer kept every page's bytes alive for
         * the whole scan — through parsing, reconciliation, the provider
         * decision and persistence — and kept them even on the majority of
         * scans where the gate decides not to call a provider at all. At the
         * 10 MiB per-object ceiling and 8 pages that is 80 MiB of resident
         * heap per concurrent scan, bought for nothing.
         *
         * The peak at dispatch is unchanged: the gate loads every page before
         * it calls the adapter either way. What changes is that the bytes are
         * collectable the moment this page's OCR is done.
         *
         * This also makes the gate's re-hash against `inputSha256` a real
         * check rather than the tautology it was when the same buffer was
         * handed straight back: a re-read that does not match the digest this
         * scan was parsed from refuses the dispatch, which is the behaviour
         * that guard exists for.
         */
        loadBytes: () =>
          downloadReceiptImageBounded(chosenEvidence.path, RECEIPT_UPLOAD_MAX_OBJECT_BYTES, chosenEvidence.info),
      });
      await heartbeatScan(scanId, attempt);
    }

    /*
     * One continuous document from here on, not N photographs — see
     * readLocalItems for why the page texts are joined rather than the IMAGES
     * stitched (docs/multi-page-receipts-plan.md §7), and how overlap between
     * sections is settled against the printed total.
     */
    const pageTexts = ocrResults.map((r) => r.text);
    const combinedText = pageTexts.join("\n");
    const combinedLines = ocrResults.flatMap((r) => r.lines);
    const parsed = parseReceiptFields(combinedText);
    const localItems = readLocalItems(pageTexts, parsed.amount);
    const deterministicItems = localItems.items;
    const seamFreeText = localItems.seamFreeText;
    const localOverlapResolution = localItems.overlapResolution;
    const localSeamReport = localItems.seamReport;

    const pageConfidences = ocrResults.map((r) => overallConfidence(r));
    const worstPageConfidence = Math.min(...pageConfidences);
    const reconciliation = reconcileItems(combinedText, deterministicItems, parsed.amount);
    const currency = parseReceiptDetails(combinedText).currency;
    const providerConfig = getReceiptProviderConfiguration();
    const rescueDecision = decideReceiptRescue({
      validation: parsed.amount !== null && (deterministicItems.length === 0 || reconciliation.reconciled) ? "VALIDATED" : "FAILED",
      missingCriticalFields: [
        ...(parsed.date === null ? (["date"] as const) : []),
        ...(parsed.vendor === null ? (["vendor"] as const) : []),
        ...(currency === null ? (["currency"] as const) : []),
        ...(parsed.amount === null ? (["total"] as const) : []),
      ],
      conflictingCriticalFields: [
        ...(parsed.dateAmbiguous ? (["date"] as const) : []),
        ...(!reconciliation.reconciled && deterministicItems.length > 0 && parsed.amount !== null
          ? (["total"] as const)
          : []),
      ],
      handwriting: "UNKNOWN",
      damage: "UNKNOWN",
      calibration:
        providerConfig.routingCalibrated && providerConfig.calibrationVersion
          ? { state: "CALIBRATED", version: providerConfig.calibrationVersion }
          : { state: "UNCALIBRATED", version: null },
    }, {
      // Always-routing is a policy reason, not evidence, so it only counts
      // while the provider can actually be dispatched to.
      routing: providerConfig.operational ? providerConfig.routing : "rescue",
    });
    const localExtraction = localNormalizedExtraction(parsed, deterministicItems, currency, reconciliation.reconciled);
    const adapter = providerConfig.provider === "veryfi" ? createVeryfiReceiptAdapter() : createGeminiReceiptAdapter();
    const dispatchStartedAt = performance.now();
    const gate = await dispatchReceiptProviderRescue(
      {
        businessProfileId: input.businessProfileId,
        receiptScanId: scanId,
        processingLease: { workerId: RECEIPT_WORKER_ID, attempt },
        rescueDecision,
        localExtraction,
        pages: selectedEvidence,
        preprocessingVersion: PREPROCESS_VERSION,
        normalizedSchemaVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
      },
      { adapter, loadConfiguration: getReceiptProviderConfiguration },
    );
    providerMs = performance.now() - dispatchStartedAt;
    // Operators need to see why a rescue did or did not run without opening
    // the scan row; ids, gate code, and stage timings only. Emitted after
    // persistence so persistMs is real; the catch below emits it on failure.
    logProviderGate = (persisted: boolean) => {
      logProviderGate = null;
      logger.info(
        {
          scanId,
          code: gate.code,
          dispatched: gate.dispatched,
          provider: gate.provider,
          rescueRequested: rescueDecision.providerRescueRequested,
          reasons: rescueDecision.reasons,
          mergeReason: gate.merge.reason,
          appliedFields: gate.merge.appliedFields,
          providerItemCount: gate.merge.receipt.items.length,
          localItemCount: deterministicItems.length,
          persisted,
          ocrMs: Math.round(ocrMs),
          providerMs: Math.round(providerMs),
          providerTelemetry: gate.telemetry ?? null,
          persistMs: Math.round(persistMs),
          totalMs: Math.round(performance.now() - claimedAt),
        },
        "receipt provider gate",
      );
    };
    const trigger = determineRescueTrigger(deterministicItems, parsed, combinedText, worstPageConfidence);
    const rescued = mergeIntoRescuedFields(parsed, deterministicItems, gate, trigger, providerConfig.providerVersion);
    const vendor = await snapVendorToHistory(input.businessProfileId, combinedText, rescued.vendor);

    const fieldEvidence = buildFieldEvidence(pageTexts, parsed, rescued, vendor);
    const warnings = buildScanWarnings({
      pageQualities,
      pageTexts,
      combinedText,
      seamFreeText,
      parsed,
      rescued: rescued.itemsFromVision
        ? rescued
        : { ...rescued, visionWarnings: [...rescued.visionWarnings, ...seamRepeatWarnings(localSeamReport)] },
      worstPageConfidence,
      pageConfidences: pageConfidences.map((confidence, index) =>
        unreadPages.includes(input.pages[index]!.pageNumber) ? null : confidence),
      unreadPages,
    });

    // Persist versions and safe gate outcomes with the scan for calibration.
    const extractorVersions = {
      provider: rescued.visionProvider,
      model: rescued.visionModel,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      preprocessVersion: PREPROCESS_VERSION,
      visionTrigger: rescued.visionTrigger,
      visionLatencyMs: rescued.visionLatencyMs,
      visionRejectReason: rescued.visionRejectReason,
      verifier: rescued.verifier,
      providerGateCode: gate.code,
      providerOutcomeCode: gate.telemetry?.outcomeCode ?? null,
      providerCooldown: gate.telemetry?.cooldown ?? null,
      providerStageTimings: gate.telemetry?.providerStages ?? null,
      providerGateTimings: gate.telemetry?.gateStages ?? null,
      providerDispatchStatus: gate.dispatchStatus,
      rescueDecisionVersion: RESCUE_DECISION_VERSION,
      rescueReasonCodes: rescueDecision.reasons,
      providerContractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
      // Read back at confirm time by requiresManualCurrencyConversion: the merge
      // cannot adopt it, but it still has to block a peso booking. Superseded by
      // the prior pass's value when this one never read the paper (`providerRead`).
      providerCurrency: gate.merge.providerCurrency,
      ocrCandidateSources: ocrSources,
      overlapResolverVersion: OVERLAP_RESOLVER_VERSION,
      overlapResolution: rescued.itemsFromVision
        ? gate.merge.seamRepeats?.resolution ?? "none"
        : localOverlapResolution,
    };
    const receiptLikelihood = assessReceiptLikelihood({
      rawText: combinedText,
      documentConfidence: Math.max(...input.pages.map((page) => page.metadata?.documentConfidence ?? 0)),
    });

    if (leaseLost) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);
    await heartbeatScan(scanId, attempt);
    const itemEvidence = rescued.itemsFromVision
      ? rescued.itemEvidence ?? []
      : locateItemLines(pageTexts, rescued.items.map((item) => item.amount));
    const persistStartedAt = performance.now();
    await persistReceiptProcessingOutput(
      scanId,
      input.businessProfileId,
      { workerId: RECEIPT_WORKER_ID, attempt },
      {
        scan: {
          extractedDate: rescued.date ? new Date(rescued.date) : undefined,
          extractedVendor: vendor ?? undefined,
          // Rebuilt from the settled vendor, so a name corrected from history is
          // the one the owner sees rather than the raw OCR reading.
          extractedDescription: vendor ? `Purchase from ${vendor}` : rescued.description ?? undefined,
          extractedAmount: rescued.amount ?? undefined,
          rawText: combinedText,
          visionAssisted: rescued.visionAssisted,
          // Null on a vision-assisted read: the figure would describe text
          // tesseract could not make sense of, which is not what it looks like.
          // The whole receipt's word mean, not its worst page: each page keeps
          // its own figure on ReceiptScanPage and its own LOW_CONFIDENCE warning.
          ocrConfidence: rescued.visionAssisted ? null : documentConfidence(ocrResults),
          // Per field, for calibration. The whole-scan figure above cannot say
          // whether confidence predicts a wrong answer for the VENDOR
          // specifically, because one number per scan says nothing about which
          // field on it was doubtful. Same null rule, and for the same reason.
          vendorConfidence: rescued.visionAssisted ? null : confidenceForValue(combinedLines, vendor),
          amountConfidence: rescued.visionAssisted
            ? null
            : confidenceForValue(combinedLines, rescued.amount?.toFixed(2) ?? null),
          extractorVersions: extractorVersions as Prisma.InputJsonValue,
          // An empty evidence object is left as NULL, not {} — "nothing could
          // be located" and "never assessed" read the same to a client, and
          // null is the established spelling for the second.
          fieldEvidence: Object.keys(fieldEvidence).length > 0 ? (fieldEvidence as Prisma.InputJsonValue) : undefined,
          // Always an array, even when empty: [] means "assessed, nothing to
          // warn about", which is a different statement from a legacy null.
          warnings: warnings as unknown as Prisma.InputJsonValue,
          receiptLikelihood: receiptLikelihood as unknown as Prisma.InputJsonValue,
          processingErrorCode:
            gate.code === "PROVIDER_OK" || gate.code === "PROVIDER_NOT_REQUESTED" ? null : gate.code,
        },
        pages: ocrResults.map((result, index) => ({
          pageNumber: input.pages[index]!.pageNumber,
          data: {
            rawText: result.text,
            // Null, not zero, for a page that could not be read: never measured.
            ocrConfidence: unreadPages.includes(input.pages[index]!.pageNumber) ? null : overallConfidence(result),
            originalRawText: originalOcrResults[index]?.text ?? null,
            originalOcrConfidence: originalOcrResults[index] ? overallConfidence(originalOcrResults[index]!) : null,
            ocrSource: ocrSources[index]!,
            processedRawText: processedOcrResults[index]?.text ?? null,
            processedOcrConfidence: processedOcrResults[index]
              ? overallConfidence(processedOcrResults[index]!)
              : null,
            sharpness: pageQualities[index]?.sharpness ?? null,
            brightness: pageQualities[index]?.brightness ?? null,
            tooBlurredToTrust: pageQualities[index]?.tooBlurredToTrust ?? null,
          },
        })),
        items: {
          parsedItems: rescued.items,
          vendor,
          extractedByVision: rescued.itemsFromVision,
          amountConfidences: rescued.itemsFromVision
            ? []
            : rescued.items.map((item) => confidenceForValue(combinedLines, item.amount.toFixed(2))),
          // Vision items carry the provider's page evidence; OCR items are
          // located in the page text. Unverifiable items remain evidence-less.
          itemEvidence,
        },
        // A skipped, failed, cancelled or timed-out dispatch produced no
        // reading of the paper, so it may not overwrite what an earlier pass
        // read. Only SUCCEEDED means the provider answered and was accepted.
        providerRead: gate.dispatchStatus === "SUCCEEDED",
      },
    );
    persistMs = performance.now() - persistStartedAt;
    logProviderGate?.(true);
  } catch (err) {
    logProviderGate?.(false);
    // A newer worker owns the row now. The stale worker must not overwrite its
    // state with either a success or failure from an expired lease.
    if (err instanceof ReceiptLeaseLostError) return;
    const failure = safeProcessingFailure(err);
    logger.error({ scanId, code: failure.code, ...safeErrorDetail(err) }, "receipt scan processing failed");
    await recordProcessingFailure(scanId, attempt, failure);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function recordProcessingFailure(scanId: number, attempt: number, failure: ReceiptProcessingFailure): Promise<void> {
  const retryable = attempt < MAX_PROCESSING_ATTEMPTS;
  await prisma.$transaction(async (tx) => {
    const batchLink = await tx.receiptScan.findUnique({
      where: { id: scanId },
      select: { captureBatchId: true },
    });
    if (
      batchLink?.captureBatchId !== null
      && batchLink?.captureBatchId !== undefined
      && !(await lockReceiptCaptureBatchForMutation(tx, batchLink.captureBatchId))
    ) {
      return;
    }
    const transitionAt = new Date();
    const updated = await tx.receiptScan.updateMany({
      where: {
        id: scanId,
        confirmationStatus: "Pending",
        evidenceDeletionRequestedAt: null,
        purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
        processingWorkerId: RECEIPT_WORKER_ID,
        processingAttemptCount: attempt,
      },
      data: {
        processingStatus: retryable ? "Processing" : "Failed",
        processingCompletedAt: retryable ? null : transitionAt,
        processingWorkerId: null,
        processingHeartbeatAt: null,
        nextProcessingAttemptAt: new Date(
          transitionAt.getTime() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!,
        ),
        processingError: failure.publicMessage,
        processingErrorCode: failure.code,
        lastActivityAt: transitionAt,
      },
    });
    if (updated.count === 1 && batchLink?.captureBatchId !== null && batchLink?.captureBatchId !== undefined) {
      await refreshReceiptCaptureBatchStatus(tx, batchLink.captureBatchId);
    }
  });
}

async function heartbeatScan(scanId: number, attempt: number): Promise<void> {
  const updated = await prisma.receiptScan.updateMany({
    where: {
      id: scanId,
      processingStatus: "Processing",
      confirmationStatus: "Pending",
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
      processingWorkerId: RECEIPT_WORKER_ID,
      processingAttemptCount: attempt,
    },
    data: { processingHeartbeatAt: new Date(), lastActivityAt: new Date() },
  });
  if (updated.count !== 1) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);
}

function storedReceiptMimeType(path: string): "image/jpeg" | "image/png" | "image/webp" | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return null;
}

async function inspectStoredEvidence(path: string): Promise<StoredEvidence> {
  const expectedMime = storedReceiptMimeType(path);
  if (!expectedMime) {
    throw new ReceiptProcessingFailure("RECEIPT_EVIDENCE_INVALID", "Stored receipt evidence could not be validated.");
  }
  let info: ReceiptImageObjectInfo;
  try {
    info = await inspectReceiptImage(path);
  } catch {
    throw new ReceiptProcessingFailure(
      "RECEIPT_EVIDENCE_UNAVAILABLE",
      "Stored receipt evidence is temporarily unavailable.",
    );
  }
  if (info.mimetype !== expectedMime || info.sizeBytes > RECEIPT_UPLOAD_MAX_OBJECT_BYTES) {
    throw new ReceiptProcessingFailure("RECEIPT_EVIDENCE_INVALID", "Stored receipt evidence could not be validated.");
  }
  return { path, info };
}

async function storedInput(scanId: number, attempt: number): Promise<StoredInput> {
  const scan = await prisma.receiptScan.findUnique({
    where: { id: scanId },
    include: {
      pages: { orderBy: { pageNumber: "asc" } },
      purgeJobs: { select: { mode: true } },
    },
  });
  if (
    !scan?.businessProfileId ||
    scan.confirmationStatus !== "Pending" ||
    scan.evidenceDeletionRequestedAt !== null ||
    scan.purgeJobs.some((job) => job.mode === ReceiptPurgeMode.DELETE_SCAN) ||
    scan.pages.length === 0 ||
    scan.pages.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES ||
    scan.pages.some((page, index) => page.pageNumber !== index + 1)
  ) {
    throw new ReceiptProcessingFailure("RECEIPT_EVIDENCE_INVALID", "Stored receipt evidence could not be validated.");
  }
  const pages: StoredPage[] = [];
  let aggregateBytes = 0;
  for (const page of scan.pages) {
    const original = await inspectStoredEvidence(page.imageFile);
    const processed = page.processedImageFile ? await inspectStoredEvidence(page.processedImageFile) : null;
    aggregateBytes += original.info.sizeBytes + (processed?.info.sizeBytes ?? 0);
    if (aggregateBytes > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES) {
      throw new ReceiptProcessingFailure("RECEIPT_EVIDENCE_INVALID", "Stored receipt evidence could not be validated.");
    }
    pages.push({
      pageNumber: page.pageNumber,
      original,
      processed,
      ...((page.captureMetadata as ReceiptCaptureMetadata | null)
        ? { metadata: page.captureMetadata as ReceiptCaptureMetadata }
        : {}),
    });
    await heartbeatScan(scanId, attempt);
  }
  return { businessProfileId: scan.businessProfileId, pages };
}

/** Atomically lease one eligible scan. The conditional update is the race guard. */
async function claimScan(): Promise<{ id: number; attempt: number } | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECEIPT_PROCESSING_LEASE_MS);
  const eligible: Prisma.ReceiptScanWhereInput = {
    processingStatus: "Processing",
    confirmationStatus: "Pending",
    evidenceDeletionRequestedAt: null,
    purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    nextProcessingAttemptAt: { lte: now },
    // A crash mid-OCR never reaches recordProcessingFailure, so the ceiling
    // has to live in the claim too, or one poison image is reclaimed forever.
    processingAttemptCount: { lt: MAX_PROCESSING_ATTEMPTS },
    OR: [{ processingWorkerId: null }, { processingHeartbeatAt: null }, { processingHeartbeatAt: { lt: staleBefore } }],
  };
  const candidate = await prisma.receiptScan.findFirst({
    where: eligible,
    orderBy: [{ nextProcessingAttemptAt: "asc" }, { id: "asc" }],
    select: { id: true, processingAttemptCount: true },
  });
  if (!candidate) return null;
  const claimed = await prisma.receiptScan.updateMany({
    where: { id: candidate.id, ...eligible },
    data: {
      processingWorkerId: RECEIPT_WORKER_ID,
      processingStartedAt: now,
      processingCompletedAt: null,
      processingHeartbeatAt: now,
      processingAttemptCount: { increment: 1 },
      lastActivityAt: now,
    },
  });
  return claimed.count === 1 ? { id: candidate.id, attempt: candidate.processingAttemptCount + 1 } : null;
}

async function claimAndProcessScan(): Promise<boolean> {
  const claimedAt = performance.now();
  const claimed = await claimScan();
  if (!claimed) return false;
  let input: StoredInput;
  try {
    input = await storedInput(claimed.id, claimed.attempt);
  } catch (err) {
    if (err instanceof ReceiptLeaseLostError) return true;
    const failure = safeProcessingFailure(err);
    logger.error({ scanId: claimed.id, code: failure.code }, "receipt scan evidence restore failed");
    await recordProcessingFailure(claimed.id, claimed.attempt, failure);
    return true;
  }
  await processScan(claimed.id, input, claimed.attempt, claimedAt);
  return true;
}

/** Runs at most one durable job; the dedicated worker calls this repeatedly. */
export async function runReceiptWorkerOnce(): Promise<boolean> {
  await failExhaustedScans();
  return claimAndProcessScan();
}

/**
 * A scan whose worker died mid-attempt on its last allowed attempt has a
 * stale lease and a full attempt counter. Nothing else will touch it, so it
 * becomes Failed here, where the owner can retry it or delete it.
 */
async function failExhaustedScans(): Promise<number> {
  const completedAt = new Date();
  const staleBefore = new Date(completedAt.getTime() - RECEIPT_PROCESSING_LEASE_MS);
  const failed = await prisma.receiptScan.updateMany({
    where: {
      processingStatus: "Processing",
      confirmationStatus: "Pending",
      processingAttemptCount: { gte: MAX_PROCESSING_ATTEMPTS },
      // The same purge predicates claimScan and storedInput carry. Without
      // them this transition was the one write in the pipeline that could
      // touch a scan already scheduled for deletion: it would set a fresh
      // lastActivityAt and an owner-facing error on a row the purge worker is
      // about to remove, resurrecting it into the owner's list of failed
      // scans — and, if the purge lost its race, leaving it there.
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
      OR: [{ processingWorkerId: null }, { processingHeartbeatAt: null }, { processingHeartbeatAt: { lt: staleBefore } }],
    },
    data: {
      processingStatus: "Failed",
      processingCompletedAt: completedAt,
      processingWorkerId: null,
      processingHeartbeatAt: null,
      processingError: "The receipt could not be read. Try again or enter the values manually.",
      processingErrorCode: "RECEIPT_PROCESSING_FAILED",
      lastActivityAt: completedAt,
    },
  });
  if (failed.count > 0) logger.warn({ count: failed.count }, "receipt scans failed after exhausting processing attempts");
  return failed.count;
}
