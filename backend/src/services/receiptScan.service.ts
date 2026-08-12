import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { downloadReceiptImage, uploadReceiptImage } from "./storage.service";
import {
  confidenceForValue,
  extractReceipt,
  findPageSeams,
  joinPagesWithoutSeams,
  looksLikeDuplicatePage,
  looksLikeMultipleReceipts,
  overallConfidence,
  parseLineItems,
  parseReceiptFields,
  reconcileItems,
  type OcrResult,
  type ParsedLineItem,
  type ParsedReceiptFields,
} from "./ocr.service";
import { findKnownVendorInText, normaliseForMatch } from "../lib/historyMatching";
import { assessImageQuality } from "../lib/imageQuality";
import { categoriseReceiptItems, UNCATEGORISED } from "./ai.service";
import { extractReceiptWithVision, type VisionPage } from "./visionOcr.service";
import { createExpenseRecord } from "./expenseRecord.service";
import { allocateProportionally, type ReconciliationMode } from "../lib/allocation";
import {
  recordConfirmationFeedback,
  recordDeletedLine,
  snapshotItemCategories,
} from "./extractionFeedback.service";
import type { Prisma, ReceiptScan, ReceiptScanItem, ReceiptScanPage } from "@prisma/client";
import { logger } from "../config/logger";

/** One photographed page of a receipt, as it arrives from the upload. */
export interface UploadPage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/**
 * A receipt too long for one photograph is now several pages of ONE scan.
 * `pages` is always non-empty; a single photo is simply a one-element array
 * — there is no separate "one page" shape to keep in sync with this one.
 */
interface UploadInput {
  businessProfileId: number;
  pages: UploadPage[];
}

const RECEIPT_WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const RECEIPT_LEASE_MS = 2 * 60 * 1000;
const MAX_PROCESSING_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000] as const;

class ReceiptLeaseLostError extends Error {}

export interface ReceiptSplit {
  categoryId: number;
  amount: number;
  /** The extracted lines that composed this split, on the itemised path. */
  itemIds?: number[];
  /**
   * Overrides the receipt-level description for this line. Unused by the
   * confirm screen today — it exists for line-item extraction, which needs
   * to say "12 items: chicken, buns, …" on the Inventory split and something
   * different on the Equipment one.
   */
  description?: string;
  /**
   * The part of `amount` that is this split's share of receipt-level tax,
   * service charge or discount rather than the price of its own items.
   * Signed. Absent when the receipt reconciled exactly.
   */
  allocatedCharges?: number;
}

interface ConfirmInput {
  date: string;
  description: string;
  vendor?: string;
  /** The receipt's total, as read and confirmed by the owner. */
  amount: number;
  /**
   * One entry per category this receipt covers. Must sum to `amount`.
   * Used by the single-total flow and by a hand-made split.
   */
  splits?: ReceiptSplit[];
  /**
   * The itemised path: the owner's final say on which category each extracted
   * line belongs to. When present it takes precedence over `splits` — the
   * server groups the items itself rather than trusting a client-computed
   * split, so the item -> record links it writes cannot disagree with the
   * amounts it posts.
   */
  itemAssignments?: { itemId: number; categoryId: number }[];
  /**
   * Lines the owner typed in on the confirm screen because OCR missed them.
   * Stored as real ReceiptScanItem rows (flagged `addedByOwner`) before the
   * grouping runs, so a hand-added line is grouped, linked to its record and
   * shown on the record afterwards exactly like an extracted one — while
   * still being distinguishable from something FinSight claims to have read.
   */
  additionalItems?: { name: string; amount: number; categoryId: number }[];
  /**
   * How to account for any difference between the items and the confirmed
   * total. Only meaningful on the itemised path. Defaults to `none`, which
   * requires the items to already reconcile.
   */
  reconciliation?: ReconciliationMode;
}

/** Description given to the standalone record that carries a receipt's tax. */
const CHARGES_DESCRIPTION = "Tax and charges";

function toDTO(scan: ReceiptScan, items: ReceiptScanItem[] = [], pages: ReceiptScanPage[] = []) {
  /*
   * Adjacent pages only, not every pair — and recomputed here rather than
   * stored in a column of its own.
   *
   * The evidence it rests on (each page's own rawText) is already persisted,
   * so a column would be a second copy of an answer derivable from the first,
   * with the usual risk of the two disagreeing. It is a string comparison
   * over rows already loaded for this response, which is cheap enough not to
   * be worth denormalising.
   *
   * Why adjacent only: the mistake this catches is the shutter firing twice
   * in a row, i.e. pages that are NEIGHBOURS in the sequence just
   * photographed. Comparing every page against every other would also flag
   * two genuinely different pages of a long receipt whose stock-restock lines
   * happen to read alike — a false alarm neighbour-comparison does not
   * produce, because such pages are usually not adjacent.
   */
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const duplicatePages: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    if (looksLikeDuplicatePage(ordered[i - 1]!.rawText ?? "", ordered[i]!.rawText ?? "")) {
      duplicatePages.push(ordered[i]!.pageNumber);
    }
  }

  /*
   * Sections that begin where the previous one ended — the overlap the camera
   * asked the owner to leave.
   *
   * Derived here from the same stored rawText, for the same reason
   * duplicatePages is: the evidence is already persisted, and a column would
   * be a second copy of an answer computable from the first with the usual
   * risk of the two disagreeing.
   *
   * ADVISORY ONLY, and it says something different from duplicatePages.
   * A duplicate page is a MISTAKE — the same page photographed twice. A seam
   * is the feature working: it is how the owner was told to photograph a long
   * receipt. This exists so the confirm screen can explain why two similar
   * lines appear near a section boundary, not to accuse anyone of anything.
   * Whether the overlapping lines were counted once or twice is settled by
   * arithmetic during processing, not here.
   */
  const overlappingPages = findPageSeams(ordered.map((p) => p.rawText ?? "")).map((s) => s.pageNumber);

  const pageQualities = ordered.map((p) =>
    p.tooBlurredToTrust === null
      ? null
      : {
          sharpness: p.sharpness ?? 0,
          brightness: p.brightness ?? 0,
          tooBlurredToTrust: p.tooBlurredToTrust,
        },
  );

  return {
    id: scan.id,
    businessProfileId: scan.businessProfileId,
    imageFile: scan.imageFile,
    extractedDate: scan.extractedDate,
    extractedVendor: scan.extractedVendor,
    extractedDescription: scan.extractedDescription,
    extractedAmount: scan.extractedAmount ? Number(scan.extractedAmount) : null,
    confirmationStatus: scan.confirmationStatus,
    /**
     * How far the READ has got: "Processing" | "Complete" | "Failed".
     *
     * Separate from confirmationStatus, which is the owner's decision
     * afterwards — see schema header note 15. The client polls this after
     * upload rather than holding a request open for the whole pipeline.
     */
    processingStatus: scan.processingStatus,
    /** Why the read failed. Null unless processingStatus is "Failed". */
    processingError: scan.processingError,
    processingAttemptCount: scan.processingAttemptCount,
    nextProcessingAttemptAt: scan.processingStatus === "Processing" ? scan.nextProcessingAttemptAt : null,
    createdAt: scan.createdAt,
    /**
     * Every page's own readability, in page order — page 1 included.
     * Entries are null for scans read before this was measured.
     */
    pageQualities,
    /**
     * Page 1's own reading, kept under the name a single-photo scan has
     * always returned so that the common case is unchanged for clients that
     * never look at pageQualities.
     */
    captureQuality: pageQualities[0] ?? null,
    /** 1-indexed pages that read as the same page photographed twice. */
    duplicatePages,
    /**
     * 1-indexed pages whose first lines repeat the previous page's last ones.
     *
     * Expected, not a fault: it is the overlap the capture guide asks for on
     * a long receipt. Empty on a single-section scan.
     */
    overlappingPages,
    /**
     * True when the deterministic parse failed and a model interpreted the
     * photo instead. The confirm screen warns on this — values guessed from
     * an image must not look like values read off text.
     */
    visionAssisted: scan.visionAssisted,
    /**
     * How sure the OCR engine was about this page, 0-100. Null when it was
     * not measured — an older scan, or a vision-assisted read where the
     * figure would describe text tesseract could not make sense of.
     */
    ocrConfidence: scan.ocrConfidence,
    /**
     * The line most likely to be misread, when the items do not add up to the
     * total.
     *
     * A receipt whose items reconcile needs no suspicion. When they do NOT,
     * one of the amounts is usually a single misread digit — and the lowest-
     * confidence amount is the best available guess at which. This only ever
     * POINTS; it never changes a figure, because the correct value is not
     * something the engine knows.
     */
    suspectItemId: suspectItemId(scan, items),
    /**
     * True when the photograph appears to hold more than one receipt.
     *
     * Derived from the stored rawText rather than a column of its own, so it
     * needs no migration and reads correctly for scans taken before the check
     * existed. See looksLikeMultipleReceipts for what the evidence is and how
     * often it is wrong.
     */
    looksLikeMultipleReceipts: looksLikeMultipleReceipts(scan.rawText),
    /**
     * The lines read off the receipt, each with the category FinSight
     * assigned it. Empty when the receipt has no parseable item lines — the
     * client then keeps the single-total flow, unchanged.
     */
    items: items.map((i) => ({
      id: i.id,
      lineNumber: i.lineNumber,
      name: i.name,
      quantity: i.quantity === null ? null : Number(i.quantity),
      unitPrice: i.unitPrice === null ? null : Number(i.unitPrice),
      amount: Number(i.amount),
      categoryId: i.categoryId,
      addedByOwner: i.addedByOwner,
      /**
       * A category FinSight thinks should exist but the business doesn't have
       * yet. Carried to the client so the confirm screen can offer to create
       * it — without this the proposal is computed, stored and then never
       * seen by anyone, which is exactly the bug this field was added to fix.
       */
      suggestedCategoryName: i.suggestedCategoryName,
      /** True for a line a vision model produced rather than OCR text. */
      extractedByVision: i.extractedByVision,
      /** How sure OCR was about THIS amount, 0-100, or null if not measured. */
      amountConfidence: i.amountConfidence,
    })),
  };
}

/**
 * How many past records are read to build the list of vendors this business
 * already deals with.
 *
 * Deduplicated afterwards, so a shop that buys from the same three suppliers
 * every week still yields three names from a hundred rows — the query is sized
 * to reach back far enough to include the occasional supplier, not to cap the
 * number of distinct names.
 */
const VENDOR_LOOKBACK = 200;

/**
 * Corrects a vendor reading against the ones this business has confirmed.
 *
 * The reference data is `ExpenseRecord.vendor`, which is what the OWNER
 * submitted on the confirm screen — not what OCR guessed. That distinction is
 * the whole point: these names were verified by the person who was standing at
 * the counter, which makes them better evidence than anything the pipeline can
 * derive from the pixels.
 *
 * Two failures get fixed here, and they are different:
 *
 *   - a known vendor read with noise ("SAVEM0RE MARKET") snaps to its
 *     confirmed spelling; and
 *   - a vendor read off the WRONG LINE is overruled when a known name appears
 *     anywhere else on the receipt. This is the harder failure and the one
 *     behind the original complaint: a stylised logo mangled into a short
 *     scrap can outscore the real registered name printed below it.
 *
 * Nothing happens for a business with no history, or a receipt from a genuinely
 * new shop — findKnownVendorInText returns null and the parser's answer stands.
 * So this only ever gets stronger as the business uses FinSight, and it never
 * makes a first-time scan worse.
 */
async function snapVendorToHistory(
  businessProfileId: number,
  text: string,
  parsedVendor: string | null,
): Promise<string | null> {
  const rows = await prisma.expenseRecord.findMany({
    where: { businessProfileId, vendor: { not: null } },
    select: { vendor: true },
    orderBy: { id: "desc" },
    take: VENDOR_LOOKBACK,
  });

  const known = [...new Set(rows.map((r) => r.vendor!).filter((v) => v.trim().length > 0))];
  if (known.length === 0) return parsedVendor;

  const match = findKnownVendorInText(text, known);
  if (match === null) return parsedVendor;
  /*
   * Compared literally, NOT on the normalised forms. Normalising folds the
   * confusable glyphs, so "SAVEM0RE MARKET" and "SAVEMORE MARKET" compare
   * equal there — and an early return on that basis handed back the reading
   * with the zero still in it, silently skipping the correction this function
   * exists to make. Only an exact string match means there is nothing to do.
   */
  if (parsedVendor === match.value) return parsedVendor;

  console.info(
    `[vendor-history] business=${businessProfileId} read=${JSON.stringify(parsedVendor)} ` +
      `corrected=${JSON.stringify(match.value)} score=${match.score.toFixed(3)}`,
  );
  return match.value;
}

/**
 * Which line to point at when a receipt does not add up.
 *
 * Returns null when the items reconcile, when there is nothing to compare
 * against, or when no amount was measured — an unmeasured line is not a
 * suspicious one, and saying otherwise would send the owner to check a figure
 * for no reason.
 *
 * The reasoning is narrow on purpose: the total is usually read confidently
 * (it is large, isolated and printed clearly), the items are where a single
 * digit goes wrong, and tesseract already said which digit it was least sure
 * of. That is a strong enough hint to point with — and nowhere near strong
 * enough to correct with, which is why this returns an id and not a value.
 *
 * The reconciliation is delegated rather than done here with a bare
 * `sum !== total`, which is what this originally did and which was WRONG: on
 * any receipt carrying 12% VAT the items never equal the total, so every such
 * scan pointed the owner at a perfectly good line. Measured on the corpus that
 * was 5 false alarms against 1 real one. reconcileItems only reports a gap the
 * receipt itself cannot explain.
 */
function suspectItemId(scan: ReceiptScan, items: ReceiptScanItem[]): number | null {
  if (scan.extractedAmount === null || items.length === 0) return null;

  const reconciliation = reconcileItems(
    scan.rawText ?? "",
    items.map((i) => ({ amount: Number(i.amount) })),
    Number(scan.extractedAmount),
  );
  if (reconciliation.reconciled) return null;

  const measured = items.filter((i) => i.amountConfidence !== null && !i.addedByOwner);
  if (measured.length === 0) return null;

  return measured.reduce((worst, i) => (i.amountConfidence! < worst.amountConfidence! ? i : worst)).id;
}

/**
 * The standing home for an item nothing else fits.
 *
 * Created per business profile on first need rather than at signup, so a
 * business that never scans a receipt never acquires a category it doesn't
 * use. Matched case-insensitively first, so an owner who already has their
 * own "Uncategorized" keeps it instead of getting a near-duplicate.
 */
async function ensureUncategorised(businessProfileId: number): Promise<number> {
  const existing = await prisma.expenseCategory.findFirst({
    where: { businessProfileId, name: { equals: UNCATEGORISED, mode: "insensitive" } },
  });
  if (existing) return existing.id;
  const created = await prisma.expenseCategory.create({
    data: {
      businessProfileId,
      name: UNCATEGORISED,
      description: "Items FinSight could not confidently categorise. Reassign them as you review.",
    },
  });
  return created.id;
}

/**
 * A receipt too long for one photograph, and not a receipt any more.
 *
 * Exported so the upload route's multer limit and this function's own check
 * are the same number rather than two copies that could quietly disagree —
 * the same discipline duplicateKeyOf documents for its own shared constant.
 */
export const MAX_PAGES = 8;

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
  const pages: UploadPage[] = [];
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

/**
 * Page confidence at or below which tesseract is treated as having guessed.
 *
 * CHOSEN FROM MEASUREMENT, and the measurement is narrower than the number
 * looks — see tests/ocr-accuracy/confidence-calibration.ts, which reports the
 * confidence of every corpus image against whether its parse was right.
 *
 * The separation is real and it is stark: every receipt that parsed cleanly
 * scored 90-95, and the two that were misread scored 33 and 56. But the clean
 * reads bottom out at 90 and the worst broken one is a 89, so a threshold
 * fitted to the corpus would sit one point from a correct read — precision
 * that 31 images cannot support.
 *
 * 75 sits in the middle of the empty band between 56 and 89 instead. It is
 * deliberately NOT the value that maximises corpus score; it is the value that
 * is furthest from being wrong in either direction if real receipts land
 * slightly differently than these did.
 *
 * The corpus's low-confidence cases are its only two real photographs, which
 * is also the honest limit of this calibration: it rests on n=2. What keeps
 * that from mattering much is that this is the WEAKEST of the four triggers —
 * an empty read, a missing total and a receipt that does not add up all fire
 * on their own evidence, whatever the confidence says.
 */
const LOW_CONFIDENCE = 75;

/**
 * What the scan ended up with, and whether a model had a hand in it.
 */
interface RescuedFields extends ParsedReceiptFields {
  items: ParsedLineItem[];
  /** True when the vision model supplied any of the above. */
  visionAssisted: boolean;
  /** True when the ITEMS specifically came from the model rather than OCR text. */
  itemsFromVision: boolean;
}

/**
 * Falls back to reading the photograph when the deterministic parse came up
 * short.
 *
 * WHEN THIS FIRES — four triggers, in descending order of how certain the
 * evidence is that something is actually wrong:
 *
 *   no-items          tesseract's text yielded no line items at all
 *   no-total          no total could be found
 *   does-not-add-up   the items fail to account for the total, and no line on
 *                     the receipt explains the gap (see reconcileItems). This
 *                     is arithmetic, so it is the strongest evidence of the
 *                     four that a figure was misread, and it is the one that
 *                     catches a CONFIDENTLY misread digit — the case that
 *                     motivated all of this, where a 82 read as 62 left the
 *                     items exactly 20.00 short of the printed total.
 *   low-confidence    tesseract's own mean confidence is below LOW_CONFIDENCE
 *
 * The first two say the deterministic read produced nothing; the last two say
 * it produced something that does not hold up.
 *
 * The DATE deserves its own note, because it is the one field where the
 * parser is better even though the model reads more:
 *
 *   A date like "03/09/2026" cannot be resolved by reading harder. Both
 *   components are <= 12, so the answer is a CONVENTION (Philippine DD/MM),
 *   not something visible in the image. Measured across three runs the model
 *   answered that receipt inconsistently — 9 March twice, 3 September once —
 *   despite being told the convention in its prompt. The parser has the rule
 *   compiled in and is right every time. So a date tesseract found always
 *   wins, and the model's date is only used where there was none at all.
 *
 * The model is better at READING what is printed; the parser is better at
 * APPLYING a rule the image cannot supply. This split reflects that.
 */
async function rescueWithVision(
  input: UploadInput,
  parsed: ParsedReceiptFields,
  deterministicItems: ParsedLineItem[],
  combinedText: string,
  /**
   * The worst per-page confidence, not an average. One unreadable page in an
   * otherwise clean 3-page receipt is still a page the owner needs help
   * with — averaging it away would let two good pages outvote the one that
   * actually needs the model.
   */
  worstPageConfidence: number,
): Promise<RescuedFields> {
  const reconciliation = reconcileItems(combinedText, deterministicItems, parsed.amount);

  /*
   * Ordered most-certain-first, so the log says the strongest reason the call
   * was made rather than whichever check happened to run first.
   */
  const trigger =
    deterministicItems.length === 0
      ? "no-items"
      : parsed.amount === null
        ? "no-total"
        : !reconciliation.reconciled
          ? "does-not-add-up"
          : worstPageConfidence < LOW_CONFIDENCE
            ? "low-confidence"
            : null;

  if (trigger === null) {
    return { ...parsed, items: deterministicItems, visionAssisted: false, itemsFromVision: false };
  }

  // Never throws — a failed rescue leaves the scan exactly as the
  // deterministic parse left it, which is still a correctable draft.
  const startedAt = Date.now();
  const vision = await extractReceiptWithVision(
    input.pages.map((p): VisionPage => ({ buffer: p.buffer, mimetype: p.mimetype })),
  );
  const elapsedMs = Date.now() - startedAt;

  /*
   * Logged because this call is BILLED and fires more often than the "rescue"
   * framing suggests.
   *
   * Some triggers fire on receipts that are perfectly fine. A shop printing
   * only a total is a normal case in this market, not a failure; the model is
   * asked, finds nothing to add, and the deterministic answer stands —
   * correct, but paid for.
   *
   * `trigger` is logged precisely so that cost can be attributed. The four are
   * not equally worth their money, and only production traffic can say which
   * ones earn it: `does-not-add-up` fires on proof that something is wrong and
   * should nearly always buy something, while `low-confidence` rests on a
   * threshold calibrated against two photographs and is the one to watch. If a
   * trigger's firings rarely change the answer, tighten or drop that trigger
   * specifically rather than raising the bar on all four.
   */
  const recovered = vision ? (deterministicItems.length === 0 ? vision.items.length : 0) : 0;
  console.info(
    `[vision-ocr] business=${input.businessProfileId} trigger=${trigger} reached=${vision !== null} ` +
      `pages=${input.pages.length} recoveredItems=${recovered} hadTotal=${parsed.amount !== null} ` +
      `confidence=${worstPageConfidence} ms=${elapsedMs}`,
  );

  if (!vision) {
    return { ...parsed, items: deterministicItems, visionAssisted: false, itemsFromVision: false };
  }

  /*
   * The model reports a name, a quantity and a line total but never a unit
   * price, so it is derived exactly as parseLineItems derives it — from the
   * quantity where there is one, and left null otherwise. Null means "the
   * receipt didn't say"; inventing a unit price would be a number nobody read.
   */
  const visionItems: ParsedLineItem[] = vision.items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unitPrice: i.quantity && i.quantity > 0 ? Math.round((i.amount / i.quantity) * 100) / 100 : null,
    amount: i.amount,
  }));

  /*
   * WHICH READING WINS.
   *
   * The old rule was "the deterministic answer wins wherever it exists", which
   * was right while the only trigger was an EMPTY result — there was never a
   * competing answer to choose between. Now that a doubtful-but-present read
   * also triggers, there is, and "deterministic always wins" would fetch a
   * better reading and then discard it.
   *
   * Vision replaces the items only on an OBJECTIVE test, never a preference:
   * the deterministic items failed to account for the total and the model's
   * items do. That is arithmetic agreeing with the receipt's own printed
   * total, not a judgement that the model reads better. Where the model's
   * items also fail to add up there is no evidence it did better, so the
   * deterministic read stands.
   */
  const visionReconciles =
    visionItems.length > 0 &&
    reconcileItems(combinedText, visionItems, parsed.amount ?? vision.amount).reconciled;
  const visionSettlesTheGap = !reconciliation.reconciled && visionReconciles;

  const itemsFromVision = visionItems.length > 0 && (deterministicItems.length === 0 || visionSettlesTheGap);
  const items = itemsFromVision ? visionItems : repairItemNames(deterministicItems, visionItems, trigger);
  const vendor = parsed.vendor ?? vision.vendor;
  const amount = parsed.amount ?? vision.amount;
  const date = parsed.date ?? vision.date;

  return {
    date,
    vendor,
    // Rebuilt rather than carried over, so a vendor the model supplied is
    // reflected in the description the owner sees instead of the parser's
    // "Receipt purchase" fallback for a vendor it never found.
    description: vendor ? `Purchase from ${vendor}` : "Receipt purchase",
    amount,
    items,
    visionAssisted:
      itemsFromVision ||
      items.some((item, i) => item.name !== deterministicItems[i]?.name) ||
      (parsed.amount === null && amount !== null) ||
      (parsed.vendor === null && vendor !== null) ||
      (parsed.date === null && date !== null),
    itemsFromVision,
  };
}

/**
 * Takes the model's wording for lines whose AMOUNTS both readings agree on.
 *
 * This is the narrow case the confidence trigger exists for. When the items
 * add up to the printed total, the arithmetic corroborates every amount — the
 * numbers are sound. What is not corroborated is the TEXT beside them, and on
 * a page tesseract read at 56% that text is where the damage is: a real
 * Savemore line reading "Del Monte Pineapple Tidbits" came back as "Sey".
 *
 * So the amounts are kept exactly as OCR read them — they are the figures that
 * reach the owner's books, and they have independent corroboration the names
 * do not — while the names are taken from the model, which reads the same
 * receipt without tesseract's character-level guessing.
 *
 * Matching is by amount, and each vision line is consumed once so two items at
 * the same price cannot both claim the same name. A line the model did not
 * report keeps the name OCR gave it.
 */
function repairItemNames(
  deterministic: ParsedLineItem[],
  visionItems: ParsedLineItem[],
  trigger: string,
): ParsedLineItem[] {
  // Only where the trigger was doubt about the READING. A receipt sent for a
  // missing total was never in doubt about its item names.
  if (trigger !== "low-confidence" && trigger !== "does-not-add-up") return deterministic;

  const unclaimed = [...visionItems];
  return deterministic.map((item) => {
    const i = unclaimed.findIndex((v) => Math.round(v.amount * 100) === Math.round(item.amount * 100));
    if (i === -1) return item;
    const match = unclaimed.splice(i, 1)[0]!;
    return match.name.trim() ? { ...item, name: match.name.trim() } : item;
  });
}

/**
 * How many past items are read to build the classifier's few-shot examples.
 *
 * Deliberately larger than the number of examples the prompt ends up carrying
 * (ai.service caps that): these are deduplicated by item name there, and a
 * business that buys the same few things every week would otherwise yield
 * only a handful of distinct examples from a tighter query.
 */
const PRIOR_CHOICE_LOOKBACK = 100;

/**
 * What this business has decided about items before, most recent first.
 *
 * ONLY from CONFIRMED scans, and that restriction is the whole point. A
 * pending scan's categories are the AI's own unreviewed guesses; feeding
 * those back would teach it its own mistakes and the loop would amplify an
 * error rather than correct it. A confirmed scan is the opposite — the owner
 * saw every row and either accepted it or changed it, so each one is a real
 * human decision.
 *
 * Items sitting in Uncategorized are left out too: "this belongs in
 * Uncategorized" is not a decision, it is the absence of one, and the model
 * already has UNCATEGORISED for declining.
 */
async function recentCategoryChoices(businessProfileId: number) {
  const rows = await prisma.receiptScanItem.findMany({
    where: {
      receiptScan: { businessProfileId, confirmationStatus: "Confirmed" },
      categoryId: { not: null },
    },
    select: { name: true, category: { select: { name: true } } },
    orderBy: { id: "desc" },
    take: PRIOR_CHOICE_LOOKBACK,
  });

  return rows
    .filter((r) => r.category !== null && r.category.name.toLowerCase() !== UNCATEGORISED.toLowerCase())
    .map((r) => ({ item: r.name, category: r.category!.name }));
}

/**
 * Categorises the extracted lines and stores them against the scan.
 *
 * Categorisation is automatic and happens here, at scan time, rather than
 * behind a button the owner has to find — reading a receipt and knowing that
 * "buns" are ingredients is the thing the feature is for, and making it
 * opt-in meant it mostly didn't happen.
 *
 * Nothing here can fail the scan. If the model is unreachable the items are
 * still stored, just all uncategorised, and the owner assigns them on the
 * review screen. An upload must never be lost because a third-party API was
 * down.
 */
async function persistCategorisedItems(
  businessProfileId: number,
  receiptScanId: number,
  parsedItems: { name: string; quantity: number | null; unitPrice: number | null; amount: number }[],
  vendor: string | null,
  extractedByVision = false,
  /** Per-item OCR confidence, positionally aligned with parsedItems. */
  amountConfidences: (number | null)[] = [],
): Promise<ReceiptScanItem[]> {
  // A recovered attempt replaces any partial result left by the prior worker.
  await prisma.receiptScanItem.deleteMany({ where: { receiptScanId } });
  if (parsedItems.length === 0) return [];

  const categories = await prisma.expenseCategory.findMany({
    where: { businessProfileId },
    select: { id: true, name: true },
  });

  // The standing Uncategorized category is never offered to the model as a
  // classification target — "put it in Uncategorized" is our decision when
  // the model declines, not one of its options.
  const assignable = categories.filter((c) => c.name.toLowerCase() !== UNCATEGORISED.toLowerCase());

  let suggestions: Awaited<ReturnType<typeof categoriseReceiptItems>> = [];
  try {
    // The history read sits inside the try with the model call on purpose: it
    // is part of the categorisation attempt, and this function's promise is
    // that nothing in it can cost the owner their scan.
    suggestions = await categoriseReceiptItems(
      parsedItems.map((i) => i.name),
      assignable.map((c) => c.name),
      { vendorName: vendor, priorChoices: await recentCategoryChoices(businessProfileId) },
    );
  } catch (err) {
    logger.error({ err }, "Item categorisation failed; storing items uncategorised");
  }

  const idByName = new Map(assignable.map((c) => [c.name.toLowerCase(), c.id]));
  const matchByIndex = new Map(suggestions.map((s) => [s.index, s.match]));
  // Kept separate from the match: a proposal is only ever a question for the
  // owner, never an assignment. validateItemCategories guarantees the two are
  // mutually exclusive — a suggestion only survives when nothing matched.
  const suggestNewByIndex = new Map(suggestions.map((s) => [s.index, s.suggestNew]));

  // Only pay for the Uncategorized category if something actually needs it.
  const needsFallback = parsedItems.some((_, i) => !matchByIndex.get(i));
  const uncategorisedId = needsFallback ? await ensureUncategorised(businessProfileId) : null;

  await prisma.receiptScanItem.createMany({
    data: parsedItems.map((item, i) => {
      const match = matchByIndex.get(i);
      return {
        receiptScanId,
        lineNumber: i + 1,
        name: item.name.slice(0, 255),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        categoryId: (match ? idByName.get(match.toLowerCase()) : null) ?? uncategorisedId,
        suggestedCategoryName: suggestNewByIndex.get(i) ?? null,
        extractedByVision,
        amountConfidence: amountConfidences[i] ?? null,
      };
    }),
  });

  return prisma.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
}

/**
 * Removes a line the owner says was never a purchase.
 *
 * OCR occasionally admits a line that is really register furniture, and the
 * owner is the only one who can tell. Deleting the ROW rather than hiding it
 * client-side is deliberate: `groupItemsIntoSplits` requires every stored item
 * to carry an assignment, so a line the client merely stopped sending would
 * fail confirmation with "Every item on the receipt needs a category" and no
 * way for the owner to act on it.
 *
 * Only while the scan is still Pending. Once confirmed, the items are the
 * evidence for expense records that already exist, and deleting one would
 * leave a record whose breakdown no longer explains its own amount.
 *
 * Removing a line widens the gap between the items and the confirmed total.
 * That is correct and is left to the reconciliation step, which already
 * exists to answer exactly that question.
 */
export async function deleteScanItem(userId: number, receiptScanId: number, itemId: number) {
  const scan = await prisma.receiptScan.findFirst({
    where: { id: receiptScanId, businessProfile: { userId } },
  });
  if (!scan) {
    throw new ApiError(404, "Receipt scan not found");
  }
  if (scan.confirmationStatus === "Confirmed") {
    throw new ApiError(400, "This receipt scan has already been confirmed");
  }

  // Read before the delete, because "OCR read a line that was not a purchase"
  // is a fact about a row that is about to stop existing. Scoped to the scan
  // for the same reason the delete is: an id from someone else's receipt must
  // not be readable by guessing it.
  const doomed = await prisma.receiptScanItem.findFirst({ where: { id: itemId, receiptScanId } });

  const deleted = await prisma.receiptScanItem.deleteMany({ where: { id: itemId, receiptScanId } });
  if (deleted.count === 0) {
    throw new ApiError(404, "Item not found on this receipt scan");
  }

  // After the delete has actually succeeded, so a failed removal cannot leave
  // behind a record of a false positive that was never removed.
  if (doomed) {
    await recordDeletedLine(scan, doomed);
  }

  const [items, pages] = await Promise.all([
    prisma.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } }),
    // Loaded so the returned scan keeps its per-page quality and
    // duplicate-page findings — the review screen re-renders from this
    // response, and dropping them here would make those warnings vanish the
    // moment an owner removed one line.
    prisma.receiptScanPage.findMany({ where: { receiptScanId } }),
  ]);
  return toDTO(scan, items, pages);
}

export async function confirmReceipt(userId: number, receiptScanId: number, input: ConfirmInput) {
  const scan = await prisma.receiptScan.findFirst({
    where: { id: receiptScanId, businessProfile: { userId } },
  });
  if (!scan) {
    throw new ApiError(404, "Receipt scan not found");
  }
  if (scan.confirmationStatus === "Confirmed") {
    throw new ApiError(400, "This receipt scan has already been confirmed");
  }
  /*
   * A scan still being read cannot be confirmed.
   *
   * The clients only show the confirm screen once polling reports "Complete",
   * so this is not reachable through the ordinary flow — but confirming
   * mid-read would race the background write, and the loser would be the
   * owner: the items the split is validated against might not exist yet, so a
   * perfectly correct receipt could be rejected as not adding up, or worse,
   * accepted against a partial reading. Refusing is the only safe answer, and
   * the message names the state rather than blaming their input.
   */
  if (scan.processingStatus === "Processing") {
    throw new ApiError(400, "This receipt is still being read. Try again in a moment.");
  }
  if (scan.processingStatus === "Failed") {
    throw new ApiError(400, "This receipt could not be read. Scan it again.");
  }
  if (!scan.businessProfileId) {
    throw new ApiError(400, "Receipt scan is not linked to a business profile");
  }

  /*
   * The splits must account for the whole receipt, exactly.
   *
   * The total is the number the owner confirmed against the photo, and it is
   * what the receipt actually cost — so it is the anchor, and the split has to
   * reconcile TO it. Silently importing a short split would quietly under-
   * report the expense; silently scaling one to fit would invent numbers the
   * owner never entered. Both are worse than refusing.
   *
   * Compared in centavos because 1200.10 + 800.20 !== 2000.30 in binary
   * floating point, and an owner whose arithmetic is right should never be
   * told it is wrong by a rounding artefact.
   */
  const totalCentavos = Math.round(input.amount * 100);

  /*
   * Every category named anywhere in this request is checked against THIS
   * business before anything is written. Doing it up front rather than at
   * each use matters because owner-added items are persisted below: a
   * validation failure halfway through would leave orphan item rows on the
   * scan that reappear the next time the owner opens it.
   */
  const validCategories = new Set(
    (
      await prisma.expenseCategory.findMany({
        where: { businessProfileId: scan.businessProfileId },
        select: { id: true },
      })
    ).map((c) => c.id),
  );
  const namedCategories = [
    ...(input.itemAssignments ?? []).map((a) => a.categoryId),
    ...(input.additionalItems ?? []).map((i) => i.categoryId),
    ...(input.reconciliation?.mode === "category" ? [input.reconciliation.categoryId] : []),
  ];
  if (namedCategories.some((id) => !validCategories.has(id))) {
    throw new ApiError(400, "Category does not belong to this business profile");
  }

  // The itemised path derives its own splits from the stored items, so the
  // amounts written and the item -> record links written come from the same
  // grouping and cannot drift apart.
  let splits: ReceiptSplit[];
  let ownerAdded: { itemId: number; categoryId: number; name: string; lineNumber: number }[] = [];
  if (input.itemAssignments) {
    ownerAdded = await persistOwnerAddedItems(scan.id, input.additionalItems);
    splits = await groupItemsIntoSplits(scan.id, validCategories, [...input.itemAssignments, ...ownerAdded]);
    splits = reconcileSplits(splits, totalCentavos, input.reconciliation ?? { mode: "none" });
  } else {
    splits = input.splits ?? [];
  }

  /*
   * The categoriser's picks, read before the write below destroys them.
   *
   * Writing the expense records sets each item's categoryId to the owner's
   * choice, so once that loop has run the AI's original answer is gone from
   * the database entirely. Comparing afterwards would compare the owner's
   * choice with itself and conclude the categoriser is never wrong. This is
   * the one signal in the whole feedback loop that cannot be recovered later,
   * which is why it is taken here rather than at the end.
   */
  const priorItems = await snapshotItemCategories(scan.id);

  if (splits.length === 0) {
    throw new ApiError(400, "Assign the receipt to at least one category");
  }

  /*
   * The splits must account for the whole receipt, exactly.
   *
   * On the itemised path reconcileSplits has already closed any legitimate
   * gap, so this is now a POST-CONDITION on that arithmetic rather than the
   * owner's problem to solve — if it ever fires there, the allocation is
   * wrong and must not be written. On the manual-split path it is still the
   * original check on what the owner typed.
   */
  const splitCentavos = splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  if (splitCentavos !== totalCentavos) {
    const difference = (splitCentavos - totalCentavos) / 100;
    throw new ApiError(
      400,
      difference > 0
        ? `The categories add up to PHP ${Math.abs(difference).toFixed(2)} more than the receipt total.`
        : `PHP ${Math.abs(difference).toFixed(2)} of the receipt total is not assigned to a category yet.`,
    );
  }

  // One record per category, all pointing back at this scan. Sequential
  // rather than batched on purpose: a receipt splits into a handful of
  // categories at most, and going through createExpenseRecord keeps the
  // duplicate check, the large-expense rule and their notifications
  // identical to a hand-typed expense.
  const records = [];
  for (const split of splits) {
    const record = await createExpenseRecord(userId, {
      businessProfileId: scan.businessProfileId,
      categoryId: split.categoryId,
      date: input.date,
      description: split.description ?? input.description,
      vendor: input.vendor,
      amount: split.amount,
      allocatedCharges: split.allocatedCharges,
      source: "RECEIPT_SCAN",
      receiptScanId: scan.id,
    });
    records.push(record);

    // Point the items that composed this record at it, so "what made up this
    // PHP 1,850 Ingredients entry" stays answerable after the fact.
    if (split.itemIds && split.itemIds.length > 0) {
      await prisma.receiptScanItem.updateMany({
        where: { id: { in: split.itemIds } },
        data: { expenseRecordId: record.id, categoryId: split.categoryId },
      });
    }
  }

  await prisma.receiptScan.update({
    where: { id: scan.id },
    data: { confirmationStatus: "Confirmed" },
  });

  /*
   * Last, and only once the confirmation has actually succeeded.
   *
   * Everything above can still refuse the request — an unassigned item, a
   * split that does not reconcile — and a refused confirmation is not a
   * judgement on the extraction. Recording feedback earlier would file
   * accuracy data for reviews the owner never completed, and would count the
   * same receipt again each time they corrected the problem and retried.
   *
   * The final category per item comes from `splits` rather than from
   * `input.itemAssignments`: splits are what was actually written, after
   * reconciliation, so the feedback cannot disagree with the records.
   */
  const finalCategoryByItemId = new Map<number, number>();
  for (const split of splits) {
    for (const itemId of split.itemIds ?? []) finalCategoryByItemId.set(itemId, split.categoryId);
  }

  await recordConfirmationFeedback({
    scan,
    confirmed: { date: input.date, vendor: input.vendor, amount: input.amount },
    priorItems,
    finalCategoryByItemId,
    ownerAddedItems: ownerAdded.map((i) => ({ name: i.name, lineNumber: i.lineNumber })),
  });

  return records;
}

/**
 * Persists the lines the owner typed in because OCR missed them.
 *
 * They become ordinary ReceiptScanItem rows so everything downstream —
 * grouping, the item -> record links, the breakdown shown when the record is
 * later opened — treats them like any other line. `addedByOwner` is what keeps
 * them honest: the review panel says FinSight *read* the items off the
 * receipt, and that sentence must not cover a row a human supplied.
 *
 * Line numbers continue after the extracted ones, so a hand-added line sorts
 * to the bottom rather than claiming a position on the printed receipt it
 * never occupied.
 */
async function persistOwnerAddedItems(
  receiptScanId: number,
  additionalItems: { name: string; amount: number; categoryId: number }[] | undefined,
): Promise<{ itemId: number; categoryId: number; name: string; lineNumber: number }[]> {
  if (!additionalItems || additionalItems.length === 0) return [];

  const existing = await prisma.receiptScanItem.findMany({
    where: { receiptScanId },
    select: { lineNumber: true },
  });
  let lineNumber = existing.reduce((max, i) => Math.max(max, i.lineNumber), 0);

  // Name and line number ride back out alongside the ids because each of these
  // is also a line OCR failed to read, which extractionFeedback records as a
  // miss. Returning them here avoids re-reading the rows that were just
  // written just to learn what they say.
  const created: { itemId: number; categoryId: number; name: string; lineNumber: number }[] = [];
  for (const item of additionalItems) {
    lineNumber += 1;
    const row = await prisma.receiptScanItem.create({
      data: {
        receiptScanId,
        lineNumber,
        name: item.name.slice(0, 255),
        // A hand-added line is a name and an amount. Quantity and unit price
        // are left null rather than defaulted to 1 — null means "the receipt
        // didn't say", and inventing a quantity would be a number nobody
        // entered.
        quantity: null,
        unitPrice: null,
        amount: item.amount,
        categoryId: item.categoryId,
        addedByOwner: true,
      },
    });
    created.push({ itemId: row.id, categoryId: item.categoryId, name: row.name, lineNumber: row.lineNumber });
  }
  return created;
}

/**
 * Accounts for the difference between what the items come to and what the
 * receipt actually cost.
 *
 * THE RULE THIS ENFORCES: the total the owner confirmed against the photo is
 * the anchor and is never altered. It is what left their pocket. The gap —
 * VAT a register adds on top, a service charge, a discount taken off — gets
 * allocated to categories instead. The alternative, shrinking the total down
 * to the items, silently under-reports the expense, which is the one thing a
 * spending monitor must not do.
 */
function reconcileSplits(
  splits: ReceiptSplit[],
  totalCentavos: number,
  reconciliation: ReconciliationMode,
): ReceiptSplit[] {
  const itemsCentavos = splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  const gapCentavos = totalCentavos - itemsCentavos;

  // Nothing to account for. A VAT-inclusive receipt — the compliant
  // Philippine case, where the printed prices already contain the tax and the
  // VAT block is only a breakdown — lands here, whatever mode was requested.
  if (gapCentavos === 0) return splits;

  if (reconciliation.mode === "none") {
    const difference = Math.abs(gapCentavos) / 100;
    throw new ApiError(
      400,
      gapCentavos > 0
        ? `The items come to PHP ${difference.toFixed(2)} less than the receipt total. Choose how to account for the difference.`
        : `The items come to PHP ${difference.toFixed(2)} more than the receipt total. Choose how to account for the difference.`,
    );
  }

  if (reconciliation.mode === "category") {
    /*
     * A negative gap is a discount — money the owner did NOT spend. Filing it
     * as its own record would mean a negative expense, which every total,
     * chart and insight downstream would have to learn to handle. Spreading
     * it across the categories that were actually discounted is both the
     * correct accounting and the only shape the rest of the app understands.
     */
    if (gapCentavos < 0) {
      throw new ApiError(
        400,
        "A discount can't be filed as its own expense. Spread it across the item categories instead.",
      );
    }
    return [
      ...splits,
      {
        categoryId: reconciliation.categoryId,
        amount: gapCentavos / 100,
        description: CHARGES_DESCRIPTION,
        allocatedCharges: gapCentavos / 100,
      },
    ];
  }

  // Proportional: each category absorbs the share of the gap that matches its
  // own subtotal, so per-category spending stays truthful. Buy PHP 1,000 of
  // inventory and PHP 500 of equipment with PHP 180 of VAT and inventory
  // carries 120 of it, not 90 and not all 180.
  const weights = splits.map((s) => Math.round(s.amount * 100));
  const shares = allocateProportionally(gapCentavos, weights);

  const reconciled = splits.map((split, i) => ({
    ...split,
    amount: (weights[i]! + shares[i]!) / 100,
    allocatedCharges: shares[i]! / 100,
  }));

  // A discount bigger than a category's own items would drive it to zero or
  // below. Refusing beats writing a record for PHP 0.00 that the owner then
  // has to work out the meaning of.
  if (reconciled.some((s) => s.amount <= 0)) {
    throw new ApiError(
      400,
      "The discount is too large to spread across these categories. Check the receipt total and the item amounts.",
    );
  }

  return reconciled;
}

/**
 * Turns the owner's per-item category choices into one split per category.
 *
 * This is where "one record per category group" is actually decided. A
 * fourteen-item grocery run becomes two records, not fourteen: item-level
 * detail belongs to ReceiptScanItem, while the Records table stays one row
 * per finalised transaction.
 */
async function groupItemsIntoSplits(
  receiptScanId: number,
  validCategories: ReadonlySet<number>,
  assignments: { itemId: number; categoryId: number }[],
): Promise<ReceiptSplit[]> {
  const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
  const chosen = new Map(assignments.map((a) => [a.itemId, a.categoryId]));

  // Every assignment must name an item of THIS scan and a category of THIS
  // business — otherwise a crafted request could file an expense under
  // someone else's category, or attach another receipt's items to it. The
  // category half is checked by the caller, before anything is written.
  const itemIds = new Set(items.map((i) => i.id));
  for (const a of assignments) {
    if (!itemIds.has(a.itemId)) {
      throw new ApiError(400, "An item assignment does not belong to this receipt");
    }
    if (!validCategories.has(a.categoryId)) {
      throw new ApiError(400, "Category does not belong to this business profile");
    }
  }
  if (items.some((i) => !chosen.has(i.id))) {
    throw new ApiError(400, "Every item on the receipt needs a category before saving");
  }

  const groups = new Map<number, { centavos: number; names: string[]; itemIds: number[] }>();
  for (const item of items) {
    const categoryId = chosen.get(item.id)!;
    const group = groups.get(categoryId) ?? { centavos: 0, names: [], itemIds: [] };
    group.centavos += Math.round(Number(item.amount) * 100);
    group.names.push(item.name);
    group.itemIds.push(item.id);
    groups.set(categoryId, group);
  }

  return [...groups.entries()].map(([categoryId, g]) => ({
    categoryId,
    amount: g.centavos / 100,
    // The item names ARE the description — "Buns, Ground beef patty, Eggs
    // tray" says far more on the Records table than "Purchase from Puregold".
    description: g.names.join(", ").slice(0, 255),
    itemIds: g.itemIds,
  }));
}
