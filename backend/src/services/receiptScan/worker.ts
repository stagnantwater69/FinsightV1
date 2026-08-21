import { prisma } from "../../config/prisma";
import { ApiError } from "../../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { downloadReceiptImage, uploadReceiptImage } from "../storage.service";
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
import type { Prisma } from "@prisma/client";
import { logger } from "../../config/logger";
import { toDTO } from "./dto";
import { persistCategorisedItems } from "./categorisation";
import { buildFieldEvidence, buildScanWarnings, rescueWithVision, snapVendorToHistory } from "./extraction";
import { MAX_PAGES, type UploadInput } from "./types";

const RECEIPT_WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const RECEIPT_LEASE_MS = 2 * 60 * 1000;
const MAX_PROCESSING_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000] as const;

class ReceiptLeaseLostError extends Error {}

/**
 * Accepts the photographs and returns immediately, leaving the reading to
 * `processScan` in the background.
 *
 * WHY THIS RETURNS BEFORE THE WORK IS DONE. Reading a receipt is Tesseract
 * per page, sometimes a vision model, then the categoriser — seconds of work,
 * multiplied by up to MAX_PAGES. Doing that inline meant the owner's upload
 * held an HTTP connection open for the whole pipeline (a timeout risk on a
 * long receipt over a phone connection) and, worse, occupied the single Node
 * process the whole time, so a second owner scanning concurrently simply
 * waited. The request now ends once the bytes are safely in Storage and a row
 * exists to poll.
 *
 * WHAT STAYS SYNCHRONOUS, and why exactly these. Ownership and the page-count
 * limit, because a rejected upload must fail as a 4xx the client can act on
 * rather than as a row that quietly turns into "Failed". And the Storage
 * upload itself, because if the bytes cannot be stored there is nothing to
 * process later and the honest answer is an immediate error — it is also I/O
 * -bound rather than CPU-bound, so it does not block the event loop the way
 * OCR does.
 */
export async function uploadAndScan(userId: number, input: UploadInput) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);

  if (input.pages.length === 0) {
    throw new ApiError(400, "At least one receipt photo is required");
  }
  if (input.pages.length > MAX_PAGES) {
    // A receipt needing nine photographs is a scanning problem, not a
    // receipt — caught here too, not only at the HTTP boundary, since this
    // function is the one place both the route and the tests actually call.
    throw new ApiError(400, `A receipt can have at most ${MAX_PAGES} pages`);
  }

  // Uploaded in the order the pages arrived — every step after this one (the
  // concatenated text, the vision call, the stored page numbers) depends on
  // that order to mean anything, and nothing downstream re-derives it. The
  // order is the client's assertion, not something inferred here.
  const imagePaths: string[] = [];
  for (const page of input.pages) {
    imagePaths.push(await uploadReceiptImage(input.businessProfileId, page.buffer, page.mimetype, page.originalname));
  }

  const scan = await prisma.receiptScan.create({
    data: {
      businessProfileId: input.businessProfileId,
      imageFile: imagePaths[0]!, // the page-1 cover — see schema header note 14
      confirmationStatus: "Pending",
      processingStatus: "Processing",
      pages: {
        create: imagePaths.map((imageFile, i) => ({ pageNumber: i + 1, imageFile })),
      },
    },
    include: { pages: true },
  });

  /*
   * Deliberately NOT awaited — this is the whole point of the change.
   *
   * `processScan` never rejects (it records failure on the row instead), so
   * there is no unhandled rejection to guard against; the `.catch` is belt
   * and braces for a genuinely unexpected throw before its own try block.
   */
  void claimAndProcessScan(scan.id, input).catch((err) => {
    logger.error({ err }, `[receipt-scan] background processing threw for scan=${scan.id}`);
  });

  return toDTO(scan, [], scan.pages);
}

/**
 * The actual read: OCR every page, parse, rescue with vision where warranted,
 * categorise, and write the result back onto the scan row.
 *
 * Runs after the HTTP response has already gone out, so it CANNOT report a
 * failure by throwing — nobody is listening. Every failure path instead lands
 * the scan in "Failed" with a message the polling client can show, which is
 * why the whole body sits inside one try/catch rather than letting individual
 * steps propagate.
 *
 * The row itself is the queue. A conditional update claims a short lease, so
 * multiple backend instances cannot process the same scan and a restart can
 * reclaim work after the heartbeat expires. The first attempt may reuse the
 * request's buffers; every recovery attempt reconstructs them from Storage.
 */
async function processScan(scanId: number, input: UploadInput, attempt: number): Promise<void> {
  // OCR on one difficult photo can outlast the normal scheduler interval.
  // Refresh independently of page boundaries so another replica never
  // mistakes a healthy long-running read for an abandoned lease.
  const heartbeatTimer = setInterval(() => {
    void heartbeatScan(scanId, attempt).catch((error) =>
      logger.error({ err: error }, `[receipt-scan] heartbeat failed for scan=${scanId}`),
    );
  }, 30_000);
  heartbeatTimer.unref();
  try {
    // extractReceipt rather than extractText: the same read, but keeping the
    // per-word confidences tesseract reports so the confirm screen can say
    // which figure it doubts instead of asking the owner to check everything
    // equally.
    const ocrResults: OcrResult[] = [];
    for (const page of input.pages) {
      ocrResults.push(await extractReceipt(page.buffer));
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
     * which money lines survive, and this codebase already fixed the rule for
     * that situation one function down at rescueWithVision: a competing
     * reading replaces the deterministic one "only on an OBJECTIVE test,
     * never a preference." The objective test here is the receipt's own
     * printed total. If the plain reading fails to account for it and the
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

    // The worst page, not the average — see rescueWithVision's own note.
    const worstPageConfidence = Math.min(...ocrResults.map((r) => overallConfidence(r)));

    const rescued = await rescueWithVision(input, parsed, deterministicItems, combinedText, worstPageConfidence);
    const vendor = await snapVendorToHistory(input.businessProfileId, combinedText, rescued.vendor);

    // Assessed per page, not once for the whole scan — the client can then say
    // WHICH page came out blurry rather than "something about this did".
    const pageQualities = await Promise.all(input.pages.map((p) => assessImageQuality(p.buffer)));

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

    /*
     * Which code read this receipt — persisted per scan, not just logged.
     * The console line above (see rescueWithVision) survives for live
     * grepping, but a log rotates away; a model, prompt or parser change must
     * stay attributable for as long as the scan's corrections are used as
     * accuracy evidence, which is the row's own lifetime.
     */
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
    };

    await heartbeatScan(scanId, attempt);
    await prisma.receiptScan.update({
      where: { id: scanId },
      data: {
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
      },
    });

    // Per page, because the pages were created before any of this was known.
    // Scoped by receiptScanId as well as pageNumber so a page number can only
    // ever be updated within its own scan.
    for (let i = 0; i < ocrResults.length; i++) {
      await prisma.receiptScanPage.updateMany({
        where: { receiptScanId: scanId, pageNumber: i + 1 },
        data: {
          rawText: ocrResults[i]!.text,
          ocrConfidence: overallConfidence(ocrResults[i]!),
          sharpness: pageQualities[i]?.sharpness ?? null,
          brightness: pageQualities[i]?.brightness ?? null,
          tooBlurredToTrust: pageQualities[i]?.tooBlurredToTrust ?? null,
        },
      });
    }

    await heartbeatScan(scanId, attempt);
    await persistCategorisedItems(
      input.businessProfileId,
      scanId,
      rescued.items,
      vendor,
      rescued.itemsFromVision,
      rescued.itemsFromVision ? [] : rescued.items.map((i) => confidenceForValue(combinedLines, i.amount.toFixed(2))),
      // Vision items carry the model's own reported page/source text; OCR
      // items are located in the page text they were parsed from. Either way
      // an item nothing can vouch for stays evidence-less rather than being
      // given a plausible-looking line.
      rescued.itemsFromVision
        ? rescued.itemEvidence ?? []
        : locateItemLines(pageTexts, rescued.items.map((i) => i.amount)),
    );

    // Last, so a client that sees "Complete" is guaranteed to find the fields
    // and items already written rather than racing them.
    const completed = await prisma.receiptScan.updateMany({
      where: { id: scanId, processingWorkerId: RECEIPT_WORKER_ID, processingAttemptCount: attempt },
      data: {
        processingStatus: "Complete",
        processingError: null,
        processingWorkerId: null,
        processingHeartbeatAt: null,
      },
    });
    if (completed.count !== 1) throw new ReceiptLeaseLostError(`Receipt scan ${scanId} lease was reclaimed`);
  } catch (err) {
    // A newer worker owns the row now. The stale worker must not overwrite its
    // state with either a success or failure from an expired lease.
    if (err instanceof ReceiptLeaseLostError) return;
    logger.error({ err }, `[receipt-scan] processing failed for scan=${scanId}`);
    await recordProcessingFailure(scanId, attempt, err);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function recordProcessingFailure(scanId: number, attempt: number, err: unknown): Promise<void> {
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
      processingError: (err instanceof Error ? err.message : "The receipt could not be read").slice(0, 500),
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

async function storedInput(scanId: number, attempt: number): Promise<UploadInput> {
  const scan = await prisma.receiptScan.findUnique({
    where: { id: scanId },
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });
  if (!scan?.businessProfileId || scan.pages.length === 0) {
    throw new Error("The stored receipt pages are unavailable");
  }
  const pages: UploadInput["pages"] = [];
  for (const page of scan.pages) {
    const ext = page.imageFile.split(".").pop()?.toLowerCase();
    const mimetype = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    pages.push({
      buffer: await downloadReceiptImage(page.imageFile),
      mimetype,
      originalname: `page-${page.pageNumber}.${ext ?? "jpg"}`,
    });
    await heartbeatScan(scanId, attempt);
  }
  return { businessProfileId: scan.businessProfileId, pages };
}

/** Atomically lease one eligible scan. The conditional update is the race guard. */
async function claimScan(scanId?: number): Promise<{ id: number; attempt: number } | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECEIPT_LEASE_MS);
  const eligible: Prisma.ReceiptScanWhereInput = {
    processingStatus: "Processing",
    nextProcessingAttemptAt: { lte: now },
    OR: [{ processingWorkerId: null }, { processingHeartbeatAt: null }, { processingHeartbeatAt: { lt: staleBefore } }],
  };
  const candidate = await prisma.receiptScan.findFirst({
    where: { ...(scanId ? { id: scanId } : {}), ...eligible },
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

async function claimAndProcessScan(scanId?: number, initialInput?: UploadInput): Promise<boolean> {
  const claimed = await claimScan(scanId);
  if (!claimed) return false;
  let input: UploadInput;
  try {
    input = initialInput ?? (await storedInput(claimed.id, claimed.attempt));
  } catch (err) {
    if (err instanceof ReceiptLeaseLostError) return true;
    logger.error({ err }, `[receipt-scan] could not restore scan=${claimed.id} from Storage`);
    await recordProcessingFailure(claimed.id, claimed.attempt, err);
    return true;
  }
  await processScan(claimed.id, input, claimed.attempt);
  return true;
}

/** Runs at most one durable job; the server scheduler calls this repeatedly. */
export async function runReceiptWorkerOnce(): Promise<boolean> {
  return claimAndProcessScan();
}

/** Owner-triggered recovery after automatic attempts have been exhausted. */
export async function retryScan(userId: number, scanId: number) {
  const scan = await prisma.receiptScan.findFirst({
    where: { id: scanId, businessProfile: { userId } },
    select: { id: true, processingStatus: true },
  });
  if (!scan) throw new ApiError(404, "Receipt scan not found");
  if (scan.processingStatus !== "Failed") throw new ApiError(409, "Only a failed receipt scan can be retried");
  await prisma.receiptScan.update({
    where: { id: scanId },
    data: {
      processingStatus: "Processing",
      processingError: null,
      processingAttemptCount: 0,
      processingWorkerId: null,
      processingHeartbeatAt: null,
      nextProcessingAttemptAt: new Date(),
    },
  });
  void claimAndProcessScan(scanId).catch((err) => logger.error({ err }, `[receipt-scan] manual retry failed scan=${scanId}`));
  return getScan(userId, scanId);
}

/**
 * One scan as it currently stands, for the client polling after upload.
 *
 * Ownership is enforced through the scan's own business profile, and a scan
 * belonging to someone else is reported as 404 rather than 403 — the same
 * non-disclosure rule requireOwnedBusinessProfile follows everywhere else.
 */
export async function getScan(userId: number, scanId: number) {
  const scan = await prisma.receiptScan.findFirst({
    where: { id: scanId, businessProfile: { userId } },
    include: { items: { orderBy: { lineNumber: "asc" } }, pages: true },
  });
  if (!scan) {
    throw new ApiError(404, "Receipt scan not found");
  }
  return toDTO(scan, scan.items, scan.pages);
}
