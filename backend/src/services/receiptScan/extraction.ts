import { prisma } from "../../config/prisma";
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
import { extractReceiptWithVision, verifyVisionReceipt, VISION_MODEL, type VisionPage } from "../visionOcr.service";
import type { ReceiptWarning } from "../../lib/receiptWarnings";
import type { FieldEvidenceEntry, RescuedFields, UploadInput } from "./types";

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

  console.info(
    `[vendor-history] business=${businessProfileId} read=${JSON.stringify(parsedVendor)} ` +
      `corrected=${JSON.stringify(match.value)} score=${match.score.toFixed(3)}`,
  );
  return match.value;
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
export const LOW_CONFIDENCE = 75;

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
export async function rescueWithVision(
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

  /** The deterministic result, with the attempt's audit fields filled in. */
  const deterministic = (
    audit: Partial<Pick<RescuedFields, "visionLatencyMs" | "visionProvider" | "visionModel" | "visionRejectReason" | "verifier" | "visionWarnings">> = {},
  ): RescuedFields => ({
    ...parsed,
    items: deterministicItems,
    visionAssisted: false,
    itemsFromVision: false,
    visionTrigger: trigger,
    visionLatencyMs: null,
    visionProvider: null,
    visionModel: null,
    visionRejectReason: null,
    verifier: null,
    visionWarnings: [],
    itemEvidence: null,
    ...audit,
  });

  if (trigger === null) {
    return deterministic();
  }

  // Never throws — a failed rescue leaves the scan exactly as the
  // deterministic parse left it, which is still a correctable draft.
  const startedAt = Date.now();
  const outcome = await extractReceiptWithVision(
    input.pages.map((p): VisionPage => ({ buffer: p.buffer, mimetype: p.mimetype })),
  );
  const elapsedMs = Date.now() - startedAt;
  const vision = outcome?.receipt ?? null;

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
    // Two distinct failures share this exit and the persisted record keeps
    // them apart: an outcome with a rejectReason means the provider answered
    // and the answer failed validation (a MODEL/PROMPT problem, attributable
    // to the versions recorded alongside); no outcome at all means the
    // provider was never usefully reached (an INFRASTRUCTURE problem).
    return deterministic({
      visionLatencyMs: elapsedMs,
      visionProvider: outcome ? "gemini" : null,
      visionModel: outcome ? VISION_MODEL : null,
      visionRejectReason: outcome?.rejectReason ?? null,
    });
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
   * The model's own account of WHERE each line came from, kept aligned with
   * visionItems by index. Only ever what the model itself reported — a page
   * or source line it did not supply stays null rather than being inferred.
   */
  const visionItemEvidence = vision.items.map((i) => ({
    pageNumber: i.pageNumber ?? null,
    sourceText: i.sourceText ?? null,
  }));

  /*
   * Warnings the model raised about its own reading, carried into the shared
   * vocabulary. The model names the total field "total" (its schema's word);
   * everywhere else in this service the field is "amount", and one name has
   * to win before the client renders it.
   */
  const modelWarnings: ReceiptWarning[] = vision.warnings.map((w) => ({
    code: w.code,
    ...(w.field ? { field: w.field === "total" ? "amount" : w.field } : {}),
    ...(w.detail ? { detail: w.detail } : {}),
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

  /*
   * THE VERIFIER GATE — one extra model call, and only where the result is
   * HIGH-RISK: the two shapes where a wrong vision answer has no independent
   * corroboration at all.
   *
   *   - the TOTAL came from the model and OCR never read one, so there is no
   *     printed figure the arithmetic can check it against; or
   *   - the items were replaced wholesale and STILL fail to reconcile, so the
   *     objective test that normally earns a replacement never passed (this
   *     is the empty-deterministic-read case — a reconciling replacement is
   *     already corroborated by the receipt's own total and is not re-asked).
   *
   * The verifier may only accept or reject — its response schema is a boolean
   * and a list of field names, so it is structurally incapable of writing a
   * new number. On reject the DETERMINISTIC result stands, exactly as if the
   * rescue had never answered, plus an UNREADABLE_FIELD warning per rejected
   * field so the owner knows which values to supply from the paper. At most
   * one verifier call per scan; when it cannot run (no key, provider down)
   * the vision result stands unverified, as it always did before the gate
   * existed — the gate must not regress the rescue into never working.
   */
  const visionSuppliedUncheckedTotal = parsed.amount === null && vision.amount !== null;
  const itemsReplacedUnreconciled = itemsFromVision && !visionReconciles;
  let verifier: string | null = null;
  if (visionSuppliedUncheckedTotal || itemsReplacedUnreconciled) {
    const verdict = await verifyVisionReceipt(
      input.pages.map((p): VisionPage => ({ buffer: p.buffer, mimetype: p.mimetype })),
      { date, vendor, amount, items: items.map((i) => ({ name: i.name, amount: i.amount })) },
    );
    if (verdict?.accept === false) {
      // A rejection naming no fields still means "do not trust this"; the
      // fields that made the result high-risk are the honest default.
      const rejectedFields =
        verdict.rejectedFields.length > 0
          ? verdict.rejectedFields
          : [
              ...(visionSuppliedUncheckedTotal ? ["amount"] : []),
              ...(itemsReplacedUnreconciled ? ["items"] : []),
            ];
      console.info(
        `[vision-verifier] business=${input.businessProfileId} verdict=rejected fields=${rejectedFields.join(",")}`,
      );
      return deterministic({
        visionLatencyMs: elapsedMs,
        visionProvider: "gemini",
        visionModel: VISION_MODEL,
        verifier: `rejected:${rejectedFields.join(",")}`,
        visionWarnings: rejectedFields.map((field) => ({ code: "UNREADABLE_FIELD" as const, field })),
      });
    }
    verifier = verdict ? "accepted" : null;
  }

  return {
    date,
    vendor,
    // Rebuilt rather than carried over, so a vendor the model supplied is
    // reflected in the description the owner sees instead of the parser's
    // "Receipt purchase" fallback for a vendor it never found.
    description: vendor ? `Purchase from ${vendor}` : "Receipt purchase",
    amount,
    items,
    // Ambiguity is a property of the PARSER's reading; a model-supplied ISO
    // date was not resolved by the DD/MM convention (the model flags its own
    // ambiguity through `warnings` instead).
    dateAmbiguous: parsed.date !== null ? parsed.dateAmbiguous : false,
    dateSourceText: parsed.date !== null ? parsed.dateSourceText : null,
    visionAssisted:
      itemsFromVision ||
      items.some((item, i) => item.name !== deterministicItems[i]?.name) ||
      (parsed.amount === null && amount !== null) ||
      (parsed.vendor === null && vendor !== null) ||
      (parsed.date === null && date !== null),
    itemsFromVision,
    visionTrigger: trigger,
    visionLatencyMs: elapsedMs,
    visionProvider: "gemini",
    visionModel: VISION_MODEL,
    visionRejectReason: null,
    verifier,
    visionWarnings: modelWarnings,
    itemEvidence: itemsFromVision ? visionItemEvidence : null,
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
  // longer appears verbatim on the receipt honestly locates nowhere.
  const date = entry(rescued.date, parsed.date !== null, rescued.dateSourceText);
  const vendorEntry = entry(vendor, parsed.vendor !== null, vendor);
  const amount = entry(
    rescued.amount !== null ? rescued.amount.toFixed(2) : null,
    parsed.amount !== null,
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
