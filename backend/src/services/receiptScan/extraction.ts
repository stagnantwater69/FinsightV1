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
import { extractReceiptWithVeryfi, type VeryfiPage } from "../veryfiOcr.service";
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
 * The AI vision model (Gemini/Veryfi) is the PRIMARY source and is called on
 * every scan, not only when this fires — see rescueWithVision/rescueWithVeryfi
 * and worker.ts. What this still decides: which of four reasons, if any, the
 * deterministic OCR/tesseract read looked doubtful BEFORE the model answered.
 * That reason is persisted (`visionTrigger`) purely as audit/calibration
 * evidence — "how much did the deterministic read need the model's help".
 * `null` now means "OCR's own read looked fine", not "the model was never
 * asked".
 *
 * WHEN A REASON FIRES — four triggers, in descending order of how certain the
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
 *   compiled in and is right every time. So where the PARSER flagged that
 *   ambiguity (`dateAmbiguous`), its convention-resolved date wins even over
 *   the model's; everywhere else — an unambiguous date, or none at all —
 *   the model's reading wins like any other field, since only the ambiguous
 *   case is a rule the image cannot supply.
 *
 * The model is better at READING what is printed; the parser is better at
 * APPLYING a rule the image cannot supply. This split reflects that.
 */
/**
 * The strongest reason the deterministic parse looks doubtful, or null when
 * it needs no help — shared by every rescue provider (`rescueWithVision`,
 * `rescueWithVeryfi`) so "how doubtful was OCR" has exactly one definition.
 * Ordered most-certain-first, so a log line says the strongest reason rather
 * than whichever check happened to run first. Does NOT gate whether the model
 * is called — it always is — only what gets logged/persisted as
 * `visionTrigger` for calibration.
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

export async function rescueWithVision(
  input: UploadInput,
  parsed: ParsedReceiptFields,
  deterministicItems: ParsedLineItem[],
  combinedText: string,
  worstPageConfidence: number,
): Promise<RescuedFields> {
  const trigger = determineRescueTrigger(deterministicItems, parsed, combinedText, worstPageConfidence);

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

  // The model is the PRIMARY source and is asked on every scan, `trigger` or
  // no — the old short-circuit here (skip the call when OCR looked clean)
  // was a cost optimisation that made sense while OCR was the source of
  // record. It no longer is: OCR is now the fallback, so its own confidence
  // in itself is not a reason to skip asking the source that wins conflicts.
  //
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
   * WHICH READING WINS — the model does, wherever it answered at all.
   *
   * The AI vision read is the PRIMARY source; OCR is the supporting/fallback
   * read, consulted only where the model came back empty for a field. This
   * used to run the other way (OCR wins wherever it produced a non-null
   * value, vision only fills gaps) on the reasoning that a wrong-but-present
   * OCR figure still beat trusting a generative model unconditionally. That
   * reasoning does not license OCR winning EVERY conflict by default just
   * because it ran first — the two known failure modes it protects against
   * are handled directly instead: a model total with nothing to corroborate
   * it, and a wholesale item replacement that does not even add up, both
   * still route through the verifier gate below rather than being trusted
   * blind.
   *
   * ONE exception: the DATE. See the doc comment on determineRescueTrigger's
   * neighbourhood above — a day/month figure like "03/09" where both parts
   * are <= 12 cannot be resolved by reading harder, only by applying the
   * Philippine DD/MM convention the parser has compiled in; measured across
   * repeat runs the model answers that same ambiguous date inconsistently
   * despite being told the convention in its prompt. So the parser's
   * convention-resolved date stands even against a model date, but ONLY when
   * the parser actually flagged the ambiguity — an unambiguous OCR date that
   * merely disagrees with the model is not this case, and the model wins it
   * like any other field.
   *
   * ITEMS get one narrower guard than vendor/amount/date: the model wins
   * whenever its item list is internally consistent (adds up to the
   * receipt's own total) OR OCR had no items to fall back on at all — but
   * where the model reports items that DON'T reconcile and OCR's own items
   * DO, blind trust risks silently dropping a real purchase the owner
   * actually made (an incomplete model item list reading as "the only two
   * items" when a third was on the receipt). That specific shape still
   * routes through the verifier gate below rather than being accepted
   * unchecked — corroboration point 4 asks for, not a preference for OCR.
   */
  const visionReconciles =
    visionItems.length > 0 &&
    reconcileItems(combinedText, visionItems, parsed.amount ?? vision.amount).reconciled;
  const itemsFromVision = visionItems.length > 0 && (visionReconciles || deterministicItems.length === 0);
  const items = itemsFromVision ? visionItems : repairItemNames(deterministicItems, visionItems, trigger);
  const vendor = vision.vendor ?? parsed.vendor;
  const amount = vision.amount ?? parsed.amount;
  const date = parsed.dateAmbiguous && parsed.date !== null ? parsed.date : (vision.date ?? parsed.date);

  /*
   * THE VERIFIER GATE — one extra model call, and only where the settled
   * result is HIGH-RISK: shapes where a wrong model answer has no
   * independent corroboration, or actively conflicts with what OCR read.
   *
   *   - the TOTAL came from the model with nothing for the arithmetic to
   *     check it against (OCR read none at all); or
   *   - the model's total OUTRIGHT DISAGREES with a total OCR did read —
   *     exactly the conflict case point 4 asks to have validated, not just
   *     resolved by fiat; or
   *   - the items came from the model and still fail to reconcile against
   *     the settled total, so the one objective corroboration available
   *     never passed.
   *
   * The verifier may only accept or reject — its response schema is a boolean
   * and a list of field names, so it is structurally incapable of writing a
   * new number. On reject the DETERMINISTIC (OCR) result stands for the
   * rejected shape, plus an UNREADABLE_FIELD warning per rejected field so
   * the owner knows which values to supply from the paper. At most one
   * verifier call per scan; when it cannot run (no key, provider down) the
   * vision result stands unverified, as it always did before the gate
   * existed — the gate must not regress the rescue into never working.
   */
  const visionSuppliedUncheckedTotal = parsed.amount === null && vision.amount !== null;
  const visionAmountConflictsWithOcr =
    parsed.amount !== null && vision.amount !== null && parsed.amount !== vision.amount;
  const itemsUnreconciled = itemsFromVision && !visionReconciles;
  let verifier: string | null = null;
  if (visionSuppliedUncheckedTotal || visionAmountConflictsWithOcr || itemsUnreconciled) {
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
              ...(visionSuppliedUncheckedTotal || visionAmountConflictsWithOcr ? ["amount"] : []),
              ...(itemsUnreconciled ? ["items"] : []),
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
      vendor !== parsed.vendor ||
      amount !== parsed.amount ||
      date !== parsed.date,
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
 * Veryfi's own model tag, recorded on `extractorVersions` the same way
 * `VISION_MODEL` is for Gemini — a constant rather than parsed from an
 * endpoint, because Veryfi's API version is fixed by the URL path
 * (`veryfiOcr.service.ts`'s `ENDPOINT`), not a model name in the response.
 */
const VERYFI_MODEL = "veryfi-partner-v8";

/**
 * Tries Veryfi first among rescues — see
 * docs/superpowers/specs/2026-09-01-veryfi-production-ocr-integration-design.md.
 * Same trigger, same never-throws contract and `RescuedFields` shape as
 * `rescueWithVision`, deliberately WITHOUT that function's verifier gate:
 * Veryfi is a structured extraction API rather than a generative model asked
 * to describe a photo, so the "could invent a plausible-sounding answer"
 * risk the verifier exists for does not apply the same way, and adding a
 * second Gemini call just to check Veryfi's output would spend the very
 * budget this rescue is supposed to save.
 *
 * The caller (`worker.ts`) decides whether this ran at all — gated behind
 * `VERYFI_ENABLED` and the monthly quota — and falls through to
 * `rescueWithVision` whenever this returns a result whose `visionProvider`
 * is not `"veryfi"` (disabled, quota-exhausted, or Veryfi was never reached).
 */
export async function rescueWithVeryfi(
  input: UploadInput,
  parsed: ParsedReceiptFields,
  deterministicItems: ParsedLineItem[],
  combinedText: string,
  worstPageConfidence: number,
): Promise<RescuedFields> {
  const trigger = determineRescueTrigger(deterministicItems, parsed, combinedText, worstPageConfidence);

  const deterministic = (
    audit: Partial<Pick<RescuedFields, "visionLatencyMs" | "visionProvider" | "visionModel" | "visionRejectReason">> = {},
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

  // Primary source, asked on every scan — see the matching note in
  // rescueWithVision.
  const startedAt = Date.now();
  const outcome = await extractReceiptWithVeryfi(
    input.pages.map((p): VeryfiPage => ({ buffer: p.buffer, mimetype: p.mimetype })),
  );
  const elapsedMs = Date.now() - startedAt;
  const veryfi = outcome?.receipt ?? null;

  // Same billing-attribution reasoning as the `[vision-ocr]` line above —
  // this call is billed and fires on receipts a human would call "fine".
  console.info(
    `[veryfi-ocr] business=${input.businessProfileId} trigger=${trigger} reached=${veryfi !== null} ` +
      `pages=${input.pages.length} hadTotal=${parsed.amount !== null} confidence=${worstPageConfidence} ms=${elapsedMs}`,
  );

  if (!veryfi) {
    // Same two-state distinction as rescueWithVision's own miss branch:
    // `outcome` present with no receipt means Veryfi answered and nothing
    // usable came back (attributable to Veryfi itself); no outcome at all
    // means it was never reached (disabled, no credentials, network
    // failure) — the caller's fallback-to-Gemini decision hinges on telling
    // these apart via `visionProvider`.
    return deterministic({
      visionLatencyMs: elapsedMs,
      visionProvider: outcome ? "veryfi" : null,
      visionModel: outcome ? VERYFI_MODEL : null,
      visionRejectReason: outcome?.rejectReason ?? null,
    });
  }

  const veryfiItems: ParsedLineItem[] = veryfi.items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unitPrice: i.quantity && i.quantity > 0 ? Math.round((i.amount / i.quantity) * 100) / 100 : null,
    amount: i.amount,
  }));

  // Veryfi is the PRIMARY source, same as the Gemini path in rescueWithVision
  // — its reading wins conflicts with OCR; OCR only fills a field Veryfi left
  // null. Same DATE exception too: the parser's DD/MM-convention resolution
  // stands over Veryfi's when the parser flagged the date as ambiguous. Same
  // narrower ITEMS guard too — see the matching comment in rescueWithVision —
  // Veryfi has no verifier call to fall back on, so an unreconciled item
  // replacement (Veryfi had SOMETHING to compare against and disagreed with
  // it) keeps OCR's items rather than risk silently dropping a real line.
  const veryfiReconciles =
    veryfiItems.length > 0 &&
    reconcileItems(combinedText, veryfiItems, parsed.amount ?? veryfi.amount).reconciled;
  const itemsFromVision = veryfiItems.length > 0 && (veryfiReconciles || deterministicItems.length === 0);
  const items = itemsFromVision ? veryfiItems : deterministicItems;
  const vendor = veryfi.vendor ?? parsed.vendor;
  const amount = veryfi.amount ?? parsed.amount;
  const date = parsed.dateAmbiguous && parsed.date !== null ? parsed.date : (veryfi.date ?? parsed.date);

  return {
    date,
    vendor,
    description: vendor ? `Purchase from ${vendor}` : "Receipt purchase",
    amount,
    items,
    dateAmbiguous: parsed.date !== null ? parsed.dateAmbiguous : false,
    dateSourceText: parsed.date !== null ? parsed.dateSourceText : null,
    visionAssisted:
      itemsFromVision ||
      vendor !== parsed.vendor ||
      amount !== parsed.amount ||
      date !== parsed.date,
    itemsFromVision,
    visionTrigger: trigger,
    visionLatencyMs: elapsedMs,
    visionProvider: "veryfi",
    visionModel: VERYFI_MODEL,
    visionRejectReason: null,
    verifier: null,
    visionWarnings: [],
    // Veryfi does not report per-item page/source-text provenance the way
    // the Gemini prompt asks the model to — null is the honest "not
    // supplied", same as the deterministic path's own itemEvidence.
    itemEvidence: null,
  };
}

/**
 * Takes the model's wording for lines whose AMOUNTS both readings agree on,
 * for the case where the model's item list did NOT earn a full replacement
 * (it's incomplete, or fails to reconcile on its own) but OCR's items already
 * add up to the printed total on their own.
 *
 * This is the narrow case the low-confidence/does-not-add-up triggers exist
 * for. When the OCR items already add up to the total, the arithmetic
 * corroborates every amount — the numbers are sound. What is not corroborated
 * is the TEXT beside them, and on a page tesseract read at 56% that text is
 * where the damage is: a real Savemore line reading "Del Monte Pineapple
 * Tidbits" came back as "Sey".
 *
 * So the amounts are kept exactly as OCR read them — they are the figures
 * that reach the owner's books, and they have independent corroboration the
 * names do not — while the names are taken from the model, which reads the
 * same receipt without tesseract's character-level guessing.
 *
 * Matching is by amount, and each vision line is consumed once so two items
 * at the same price cannot both claim the same name. A line the model did not
 * report keeps the name OCR gave it.
 */
function repairItemNames(
  deterministic: ParsedLineItem[],
  visionItems: ParsedLineItem[],
  trigger: string | null,
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
