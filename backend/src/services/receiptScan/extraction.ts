import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import {
  findPageSeams,
  locateValue,
  looksLikeDuplicatePage,
  looksLikeMultipleReceipts,
  reconcileItems,
  type ParsedLineItem,
  type ParsedReceiptFields,
} from "../ocr.service";
import { findKnownVendorInText } from "../../lib/historyMatching";
import { assessImageQuality } from "../../lib/imageQuality";
import type { ReceiptWarning } from "../../lib/receiptWarnings";
import type { FieldEvidenceEntry, RescuedFields } from "./types";

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
export async function snapVendorToHistory(
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

  logger.info({ businessProfileId, score: match.score }, "Receipt vendor matched confirmed history");
  return match.value;
}

/**
 * Page confidence at or below which tesseract is treated as having guessed.
 *
 * CHOSEN FROM MEASUREMENT, re-derived as the corpus grew — see
 * tests/ocr-accuracy/confidence-calibration.ts, which reports the confidence
 * of every corpus image against whether its parse was right, and re-run it
 * after any parser/preprocessing change; the constant below should track it.
 *
 * REVISED (Phase 4 of docs/receipt-ocr-accuracy-plan.md), from 75 to 88, once
 * the corpus grew from 3 real photos (of 31) to 45 real photos (of 73) and
 * Phase 3's parser fixes had already landed — the plan explicitly deferred
 * this exact re-tuning until both of those were true, so a fitted threshold
 * wasn't chasing bugs a parser fix should have removed instead.
 *
 * At 3 real photos the clean/broken groups separated with an empty band (56
 * to 89) wide enough that any pick in the middle was safe. That separation
 * does not hold at 73 images: the broken group now reaches confidence 89, as
 * high as some clean reads, so no threshold below 90 can be "safe" in the old
 * all-or-nothing sense — every choice trades catch-rate against false
 * triggers. What the fresh sweep (`confidence-calibration.json`, all 73
 * images) actually shows:
 *
 *   thresh  fires  catches-broken  wasted-on-clean  misses-broken
 *       75     35              34                1              9
 *       80     39              38                1              5
 *       85     42              41                1              2
 *       88     43              42                1              1
 *       90     45              43                2              0
 *
 * One real clean receipt (`real-29-saska-paperclip-clipboard`, confidence 74)
 * already fires below the OLD threshold of 75 — that single false trigger is
 * not introduced by this change, and it stays exactly one false trigger all
 * the way from 75 to 89, because no other clean receipt in the corpus scores
 * below 90. So 88 catches 8 more real broken cases than 75 did — including
 * all 3 of the wrong-AMOUNT cases the old threshold missed
 * (real-25-boa-dark-background, real-27-pappadeaux-ambiguous-us-date,
 * real-28-carls-jr-translucent-bleed) — for zero additional false-trigger
 * cost. 90 is where that stops being true: the last remaining broken case
 * (`real-21-jts-diner-clean`) sits at exactly the same confidence (89) as a
 * clean synthetic receipt (`syn-02-vendor-bottom`), so no threshold can catch
 * one without flagging the other — 90 is the first value that pays for that
 * last catch with a second false trigger, which is why this stops at 88
 * rather than 90.
 *
 * This is still the WEAKEST of the four triggers — an empty read, a missing
 * total and a receipt that does not add up all fire on their own evidence,
 * whatever the confidence says.
 */
export const LOW_CONFIDENCE = 88;

/**
 * Returns the strongest local signal that the owner should review. Provider
 * routing is decided separately from structured local assessment and can only
 * proceed through the consent and budget dispatch gate.
 */
export function determineRescueTrigger(
  deterministicItems: ParsedLineItem[],
  parsed: ParsedReceiptFields,
  combinedText: string,
  /**
   * The worst per-page confidence, not an average. One unreadable page in an
   * otherwise clean 3-page receipt is still a page the owner needs help
   * with — averaging it away would let two good pages outvote the one that
   * actually needs the model.
   */
  worstPageConfidence: number,
): "no-items" | "no-total" | "does-not-add-up" | "low-confidence" | null {
  const reconciliation = reconcileItems(combinedText, deterministicItems, parsed.amount);
  return deterministicItems.length === 0
    ? "no-items"
    : parsed.amount === null
      ? "no-total"
      : !reconciliation.reconciled
        ? "does-not-add-up"
        : worstPageConfidence < LOW_CONFIDENCE
          ? "low-confidence"
          : null;
}

/**
 * Where each extracted field was read from.
 *
 * The defect this fixes: confidenceForValue already re-derives every value's
 * location at write time to score it, then discards the location — so the
 * review screen could say HOW SURE the engine was but never WHERE the value
 * came from. A field the deterministic parser produced is located in the page
 * it was parsed from; a field the model supplied is marked "vision" with no
 * page/line claimed unless one can be shown. A field with no value gets no
 * entry, and a located line is the only kind ever reported — never invented.
 */
export function buildFieldEvidence(
  pageTexts: string[],
  parsed: ParsedReceiptFields,
  rescued: RescuedFields,
  vendor: string | null,
): Partial<Record<"date" | "vendor" | "amount", FieldEvidenceEntry>> {
  const entry = (value: string | null, fromOcr: boolean, locateBy: string | null): FieldEvidenceEntry | null => {
    if (value === null) return null;
    if (!fromOcr) return { pageNumber: null, sourceText: null, source: "vision" };
    const located = locateValue(pageTexts, locateBy ?? value);
    return { pageNumber: located?.pageNumber ?? null, sourceText: located?.sourceText ?? null, source: "ocr" };
  };

  // The date is located by the RAW matched text ("25/07/2026"), because the
  // normalised ISO value the parser returns is not what is printed. The
  // vendor is located by its FINAL spelling; a history-corrected name that no
  // longer appears verbatim on the receipt honestly locates nowhere. A value
  // is OCR's only while it is still the parser's own: one the provider
  // replaced is the model's reading even though the parser also had one.
  const date = entry(rescued.date, parsed.date !== null && rescued.date === parsed.date, rescued.dateSourceText);
  const vendorEntry = entry(vendor, parsed.vendor !== null && rescued.vendor === parsed.vendor, vendor);
  const amount = entry(
    rescued.amount !== null ? rescued.amount.toFixed(2) : null,
    parsed.amount !== null && rescued.amount === parsed.amount,
    rescued.amount !== null ? rescued.amount.toFixed(2) : null,
  );

  return {
    ...(date ? { date } : {}),
    ...(vendorEntry ? { vendor: vendorEntry } : {}),
    ...(amount ? { amount } : {}),
  };
}

/**
 * Every machine-readable warning the pipeline can already stand behind,
 * assembled once at process time from signals it was computing anyway.
 *
 * Persisted (rather than derived in toDTO like duplicatePages) because two of
 * the inputs — the in-memory page qualities including tooSmallToRead, and the
 * rescue's own account of itself — do not survive to read time in full.
 * Deduplicated on (code, field, pageNumber) so the parser and the model both
 * flagging the same ambiguous date reads as one warning, not an echo.
 */
export function buildScanWarnings(args: {
  pageQualities: (Awaited<ReturnType<typeof assessImageQuality>>)[];
  pageTexts: string[];
  combinedText: string;
  seamFreeText: string;
  parsed: ParsedReceiptFields;
  rescued: RescuedFields;
  worstPageConfidence: number;
}): ReceiptWarning[] {
  const { pageQualities, pageTexts, combinedText, seamFreeText, parsed, rescued, worstPageConfidence } = args;
  const warnings: ReceiptWarning[] = [];

  pageQualities.forEach((q, i) => {
    if (q?.tooBlurredToTrust) warnings.push({ code: "BLURRY_PAGE", pageNumber: i + 1 });
    if (q?.tooSmallToRead) warnings.push({ code: "TOO_SMALL", pageNumber: i + 1 });
  });

  for (let i = 1; i < pageTexts.length; i++) {
    if (looksLikeDuplicatePage(pageTexts[i - 1] ?? "", pageTexts[i] ?? "")) {
      warnings.push({ code: "DUPLICATE_PAGE", pageNumber: i + 1 });
    }
  }
  for (const seam of findPageSeams(pageTexts)) {
    warnings.push({
      code: "OVERLAPPING_PAGES",
      pageNumber: seam.pageNumber,
      detail: `${seam.lineCount} line(s) repeat across the seam`,
    });
  }

  if (looksLikeMultipleReceipts(combinedText)) warnings.push({ code: "MULTI_RECEIPT" });

  /*
   * Reconciled against the SAME text the surviving items were parsed from —
   * a seam-deduplicated item list checked against the full concatenation
   * would re-open the exact gap the deduplication just closed.
   */
  const itemsWereSeamDeduped = !rescued.itemsFromVision && seamFreeText !== combinedText
    && reconcileItems(seamFreeText, rescued.items, rescued.amount).reconciled
    && !reconcileItems(combinedText, rescued.items, rescued.amount).reconciled;
  const reconciliation = reconcileItems(itemsWereSeamDeduped ? seamFreeText : combinedText, rescued.items, rescued.amount);
  if (!reconciliation.reconciled) {
    warnings.push({
      code: "UNEXPLAINED_GAP",
      field: "amount",
      detail: `reason=${reconciliation.reason} itemsTotal=${reconciliation.itemsTotal} total=${reconciliation.total} difference=${reconciliation.difference}`,
    });
  }

  if (worstPageConfidence < LOW_CONFIDENCE) {
    warnings.push({ code: "LOW_CONFIDENCE", detail: `worst page confidence ${worstPageConfidence}` });
  }

  if (rescued.visionAssisted) warnings.push({ code: "VISION_INTERPRETED" });

  // The parser's own admission that a convention, not the paper, chose the
  // day/month order — carrying the visible text so the owner can re-read it.
  if (rescued.dateAmbiguous && rescued.date !== null && parsed.date !== null) {
    warnings.push({
      code: "AMBIGUOUS_DATE",
      field: "date",
      ...(rescued.dateSourceText ? { detail: rescued.dateSourceText } : {}),
    });
  }

  // Whatever the model or the verifier flagged, already validated against the
  // shared vocabulary at the vision boundary.
  warnings.push(...rescued.visionWarnings);

  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}|${w.field ?? ""}|${w.pageNumber ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
