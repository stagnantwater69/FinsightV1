/**
 * Recording what FinSight read against what the owner confirmed.
 *
 * The confirm screen is the only place this app is ever told whether an
 * extraction was right, by the one person who can actually see the receipt.
 * That answer used to be discarded the instant it was given: the owner's
 * edits went to ExpenseRecord, the reading stayed on ReceiptScan, and nothing
 * anywhere recorded that the two disagreed. This module is what writes it down.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * First, a row is written for every field REVIEWED, not for every field
 * CHANGED. Logging only the changes would produce a numerator with no
 * denominator — "vendor was corrected 40 times" is not an accuracy figure
 * without knowing how many vendors were shown. It would also lose the case
 * this measurement exists for: a field read at 30% confidence that the owner
 * confirmed untouched says the CONFIDENCE SCORE is miscalibrated, not that the
 * extraction is bad, and nothing was edited to record it by.
 *
 * Second, nothing in here may cost an owner their confirmation. Every entry
 * point is wrapped so a failure to record feedback is logged and swallowed.
 * An owner losing a receipt they had just finished reviewing, because an
 * analytics write failed, would be an indefensible trade.
 *
 * WHAT AN UNEDITED FIELD IS WORTH. It is a weaker label than an edited one and
 * the reports say so. Owners satisfice: some confirmations are a genuine
 * check, others are a glance and a tap. So an unedited field is evidence, not
 * proof, and it is systematically biased towards agreement — the screen shows
 * FinSight's answer first, which is a suggestion the owner has to actively
 * disagree with. Edits are the clean signal; confirmations are the noisy one;
 * they must not be averaged into a single "accuracy" number that hides the
 * difference. See `docs/extraction-feedback.md`.
 */
import type { Prisma, ReceiptScan, ReceiptScanItem } from "@prisma/client";
import { prisma } from "../config/prisma";
import { utcDateKey } from "../lib/dates";
import { amountsMatch, datesMatch, vendorsMatch } from "../lib/fieldComparison";
import { logger } from "../config/logger";

/**
 * Which comparison a row records.
 *
 * `itemPresence` is the odd one out: it is not a value that was changed but a
 * LINE that was added or removed. A null original means OCR missed a line the
 * owner had to type in; a null final means it read a line that was never a
 * purchase. Both are extraction errors and neither shows up as a wrong value
 * anywhere else, because the field they got wrong is the existence of the row.
 */
export type CorrectionField = "date" | "vendor" | "amount" | "itemCategory" | "itemPresence";

/** Who produced the original reading — see the schema note on why this matters. */
export type CorrectionSource = "ocr" | "vision" | "ai-category";

interface PendingCorrection {
  field: CorrectionField;
  source: CorrectionSource;
  originalValue: string | null;
  finalValue: string | null;
  itemName?: string | null;
  lineNumber?: number | null;
  confidence?: number | null;
  wasEdited: boolean;
}

/** VarChar(255) on the way in, so a long line cannot fail the write. */
function clip(value: string | null): string | null {
  return value === null ? null : value.slice(0, 255);
}

function sourceForScan(scan: Pick<ReceiptScan, "visionAssisted">): CorrectionSource {
  return scan.visionAssisted ? "vision" : "ocr";
}

/**
 * The categoriser's pick for each extracted line, read BEFORE confirmation
 * overwrites it.
 *
 * This snapshot is not an optimisation, it is the only way this signal can be
 * captured at all. `confirmReceipt` sets `ReceiptScanItem.categoryId` to the
 * owner's choice as it writes the expense records, so by the time the
 * confirmation has succeeded the AI's original answer no longer exists
 * anywhere. Reading it afterwards would compare the owner's choice with
 * itself and conclude the categoriser is always right.
 *
 * Owner-added lines are excluded here rather than filtered later: they carry
 * no AI pick to disagree with, and schema note 12 is explicit that a row a
 * human supplied must never be counted as something FinSight extracted.
 */
export async function snapshotItemCategories(receiptScanId: number): Promise<Map<number, ReceiptScanItem>> {
  const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId, addedByOwner: false } });
  return new Map(items.map((i) => [i.id, i]));
}

interface ConfirmationFeedbackInput {
  scan: ReceiptScan;
  /** The values the owner confirmed. */
  confirmed: { date: string; vendor?: string; amount: number };
  /** The categoriser's picks, from `snapshotItemCategories` before the write. */
  priorItems: Map<number, ReceiptScanItem>;
  /** The owner's final category per item, as actually written. */
  finalCategoryByItemId: Map<number, number>;
  /** Lines the owner typed in because nothing read them. */
  ownerAddedItems: { name: string; lineNumber: number }[];
}

/**
 * Compares a confirmed receipt against what was read, and writes one row per
 * reviewed field.
 *
 * Never throws. See the module header.
 */
export async function recordConfirmationFeedback(input: ConfirmationFeedbackInput): Promise<void> {
  try {
    const rows = await buildConfirmationCorrections(input);
    if (rows.length === 0) return;

    await prisma.receiptFieldCorrection.createMany({
      data: rows.map((r) => ({
        receiptScanId: input.scan.id,
        field: r.field,
        source: r.source,
        originalValue: clip(r.originalValue),
        finalValue: clip(r.finalValue),
        itemName: clip(r.itemName ?? null),
        lineNumber: r.lineNumber ?? null,
        confidence: r.confidence ?? null,
        wasEdited: r.wasEdited,
      })),
    });
  } catch (err) {
    // Swallowed on purpose — the owner's receipt is already confirmed and
    // must stay that way. This is the only place the failure is visible, so
    // it names the scan.
    logger.error({ err }, `[extraction-feedback] could not record feedback for scan=${input.scan.id}`);
  }
}

async function buildConfirmationCorrections(input: ConfirmationFeedbackInput): Promise<PendingCorrection[]> {
  const { scan, confirmed, priorItems, finalCategoryByItemId, ownerAddedItems } = input;
  const rows: PendingCorrection[] = [];
  const scanSource = sourceForScan(scan);

  /*
   * A field neither read nor entered is skipped, not scored as correct.
   *
   * This is the harness's `n/a` verdict, and it has to be honoured here for
   * the same reason: a receipt whose header was cropped off has no vendor to
   * get right, and recording "FinSight and the owner agreed there was no
   * vendor" as a correct read would inflate vendor accuracy with rows that
   * measure nothing.
   */
  const readDate = scan.extractedDate ? utcDateKey(scan.extractedDate) : null;
  if (readDate !== null || confirmed.date) {
    rows.push({
      field: "date",
      source: scanSource,
      originalValue: readDate,
      finalValue: confirmed.date,
      // The scan-level figure, not a per-field one: tesseract reports
      // confidence per word, and a date is assembled from a parse over lines
      // rather than lifted from one. Recording the page figure is honest
      // about what it describes; inventing a per-field number would not be.
      confidence: scan.ocrConfidence,
      wasEdited: !datesMatch(readDate, confirmed.date),
    });
  }

  const finalVendor = confirmed.vendor?.trim() || null;
  if (scan.extractedVendor !== null || finalVendor !== null) {
    rows.push({
      field: "vendor",
      source: scanSource,
      originalValue: scan.extractedVendor,
      finalValue: finalVendor,
      confidence: scan.vendorConfidence,
      wasEdited: !vendorsMatch(scan.extractedVendor, finalVendor),
    });
  }

  const readAmount = scan.extractedAmount === null ? null : Number(scan.extractedAmount);
  rows.push({
    field: "amount",
    source: scanSource,
    originalValue: readAmount === null ? null : readAmount.toFixed(2),
    finalValue: confirmed.amount.toFixed(2),
    confidence: scan.amountConfidence,
    wasEdited: !amountsMatch(readAmount, confirmed.amount),
  });

  // ---- Per line ----

  const categoryNames = await categoryNameLookup(priorItems, finalCategoryByItemId);

  for (const [itemId, item] of priorItems) {
    const finalCategoryId = finalCategoryByItemId.get(itemId);
    // A line with no final category was deleted before confirmation, and
    // deleteScanItem has already recorded that as an itemPresence row. Adding
    // a categorisation row for it would count one mistake twice.
    if (finalCategoryId === undefined) continue;

    rows.push({
      field: "itemCategory",
      source: "ai-category",
      originalValue: item.categoryId === null ? null : (categoryNames.get(item.categoryId) ?? null),
      finalValue: categoryNames.get(finalCategoryId) ?? null,
      itemName: item.name,
      lineNumber: item.lineNumber,
      /*
       * Deliberately null, and not `item.amountConfidence`.
       *
       * That column is how sure OCR was that it read this line's AMOUNT
       * correctly. It says nothing about whether the categoriser filed the
       * line correctly — those are different questions answered by different
       * systems, and a confident reading of "PANDESAL 45.00" tells you
       * nothing about whether Supplies was the right category for it.
       * Borrowing it would put a real-looking number into the calibration
       * report that no model ever produced.
       */
      confidence: null,
      wasEdited: item.categoryId !== finalCategoryId,
    });
  }

  for (const added of ownerAddedItems) {
    rows.push({
      field: "itemPresence",
      source: scanSource,
      // Nothing was read here — that is the finding.
      originalValue: null,
      finalValue: added.name,
      itemName: added.name,
      lineNumber: added.lineNumber,
      confidence: null,
      wasEdited: true,
    });
  }

  return rows;
}

/** id -> name for every category named on either side of a comparison. */
async function categoryNameLookup(
  priorItems: Map<number, ReceiptScanItem>,
  finalCategoryByItemId: Map<number, number>,
): Promise<Map<number, string>> {
  const ids = new Set<number>();
  for (const item of priorItems.values()) {
    if (item.categoryId !== null) ids.add(item.categoryId);
  }
  for (const id of finalCategoryByItemId.values()) ids.add(id);
  if (ids.size === 0) return new Map();

  const rows = await prisma.expenseCategory.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((c) => [c.id, c.name]));
}

/**
 * Records a line the owner removed as never having been a purchase.
 *
 * Written at DELETION rather than at confirmation because the row is
 * hard-deleted — by the time the receipt is confirmed there is nothing left to
 * observe. This is the false-positive signal, and it is the one that matters
 * most on the extraction side: a fabricated line puts money in an owner's
 * records that was never on the receipt.
 *
 * Recorded even if the scan is never confirmed. The observation is still true
 * — OCR read something that was not there — and reports that only want
 * completed reviews can filter on the scan's confirmation status.
 *
 * Never throws: an owner tidying up a bad line must not be blocked by it.
 */
export async function recordDeletedLine(scan: ReceiptScan, item: ReceiptScanItem): Promise<void> {
  try {
    // An owner-added line being removed is someone undoing their own typing,
    // not OCR getting anything wrong. Recording it would count a correction
    // against the extraction that the extraction never made.
    if (item.addedByOwner) return;

    await prisma.receiptFieldCorrection.create({
      data: {
        receiptScanId: scan.id,
        field: "itemPresence",
        source: item.extractedByVision ? "vision" : "ocr",
        originalValue: clip(item.name),
        // Nothing survives on the owner's side — that is the finding.
        finalValue: null,
        itemName: clip(item.name),
        lineNumber: item.lineNumber,
        confidence: item.amountConfidence,
        wasEdited: true,
      },
    });
  } catch (err) {
    logger.error({ err }, `[extraction-feedback] could not record deleted line item=${item.id}`);
  }
}

export type CorrectionRow = Prisma.ReceiptFieldCorrectionGetPayload<Record<string, never>>;

export interface CorrectionQuery {
  /** Only corrections recorded on or after this moment. */
  since?: Date;
  /** Scope to one business, for a per-owner view. Omitted, this is every scan. */
  businessProfileId?: number;
  /**
   * Only scans the owner actually finished reviewing. Defaults to true.
   *
   * An abandoned scan has usually had a line or two deleted and nothing else,
   * so its rows are all corrections and no confirmations — including them
   * would drag every accuracy figure down with reviews nobody completed. The
   * exception is deliberate rather than accidental: `itemPresence` rows are
   * written at deletion precisely because the row will not survive to
   * confirmation, and a report on false positives wants them regardless.
   */
  confirmedOnly?: boolean;
}

/**
 * The recorded corrections, for the reporting and calibration scripts.
 *
 * Read-only and unaggregated on purpose — the arithmetic lives in
 * lib/extractionMetrics, which is a pure module precisely so the figures can
 * be tested against hand-written rows instead of against whatever is in a
 * database on a given day.
 */
export async function loadCorrections(query: CorrectionQuery = {}): Promise<CorrectionRow[]> {
  const { since, businessProfileId, confirmedOnly = true } = query;

  return prisma.receiptFieldCorrection.findMany({
    where: {
      ...(since ? { createdAt: { gte: since } } : {}),
      receiptScan: {
        ...(businessProfileId ? { businessProfileId } : {}),
        ...(confirmedOnly ? { confirmationStatus: "Confirmed" } : {}),
      },
    },
    orderBy: { createdAt: "asc" },
  });
}
