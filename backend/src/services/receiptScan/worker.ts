import { prisma } from "../../config/prisma";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  downloadReceiptImageBounded,
  inspectReceiptImage,
  type ReceiptImageObjectInfo,
} from "../storage.service";
import {
  confidenceForValue,
  extractReceipt,
  joinPagesWithoutSeams,
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
import { Prisma } from "@prisma/client";
import { logger } from "../../config/logger";
import { persistCategorisedItems } from "./categorisation";
import {
  buildFieldEvidence,
  buildScanWarnings,
  determineRescueTrigger,
  snapVendorToHistory,
} from "./extraction";
import type { ReceiptCaptureMetadata, RescuedFields } from "./types";
import { selectOcrCandidate } from "./ocrCandidateSelection";
import { assessReceiptLikelihood } from "../../lib/receiptLikelihood";
import { parseReceiptDetails } from "../../lib/receiptDetails";
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
import { dispatchReceiptProviderRescue } from "../receiptProviderDispatch.service";
import { getReceiptProviderConfiguration } from "../../config/receiptProvider";
import { createGeminiReceiptAdapter, createVeryfiReceiptAdapter } from "./providerAdapters";

const RECEIPT_WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const RECEIPT_LEASE_MS = 2 * 60 * 1000;
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
  itemEvidence: ({ pageNumber: number | null; sourceText: string | null } | null)[];
}

export interface ReceiptProcessingOutput {
  scan: Prisma.ReceiptScanUpdateManyMutationInput;
  pages: ReceiptPageProcessingOutput[];
  items: ReceiptItemProcessingOutput;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readStoredCandidate(evidence: StoredEvidence, withQuality: boolean) {
  const buffer = await downloadReceiptImageBounded(evidence.path, RECEIPT_UPLOAD_MAX_OBJECT_BYTES, evidence.info);
  await validateReceiptUpload({ buffer, mimetype: evidence.info.mimetype });
  const digest = sha256(buffer);
  const quality = withQuality ? await assessImageQuality(buffer) : null;
  const ocr = await extractReceipt(buffer);
  return { ocr, digest, quality };
}

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

function localNormalizedExtraction(
  parsed: ReturnType<typeof parseReceiptFields>,
  items: ReturnType<typeof parseLineItems>,
  currency: string | null,
  reconciled: boolean,
): NormalizedReceiptExtraction {
  const itemEvidence = localEvidence(reconciled, reconciled);
  return {
    schemaVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
    source: "local-tesseract",
    sourceVersion: PARSER_VERSION,
    date: { value: parsed.date, evidence: parsed.date ? localEvidence(true) : null },
    vendor: { value: parsed.vendor, evidence: parsed.vendor ? localEvidence(true) : null },
    currency: { value: currency, evidence: currency ? localEvidence(true) : null },
    total: { value: parsed.amount, evidence: parsed.amount ? localEvidence(true, reconciled) : null },
    items: items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      amount: item.amount,
      evidence: itemEvidence,
    })),
    itemsEvidence: items.length > 0 ? itemEvidence : null,
  };
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
  return {
    date: receipt.date.value,
    vendor: receipt.vendor.value,
    description: receipt.vendor.value ? `Purchase from ${receipt.vendor.value}` : "Receipt purchase",
    amount: receipt.total.value,
    items: providerItems ? items : localItems,
    dateAmbiguous: applied.has("date") ? false : parsed.dateAmbiguous,
    dateSourceText: applied.has("date") ? null : parsed.dateSourceText,
    visionAssisted: applied.size > 0,
    itemsFromVision: providerItems,
    visionTrigger: trigger,
    visionLatencyMs: gate.latencyMs,
    visionProvider: gate.dispatched ? gate.provider : null,
    visionModel: gate.dispatched ? providerVersion : null,
    visionRejectReason: null,
    verifier: gate.provider === "gemini" && gate.code === "PROVIDER_OK" ? "accepted" : null,
    visionWarnings: [],
    itemEvidence: providerItems
      ? receipt.items.map((item) => ({ pageNumber: item.evidence.pageNumber, sourceText: null }))
      : null,
  };
}

/** Commit every derived receipt value only while this attempt still owns the lease. */
export async function persistReceiptProcessingOutput(
  scanId: number,
  businessProfileId: number,
  lease: ReceiptProcessingLease,
  output: ReceiptProcessingOutput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // This conditional UPDATE both proves ownership and locks the scan row
    // until every dependent write below commits or rolls back with it.
    const scanUpdated = await tx.receiptScan.updateMany({
      where: {
        id: scanId,
        businessProfileId,
        processingStatus: "Processing",
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
      },
      data: {
        ...output.scan,
        processingStatus: "Processing",
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
        processingHeartbeatAt: new Date(),
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

    const completed = await tx.receiptScan.updateMany({
      where: {
        id: scanId,
        businessProfileId,
        processingStatus: "Processing",
        processingWorkerId: lease.workerId,
        processingAttemptCount: lease.attempt,
      },
      data: {
        processingStatus: "Complete",
        processingError: null,
        processingWorkerId: null,
        processingHeartbeatAt: null,
      },
    });
    if (completed.count !== 1) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);
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
async function processScan(scanId: number, input: StoredInput, attempt: number): Promise<void> {
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
  try {
    const ocrResults: OcrResult[] = [];
    const originalOcrResults: OcrResult[] = [];
    const processedOcrResults: (OcrResult | null)[] = [];
    const ocrSources: ("original" | "processed")[] = [];
    const pageQualities: Awaited<ReturnType<typeof assessImageQuality>>[] = [];
    const selectedEvidence: {
      pageNumber: number;
      dataClass: "RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE";
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      inputSha256: string;
      loadBytes: () => Promise<Buffer>;
    }[] = [];
    for (const page of input.pages) {
      const original = await readStoredCandidate(page.original, true);
      await heartbeatScan(scanId, attempt);
      const processed = page.processed ? await readStoredCandidate(page.processed, false) : null;
      const selected = selectOcrCandidate(original.ocr, processed?.ocr ?? null);
      const chosenEvidence = selected.source === "processed" && page.processed ? page.processed : page.original;
      const chosenDigest = selected.source === "processed" && processed ? processed.digest : original.digest;
      originalOcrResults.push(original.ocr);
      processedOcrResults.push(processed?.ocr ?? null);
      ocrResults.push(selected.result);
      ocrSources.push(selected.source);
      pageQualities.push(original.quality!);
      selectedEvidence.push({
        pageNumber: page.pageNumber,
        dataClass: selected.source === "processed" ? "DERIVED_RECEIPT_IMAGE" : "RECEIPT_IMAGE",
        mediaType: chosenEvidence.info.mimetype,
        inputSha256: chosenDigest,
        loadBytes: () => downloadReceiptImageBounded(chosenEvidence.path, RECEIPT_UPLOAD_MAX_OBJECT_BYTES, chosenEvidence.info),
      });
      await heartbeatScan(scanId, attempt);
    }

    /*
     * One continuous document from here on, not N photographs.
     *
     * Every parser below — dates, totals, line items, reconciliation — already
     * reads a receipt as lines of text with no concept of "photograph
     * boundary". Concatenating in page order is what lets a total printed on
     * page 3 reconcile against items spanning pages 1 and 2 without a single
     * line of any of those functions changing. The alternative, stitching the
     * IMAGES into one before OCR, was rejected in the plan this implements
     * (docs/multi-page-receipts-plan.md §7): overlapping photos would then
     * double-count items, which concatenating plain text cannot do.
     */
    const combinedText = ocrResults.map((r) => r.text).join("\n");
    const combinedLines = ocrResults.flatMap((r) => r.lines);
    const parsed = parseReceiptFields(combinedText);

    /*
     * OVERLAP BETWEEN SECTIONS, and why removing it needs permission.
     *
     * The camera asks for 15-25% overlap between the sections of a long
     * receipt so the owner can see where to continue photographing. Those
     * repeated lines are read twice, and concatenating page text in order
     * therefore counts a handful of items twice on a receipt captured that
     * way.
     *
     * The obvious fix — find the repeat, drop it — is a heuristic deciding
     * which money lines survive, so it is settled the same way this codebase
     * settles any choice between two OCR readings of the same pages: an
     * OBJECTIVE test, never a preference. This is a choice between two local
     * deterministic readings and happens before the provider gate. The
     * objective test here is the receipt's own printed
     * total. If the plain reading fails to account for it and the
     * de-overlapped reading does, that is arithmetic agreeing with the paper,
     * not a judgement that one reading looks tidier.
     *
     * Where BOTH readings fail to reconcile there is no evidence the removal
     * helped, so the plain reading stands and the gap surfaces on the confirm
     * screen as it always has — the owner sees every line and decides. That
     * is the financial-safety direction: a duplicate the owner can see and
     * delete beats a real purchase this deleted quietly.
     *
     * `combinedText` — the full, unedited concatenation — is what gets stored
     * as rawText regardless, so the audit trail never loses lines this chose
     * not to count.
     */
    const plainItems = parseLineItems(combinedText);
    const seamFreeText = joinPagesWithoutSeams(ocrResults.map((r) => r.text));
    const plainReconciliation = reconcileItems(combinedText, plainItems, parsed.amount);

    let deterministicItems = plainItems;
    if (!plainReconciliation.reconciled && seamFreeText !== combinedText) {
      const seamFreeItems = parseLineItems(seamFreeText);
      if (reconcileItems(seamFreeText, seamFreeItems, parsed.amount).reconciled) {
        deterministicItems = seamFreeItems;
      }
    }

    const worstPageConfidence = Math.min(...ocrResults.map((r) => overallConfidence(r)));
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
    });
    const localExtraction = localNormalizedExtraction(parsed, deterministicItems, currency, reconciliation.reconciled);
    const adapter = providerConfig.provider === "veryfi" ? createVeryfiReceiptAdapter() : createGeminiReceiptAdapter();
    const gate = await dispatchReceiptProviderRescue(
      {
        businessProfileId: input.businessProfileId,
        receiptScanId: scanId,
        rescueDecision,
        localExtraction,
        pages: selectedEvidence,
        preprocessingVersion: PREPROCESS_VERSION,
        normalizedSchemaVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
      },
      { adapter, loadConfiguration: getReceiptProviderConfiguration },
    );
    const trigger = determineRescueTrigger(deterministicItems, parsed, combinedText, worstPageConfidence);
    const rescued = mergeIntoRescuedFields(parsed, deterministicItems, gate, trigger, providerConfig.providerVersion);
    const vendor = await snapVendorToHistory(input.businessProfileId, combinedText, rescued.vendor);

    const pageTexts = ocrResults.map((r) => r.text);
    const fieldEvidence = buildFieldEvidence(pageTexts, parsed, rescued, vendor);
    const warnings = buildScanWarnings({
      pageQualities,
      pageTexts,
      combinedText,
      seamFreeText,
      parsed,
      rescued,
      worstPageConfidence,
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
      providerDispatchStatus: gate.dispatchStatus,
      rescueDecisionVersion: RESCUE_DECISION_VERSION,
      rescueReasonCodes: rescueDecision.reasons,
      providerContractVersion: RECEIPT_PROVIDER_CONTRACT_VERSION,
      ocrCandidateSources: ocrSources,
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
          ocrConfidence: rescued.visionAssisted ? null : worstPageConfidence,
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
            ocrConfidence: overallConfidence(result),
            originalRawText: originalOcrResults[index]!.text,
            originalOcrConfidence: overallConfidence(originalOcrResults[index]!),
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
      },
    );
  } catch (err) {
    // A newer worker owns the row now. The stale worker must not overwrite its
    // state with either a success or failure from an expired lease.
    if (err instanceof ReceiptLeaseLostError) return;
    const failure = safeProcessingFailure(err);
    logger.error({ scanId, code: failure.code }, "receipt scan processing failed");
    await recordProcessingFailure(scanId, attempt, failure);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function recordProcessingFailure(scanId: number, attempt: number, failure: ReceiptProcessingFailure): Promise<void> {
  const retryable = attempt < MAX_PROCESSING_ATTEMPTS;
  await prisma.receiptScan.updateMany({
    where: { id: scanId, processingWorkerId: RECEIPT_WORKER_ID, processingAttemptCount: attempt },
    data: {
      processingStatus: retryable ? "Processing" : "Failed",
      processingWorkerId: null,
      processingHeartbeatAt: null,
      nextProcessingAttemptAt: new Date(
        Date.now() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!,
      ),
      processingError: failure.publicMessage,
      processingErrorCode: failure.code,
    },
  });
}

async function heartbeatScan(scanId: number, attempt: number): Promise<void> {
  const updated = await prisma.receiptScan.updateMany({
    where: {
      id: scanId,
      processingStatus: "Processing",
      processingWorkerId: RECEIPT_WORKER_ID,
      processingAttemptCount: attempt,
    },
    data: { processingHeartbeatAt: new Date() },
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
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });
  if (
    !scan?.businessProfileId ||
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
  const staleBefore = new Date(now.getTime() - RECEIPT_LEASE_MS);
  const eligible: Prisma.ReceiptScanWhereInput = {
    processingStatus: "Processing",
    nextProcessingAttemptAt: { lte: now },
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
      processingHeartbeatAt: now,
      processingAttemptCount: { increment: 1 },
    },
  });
  return claimed.count === 1 ? { id: candidate.id, attempt: candidate.processingAttemptCount + 1 } : null;
}

async function claimAndProcessScan(): Promise<boolean> {
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
  await processScan(claimed.id, input, claimed.attempt);
  return true;
}

/** Runs at most one durable job; the dedicated worker calls this repeatedly. */
export async function runReceiptWorkerOnce(): Promise<boolean> {
  return claimAndProcessScan();
}
