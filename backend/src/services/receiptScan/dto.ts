import type { ReceiptScan, ReceiptScanItem, ReceiptScanPage } from "@prisma/client";
import { findPageSeams, looksLikeDuplicatePage, looksLikeMultipleReceipts, reconcileItems } from "../ocr.service";
import { WARNING_GUIDANCE, type ReceiptWarning } from "../../lib/receiptWarnings";

export function toDTO(scan: ReceiptScan, items: ReceiptScanItem[] = [], pages: ReceiptScanPage[] = []) {
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
     * Machine-readable warnings the pipeline recorded while reading this
     * scan — lib/receiptWarnings is the vocabulary. ADDITIVE to the booleans
     * above (visionAssisted, duplicatePages, ...), which the clients already
     * render from and which keep working unchanged; these carry the same
     * signals plus the ones the booleans could not (an unexplained gap, an
     * ambiguous date), each with the server's one actionable guidance string
     * so the two clients stop hardcoding drifting prose. Empty for scans read
     * before warnings were recorded.
     */
    warnings: (((scan.warnings as unknown as ReceiptWarning[] | null) ?? []).map((w) => ({
      ...w,
      guidance: WARNING_GUIDANCE[w.code] ?? null,
    }))),
    /**
     * Where each extracted field was read from: page number, the visible
     * source line, and which engine read it ("ocr" | "vision"). Null for
     * scans read before evidence was recorded. Never invented — a field
     * whose origin could not be located carries nulls inside its entry.
     */
    fieldEvidence:
      (scan.fieldEvidence as unknown as Record<
        string,
        { pageNumber: number | null; sourceText: string | null; source: string | null }
      > | null) ?? null,
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
      /**
       * Which page and printed line this item was read from, and by what
       * ("ocr" | "vision"). Null where nothing could be located — including
       * every scan read before evidence was recorded.
       */
      evidence:
        (i.evidence as unknown as { pageNumber: number | null; sourceText: string | null; source: string } | null) ??
        null,
    })),
  };
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
