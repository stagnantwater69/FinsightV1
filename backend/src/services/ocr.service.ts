import { createWorker } from "tesseract.js";
import sharp from "sharp";
import { env } from "../config/env";
import { logger } from "../config/logger";

/**
 * Version tags for the deterministic half of the extraction pipeline,
 * recorded on every scan (ReceiptScan.extractorVersions).
 *
 * The defect these prevent: a parser or preprocessing change silently changes
 * what gets extracted, and weeks later a regression in the correction metrics
 * cannot be attributed to anything — every scan looks like it was read by
 * "the parser". Bump the tag with any behaviour-relevant change to the
 * corresponding code, so accuracy reports can split before/after.
 */
export const PARSER_VERSION = "ocr-parser-v1";
export const PREPROCESS_VERSION = "ocr-preprocess-v1";

/**
 * The width a receipt photo is reduced to before OCR.
 *
 * Only ever DOWN. A modern phone camera produces a 3000-4000px image of a
 * receipt whose text is maybe 300px wide, and tesseract does not read that
 * any better for the extra pixels — it just spends longer. Upscaling is
 * deliberately not done either: enlarging a blurry capture invents no
 * detail, it only makes the blur bigger.
 */
const MAX_WIDTH = 2000;

/**
 * Prepares a photo for tesseract.
 *
 * THIS IS NOT AN ACCURACY IMPROVEMENT, and the comment says so because the
 * obvious assumption is that it must be. Measured against the 30-image
 * corpus, these three operations together score EXACTLY the same as feeding
 * tesseract the raw bytes — same date, vendor, amount and item figures, image
 * for image. What they buy is orientation correctness and a smaller image to
 * work on, not better reading.
 *
 * What each one is here for:
 *   - `rotate()` with no argument applies the EXIF orientation flag a phone
 *     camera writes. This is the one with a real correctness case behind it:
 *     a receipt photographed in portrait and tagged sideways is unreadable
 *     otherwise. The corpus cannot demonstrate it, because none of its images
 *     carry an orientation flag.
 *   - the resize is a cost control. A modern phone sends a 3000-4000px image
 *     of a receipt whose text is a few hundred pixels wide; tesseract reads
 *     that no better and takes longer doing it. Capped, never enlarged.
 *   - `grayscale()` discards colour tesseract does not use.
 *
 * WHAT WAS TRIED AND REJECTED, so it is not retried on the same assumption:
 *
 *   - `normalize()` (global contrast stretch) — MEASURED REGRESSION. On the
 *     real crumpled thermal photo in the corpus it turned the 188.00 total
 *     into 8 and the year 2026 into 2028: stretching the whole frame on a
 *     bright table background pushes the faint thermal strokes out, and a
 *     leading "1" is exactly what goes first. Date and amount both fell from
 *     100% to 97%.
 *   - `.clahe()` (genuinely local, adaptive contrast — the technique that
 *     uneven lighting actually calls for) at window sizes 3 through 100 —
 *     neutral at best, and worse at small windows, where it destroyed the
 *     date and amount entirely.
 *   - median denoise, 2x upscaling, and sharpening — neutral or worse.
 *
 * None of them recovered the two line items lost on that photo. That failure
 * is not a contrast problem: tesseract returns the item block as
 * "Spareribs Keal Res FLV", with no legible amount anywhere in it. There is
 * no image transform that puts back detail the capture did not record, and
 * this function does not pretend otherwise.
 */
async function preprocessReceiptImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .grayscale()
    .toBuffer();
}

/**
 * Tesseract engine knobs, for the accuracy harness to sweep.
 *
 * Production passes nothing and gets tesseract's defaults. This exists so
 * `tests/ocr-accuracy` can measure a page-segmentation change through the
 * exact same scoring path as everything else, rather than a re-implementation
 * of it that might score differently.
 */
export interface OcrEngineOptions {
  /** tesseract `tessedit_pageseg_mode`, e.g. "4" for a single column. */
  pageSegMode?: string;
  /** tesseract `user_defined_dpi`, for images carrying no DPI metadata. */
  dpi?: string;
}

/** One word tesseract read, with how sure it was of it (0-100). */
export interface OcrWord {
  text: string;
  confidence: number;
}

/** One printed line, with its own confidence and the words that make it up. */
export interface OcrLine {
  text: string;
  confidence: number;
  words: OcrWord[];
}

/**
 * What tesseract actually returned, confidence and all.
 *
 * The plain text is what the parsers work on; the per-line and per-word
 * confidences are what let the confirm screen say WHICH figure it is unsure
 * about instead of a single number for the whole receipt. Tesseract knows
 * that a digit was marginal — until now nothing asked it.
 */
export interface OcrResult {
  text: string;
  /** Mean confidence across the page, 0-100. */
  confidence: number;
  lines: OcrLine[];
}

/**
 * Reads a receipt, keeping the confidence tesseract reports.
 *
 * `blocks: true` is required — tesseract.js omits the block/paragraph/line
 * tree by default and returns only flat text, so the per-word confidences
 * simply are not there unless asked for.
 */
export async function extractReceipt(buffer: Buffer, options: OcrEngineOptions = {}): Promise<OcrResult> {
  let image = buffer;
  try {
    image = await preprocessReceiptImage(buffer);
  } catch (err) {
    logger.error({ err }, "Receipt image preprocessing failed; reading the original image instead");
  }

  const worker = await createWorker(env.TESSERACT_LANG);
  try {
    const params: Record<string, string> = {};
    if (options.pageSegMode) params.tessedit_pageseg_mode = options.pageSegMode;
    if (options.dpi) params.user_defined_dpi = options.dpi;
    if (Object.keys(params).length > 0) await worker.setParameters(params);

    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });

    const lines: OcrLine[] = [];
    // The tree is block -> paragraph -> line -> word. Typed loosely because
    // tesseract.js's own types do not describe the optional block output.
    for (const block of ((data as unknown as { blocks?: unknown[] }).blocks ?? []) as any[]) {
      for (const paragraph of block?.paragraphs ?? []) {
        for (const line of paragraph?.lines ?? []) {
          lines.push({
            text: String(line?.text ?? ""),
            confidence: Number(line?.confidence ?? 0),
            words: (line?.words ?? []).map((w: any) => ({
              text: String(w?.text ?? ""),
              confidence: Number(w?.confidence ?? 0),
            })),
          });
        }
      }
    }

    return { text: data.text, confidence: Number(data.confidence ?? 0), lines };
  } finally {
    await worker.terminate();
  }
}

/**
 * The text only.
 *
 * Kept because the parsers and the whole accuracy corpus are text-in,
 * text-out — that is what makes them fast and deterministic to test.
 */
export async function extractText(buffer: Buffer, options: OcrEngineOptions = {}): Promise<string> {
  /*
   * A preprocessing failure must not cost the owner their scan.
   *
   * sharp throws on anything it cannot decode, and the upload filter admits
   * whatever a browser labelled image/jpeg — which is not a guarantee the
   * bytes are a valid JPEG. Falling back to the original buffer means a file
   * sharp rejects gets exactly the treatment it used to get, rather than
   * turning a readable-but-odd image into a failed upload.
   */
  let image = buffer;
  try {
    image = await preprocessReceiptImage(buffer);
  } catch (err) {
    logger.error({ err }, "Receipt image preprocessing failed; reading the original image instead");
  }

  const worker = await createWorker(env.TESSERACT_LANG);
  try {
    /*
     * DO NOT SET A PAGE SEGMENTATION MODE HERE. It has been measured, and
     * every alternative is worse.
     *
     * tesseract.js does not default to the tesseract CLI's PSM 3 — it
     * defaults to PSM 6 (assume a single uniform block), which happens to be
     * the best setting for receipts in this corpus. Setting PSM explicitly is
     * therefore all downside, and the "obvious" choice is the worst of the
     * lot: PSM 4 ("single column of variable-size text"), which reads like
     * the natural fit for a receipt, drops amount accuracy from 100% to 67%.
     * PSM 3 gives 63%, and the sparse-text modes 11/12 give 73%.
     *
     * Full sweep in tests/ocr-accuracy/OCR-ACCURACY-REPORT.md. A DPI hint is
     * neutral, so it is not set either.
     */
    const params: Record<string, string> = {};
    if (options.pageSegMode) params.tessedit_pageseg_mode = options.pageSegMode;
    if (options.dpi) params.user_defined_dpi = options.dpi;
    if (Object.keys(params).length > 0) await worker.setParameters(params);

    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

export interface ParsedReceiptFields {
  date: string | null; // YYYY-MM-DD
  vendor: string | null;
  description: string | null;
  amount: number | null;
  /**
   * True when the date was a numeric one BOTH of whose components could be
   * the month (05/03/2026) — resolved DD/MM by convention, not by reading.
   * The convention is right for this market and still applied; this flag is
   * what lets the confirm screen say "check the day and month" on exactly
   * the receipts where the convention, not the paper, chose the answer.
   * Always false when `date` is null or was unambiguous.
   */
  dateAmbiguous: boolean;
  /** The visible text the date was read from ("05/03/2026"), or null when no date was found. */
  dateSourceText: string | null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Receipt OCR is inherently noisy — these are best-effort heuristics
// producing a first guess for a human to correct, not a reliable parser.
// See tests/ocr-accuracy/OCR-ACCURACY-REPORT.md for measured accuracy against
// a 20-image corpus, including the failure patterns that shaped the rules
// below.

/**
 * Returns the date only if it is a real calendar date.
 *
 * This guard exists because of a real defect: a DD/MM/YYYY receipt dated after
 * the 12th (e.g. "25/07/2026") was emitted as "2026-25-07" — month 25. That
 * string becomes an Invalid Date, which Prisma rejects with a validation error,
 * so the ENTIRE receipt upload failed with a 500 instead of saving a scan the
 * owner could correct by hand. Never emit a date that cannot exist.
 */
function isoIfValid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check catches e.g. 31 February, which Date silently rolls over.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Lines carrying dates that are NOT the transaction date. Philippine POS
// receipts print several of these (BIR permit issue dates, accreditation
// validity, "valid until"), and they usually appear ABOVE the transaction date
// — so a first-match-wins scan reads the wrong one. Measured: a real receipt
// returned 2024-10-14 from its "PTU Issued" line.
const ADMINISTRATIVE_LINE =
  /\b(ptu|permit|accredit|valid\s+until|valid\s*:|vat\s+reg|tin\s*[:#]|pos\s+sn|serial|min\s*[:#]|date\s+issue[d]?)\b/i;

function transactionLines(text: string): string[] {
  return text.split("\n").filter((line) => !ADMINISTRATIVE_LINE.test(line));
}

/**
 * A date reading plus the honesty metadata about how it was reached.
 *
 * `ambiguous` and `sourceText` exist because "05/03/2026" resolved as 5 March
 * is a CONVENTION applied, not a fact read — and the scan needs to be able to
 * say so (an AMBIGUOUS_DATE warning carrying the visible text) instead of
 * presenting the convention's answer with the same confidence as an ISO date.
 */
interface FoundDate {
  iso: string;
  ambiguous: boolean;
  /** The exact text the date was matched from, for evidence and warnings. */
  sourceText: string;
}

function findDateInText(text: string): FoundDate | null {
  const isoMatch = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const iso = isoIfValid(Number(y), Number(m), Number(d));
    if (iso) return { iso, ambiguous: false, sourceText: isoMatch[0] };
  }

  const monthNameMatch = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i
  );
  if (monthNameMatch) {
    const [, mon, d, y] = monthNameMatch;
    const iso = isoIfValid(Number(y), Number(MONTHS[mon!.toLowerCase()]), Number(d));
    if (iso) return { iso, ambiguous: false, sourceText: monthNameMatch[0] };
  }

  // Numeric slash/dash dates are locale-ambiguous. Resolve by validity first,
  // then by locale:
  //   - second > 12 -> the second component can only be the day, so MM/DD
  //   - first > 12  -> the first can only be the day, so DD/MM
  //   - both <= 12  -> genuinely ambiguous; assume DD/MM, and SAY SO
  //
  // DD/MM is the Philippine convention and this app's target market. The
  // previous MM/DD default was measured getting a real Cebu receipt exactly
  // wrong: "11/07/2026" (11 July) was read as 7 November. The cost of this
  // choice is that a US-format receipt is now misread instead — unavoidable
  // without a locale setting, and the wrong way round for these users. The
  // confirm screen is where the owner corrects either case — which is exactly
  // why the genuinely ambiguous case (both components <= 12 and different) is
  // flagged rather than silently resolved: the answer came from a convention,
  // and the owner deserves to be pointed at it. 05/05/2026 is NOT flagged —
  // both readings agree, so there is nothing to check.
  const slashMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (slashMatch) {
    const [, aRaw, bRaw, yRaw] = slashMatch;
    const a = Number(aRaw);
    const b = Number(bRaw);
    const year = yRaw!.length === 2 ? Number(`20${yRaw}`) : Number(yRaw);
    const iso = b > 12 ? isoIfValid(year, a, b) : isoIfValid(year, b, a);
    if (iso === null) return null;
    return { iso, ambiguous: a <= 12 && b <= 12 && a !== b, sourceText: slashMatch[0] };
  }

  return null;
}

function parseDate(text: string): FoundDate | null {
  // Prefer a date from the receipt's own transaction lines; only fall back to
  // the full text (administrative lines included) if that finds nothing, since
  // a wrong-but-plausible date still beats no date for the owner to correct.
  return findDateInText(transactionLines(text).join("\n")) ?? findDateInText(text);
}

function parseAmount(text: string): number | null {
  const lines = text.split("\n");
  // \d{1,3} on its own before the optional comma groups would truncate a
  // plain 4+ digit total with no thousands separator (e.g. "1220.00"
  // matched as "220.00") — confirmed against a real test receipt. \d+
  // greedily consumes the whole integer part first.
  const moneyPattern = /(\d+(?:,\d{3})*\.\d{2})/;

  const totalLine = lines.find((line) => /\btotal\b/i.test(line) && !/subtotal/i.test(line));
  if (totalLine) {
    const match = totalLine.match(moneyPattern);
    if (match) return Number(match[1]!.replace(/,/g, ""));
  }

  // Fall back to the largest decimal-looking number anywhere in the
  // receipt — usually the total is the biggest line-item-shaped number.
  const allMatches = [...text.matchAll(new RegExp(moneyPattern, "g"))].map((m) => Number(m[1]!.replace(/,/g, "")));
  if (allMatches.length > 0) {
    return Math.max(...allMatches);
  }

  return null;
}

// Generic document furniture that is never the store's name.
const NOT_A_VENDOR =
  /^[\W_]*(sales\s+invoice|official\s+receipt|invoice|receipt|cash\s+invoice|statement|order\s+slip)[\W_]*$/i;

// Decorative banner punctuation ("*** SALES INVOICE ***", "=== STORE COPY ===",
// "~~~ Thank you ~~~"). These characters never appear in a printed business
// name, so a line carrying one is document furniture regardless of what the
// letters inside it say — which matters because OCR frequently mangles the
// header text itself: "*** SALES INVOICE ***" was read as "*xx GALES INVOICE
// ***" on a real corpus image, and the garbled spelling slipped past
// NOT_A_VENDOR's exact-phrase match while the asterisks were still intact.
// Catching the decoration instead of the (unreliable) wording is what let the
// genuine footer vendor name on that same receipt win instead.
const DECORATIVE_BANNER = /[*~]|={2,}/;

/**
 * Closing/farewell boilerplate a receipt prints below the last item — never
 * the store's name, but ordinary prose that would otherwise pass every other
 * filter (real letters, multiple words, no digits).
 */
const CLOSING_LINE = /\b(thank\s*you|come\s+again|please\s+come\s+back|salamat|maraming\s+salamat)\b/i;

/**
 * Words that mark a line as a business name rather than an address or a
 * scrap of OCR noise. Deliberately Philippine-retail flavoured, because that
 * is the market — a "sari-sari store" or a "marketing corporation" is a shop,
 * a line reading "Dore" is almost certainly a mangled logo. "Tindahan" is the
 * Filipino word for "store" and appears as often as the English word on
 * small-shop receipts.
 */
const VENDOR_KEYWORD =
  /\b(store|shop|mart|market|supermarket|grocery|groceries|trading|enterprise|enterprises|corporation|corp|incorporated|inc|company|co|merchandise|merchandising|pharmacy|bakery|hardware|sari-?sari|tindahan|foods?|restaurant|cafe|coffee|eatery|carinderia|depot|supply|supplies|center|centre)\b/i;

/**
 * Best guess at the store name.
 *
 * SCORED, not first-past-the-post. It used to take the first substantive line,
 * which is wrong whenever OCR makes something out of the logo above the name —
 * a real Savemore receipt produced a 4-letter smudge, "Dore", from the
 * stylised wordmark, and that beat "SAVEMORE MARKET BASAK" three lines below
 * purely by being first.
 *
 * So candidates are ranked instead. A business-name keyword is worth more than
 * position, length beats brevity (a smudge is short, a shop name is not), and
 * a line that is mostly digits or reads like an address loses. Position still
 * counts — the name really is usually near the top — but it no longer decides
 * on its own.
 *
 * A store name printed only in the FOOTER is no longer disqualified by
 * position alone (see the scoring notes below) — a footer name with a
 * recognisable business-type word, or one left as the only real candidate
 * once decorative banners and closing boilerplate are excluded, wins. This
 * is not a promise the footer always wins: two equally plausible bare names,
 * one top and one bottom, still resolve toward the top. The confirm screen
 * is where the owner fixes whichever draft is wrong.
 */
function parseVendor(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim());

  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.length > 1 && /[a-zA-Z]/.test(line))
    // Skip registration/permit blocks, which many PH receipts print above the
    // store name, and skip bare "SALES INVOICE"-style headers.
    .filter(({ line }) => !ADMINISTRATIVE_LINE.test(line))
    .filter(({ line }) => !NOT_A_VENDOR.test(line.replace(/[*=~-]/g, " ").trim()))
    // Decorative banners are document furniture even when OCR has mangled
    // the wording inside them (see DECORATIVE_BANNER above), and a "thank
    // you, come again" footer line is never the store's name either.
    .filter(({ line }) => !DECORATIVE_BANNER.test(line))
    .filter(({ line }) => !CLOSING_LINE.test(line))
    // A line that is mostly digits/punctuation is a reference number, not a name.
    .filter(({ line }) => {
      const letters = (line.match(/[a-zA-Z]/g) ?? []).length;
      return letters >= 3 && letters / line.replace(/\s/g, "").length > 0.4;
    });

  if (candidates.length === 0) {
    return lines.find((l) => l.length > 1 && /[a-zA-Z]/.test(l)) ?? null;
  }

  const score = ({ line, index }: { line: string; index: number }): number => {
    let points = 0;

    // The strongest signal available: the line says what kind of business it is.
    if (VENDOR_KEYWORD.test(line)) points += 60;

    // Near the top still matters, it just no longer decides alone. Only the
    // first handful of lines get anything, and the bonus decays.
    if (index < 8) points += (8 - index) * 3;

    /*
     * Length, capped. A wordmark tesseract half-read comes out as a short
     * fragment ("Dore"); a real shop name is longer. Capped so a rambling
     * address line cannot win on sheer size alone.
     */
    const letters = (line.match(/[a-zA-Z]/g) ?? []).length;
    points += Math.min(letters, 24);

    // Two or more words reads like a name; one short token reads like noise.
    const words = line.split(/\s+/).filter((w) => w.length > 1);
    if (words.length >= 2) points += 8;
    if (letters <= 5) points -= 25;

    /*
     * A line ending in a money amount is a PURCHASE, not a shop name. This is
     * the strongest disqualifier available and it is worth more than any of
     * the bonuses above — without it "Cleaning supplies 675.00" outscores the
     * real vendor purely because "supplies" is a business word.
     */
    if (/\d+[.,]\d{2}\s*[A-Z]?\s*$/.test(line)) points -= 80;

    /*
     * An address sits right beside the name and must not be mistaken for it —
     * but ONLY when the line does not already look like a business. Measured:
     * "BARANGAY SUPPLY DEPOT" is a shop whose name happens to start with a
     * word that also appears in addresses, and penalising it flatly cost a
     * vendor the corpus had been reading correctly.
     */
    if (
      !VENDOR_KEYWORD.test(line) &&
      /\b(st|street|ave|avenue|rd|road|blk|block|brgy|barangay|city|purok|zone|highway|bldg|building)\b/i.test(line)
    ) {
      points -= 30;
    }
    // Digits belong to addresses and reference numbers far more than to names.
    points -= (line.match(/\d/g) ?? []).length * 2;

    return points;
  };

  return candidates.reduce((best, c) => (score(c) > score(best) ? c : best)).line;
}

// ============================================================
// Line items — the individual things bought
// ============================================================
// Harder than date/vendor/amount, and honestly so. Those three are anchored:
// a date has a recognisable shape, a total sits next to the word TOTAL, a
// vendor is the first substantive line. An item line has no keyword to hang
// off — it is "some words, then some numbers" — and the layout varies by
// register: name and price only, name with a quantity column, a "2 x 25.00"
// prefix, a weight, a discount line indented underneath.
//
// So the rules below are conservative by design: anything that does not look
// unambiguously like a purchased line is dropped rather than guessed at. A
// missed item costs the owner one manual row; a fabricated item silently puts
// a number in their books that was never on the receipt. See the item-level
// figures in tests/ocr-accuracy/OCR-ACCURACY-REPORT.md for what that costs in
// recall.

export interface ParsedLineItem {
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
}

/**
 * Lines that carry money but are not purchases.
 *
 * Getting this wrong is the expensive direction: admitting the TOTAL line as
 * an item would double the receipt, and admitting CHANGE would invent an
 * expense that is really money coming back.
 */
/**
 * `[VY]AT` rather than `VAT`, and similar loosenings throughout.
 *
 * Real receipts defeat exact-word denylists, because the word has already been
 * through OCR by the time this sees it. A Savemore Market receipt produced
 * "YAT Amount" for "VAT Amount" — V read as Y — and an exact `\bvat\b` let a
 * PHP 39.43 tax line through as a purchased item. Tolerating the handful of
 * confusions Tesseract actually makes on these specific words costs nothing:
 * no real product is called "YAT Amount".
 */
const NOT_AN_ITEM = new RegExp(
  [
    // Summary and total lines.
    String.raw`\b(sub\s*-?\s*total|total|amt|amount\s+due|amount\s+payable|balance)\b`,
    // Tax lines. [VY] for the V->Y misread; the trailing part covers
    // "VATable Sales", "VAT-Exempt Sales", "Zero-Rated Sales".
    String.raw`\b[vy]at(able)?\b`,
    String.raw`\b(tax|zero\s*-?\s*rated|vat\s*-?\s*exempt|exempt|non\s*-?\s*taxable)\b`,
    // Discounts and adjustments.
    //
    // The plurals are not decoration. A real receipt prints "Prod. Discounts:
    // 5.00", and `\bdiscount\b` does not match "Discounts" — the trailing \b
    // needs a non-word character and hits the "s". That single missing letter
    // admitted a 5.00 DISCOUNT as a 5.00 PURCHASE, which is the exact failure
    // this denylist exists to prevent: money coming off the receipt recorded
    // as money spent. Found on real-03 in the corpus, not hypothesised.
    String.raw`\b(discounts?|disc\.|less|senior|pwd|rebates?|voids?|refunds?)\b`,
    // Payment-method and authorisation lines. These carry the receipt's own
    // total, so admitting one doubles the receipt — "BDO ATM 371.00" was
    // extracted as a PHP 371 purchase on the Savemore receipt.
    String.raw`\b(cash|change|tender|tendered|payment|paid|card|credit|debit|atm|charge|gcash|g-cash|maya|paymaya|grabpay|e-?wallet|bank|bdo|bpi|metrobank|unionbank|landbank|security\s*bank|rcbc|chinabank|visa|mastercard|amex)\b`,
    String.raw`\b(auth\s*-?\s*code|authcode|approval|approved|trace|batch|terminal|merchant|acct|account\s*(no|#)|order\s*id|ref(erence)?\s*(no|#)?)\b`,
    // Document furniture and register metadata. `bagger` is the packer's
    // name, printed on Philippine supermarket receipts right above the
    // total; `trans#` and `si#` are the transaction and sales-invoice
    // numbers. All three require the # so a two-letter token like "si"
    // cannot swallow a product name.
    String.raw`\b(invoice|receipt|thank|permit|tin|serial|pos\s+sn|min|date|time|cashier|customer|order|transaction|qty\s+item|item\s+qty|price|description|bagger)\b`,
    String.raw`\b(trans|si)\s*#`,
  ].join("|"),
  "i",
);

/**
 * A trailing money amount — the line's own total, at the right-hand edge.
 *
 * The optional trailing letter is a VAT classification flag, which Philippine
 * BIR-accredited registers print hard against the amount: "129.00V" (VATable),
 * "0.00Z" (zero-rated), "E" (exempt), "X" (non-taxable). Without it this
 * pattern misses every item line on a compliant PH receipt — found on
 * real-01-ph-pos-photo in the corpus, not hypothesised.
 */
const TRAILING_AMOUNT = /(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s*[VZEX]?\s*$/i;

/** A leading "2 x " / "2x" / "2 @ " quantity prefix. */
const LEADING_QUANTITY = /^\s*(\d+(?:\.\d+)?)\s*(?:x|@|pcs?|pc)\s+/i;

/**
 * A leading bare quantity column: "1 Americano". Common on US-style
 * registers that print QTY / DESC / AMT columns (real-02 in the corpus).
 *
 * Bounded to 3 digits deliberately, and that bound is what does the work:
 * "2026 Calendar 50.00" cannot match, because \d{1,3} can only take "202"
 * and the required whitespace then hits "6". A year at the start of a
 * product name is far more likely than a purchase of two thousand of
 * something. The bound also has to be the ONLY guard — requiring a
 * non-digit after it would drop "1 16oz Bottle Water", a real line from
 * real-02 in the corpus.
 */
const LEADING_BARE_QUANTITY = /^\s*(\d{1,3})\s+/;

/** A trailing "... 2 25.00 50.00" quantity + unit price + amount tail. */
const QTY_UNIT_AMOUNT_TAIL =
  /^(.*?)\s+(\d+(?:\.\d+)?)\s+(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s+(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s*$/;

function money(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * A single decimal figure, tolerating OCR's comma-for-point.
 *
 * Distinct from `money` deliberately: there the comma is a thousands
 * separator and gets deleted, here it is the decimal point and gets
 * converted. Only ever called on a `\d+[.,]\d{2}` match, so there is exactly
 * one separator and no ambiguity between the two readings.
 */
function decimal(raw: string): number {
  return Number(raw.replace(",", "."));
}

/**
 * An inline unit price, printed between the item's name and the line total:
 * "3 Sprite Can 320ml @34.50   103.50".
 *
 * `[@8]` because Tesseract reads the @ as an 8 on thermal print — the real
 * Savemore line "5 Sey @22.95  114.75" came out of OCR as "5 Sey 822,95
 * 114.75", leaving "Sey 822,95" as the stored item name. Admitting the 8
 * form is only safe because of the multiply-out check at the call site: a
 * digit that is really the tail of a product code cannot pass it.
 */
const INLINE_UNIT_PRICE = /\s*([@8])\s*(\d+[.,]\d{2})\s*$/;

/**
 * Strips leading bullets/codes and collapses OCR's irregular spacing.
 *
 * The bracket substitution is cosmetic and can never move a number: it runs
 * on the name only, after the amount has already been taken off the line.
 * Tesseract reads a lowercase `l` as `]` on thermal print, which is why the
 * real receipt produced "FemmeTsu2P]y250" and "Sprite Can 320m]". Restoring
 * the letter inside a word is a better guess than dropping it, and a bracket
 * that is NOT inside a word is just noise, so it goes.
 */
function cleanItemName(raw: string): string {
  return raw
    .replace(/^[\s*·•\-–—|#]+/, "")
    .replace(/(?<=[A-Za-z0-9])\]/g, "l")
    .replace(/[[\]]/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

/**
 * Reads the purchased lines off a receipt.
 *
 * Returns an empty array when the receipt has no parseable item lines at all
 * — a handwritten slip, or one that prints only a total. That is a real and
 * common case, and the caller falls back to the single-total flow rather than
 * inventing lines that were never legible.
 */
export function parseLineItems(text: string): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];
  // The receipt's own total, used by the structural guard at the bottom.
  const receiptTotal = parseAmount(text);

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/₱|PHP|Php|\$/g, " ").trimEnd();
    if (!line.trim()) continue;
    // Administrative furniture and summary lines are never purchases.
    if (ADMINISTRATIVE_LINE.test(line) || NOT_AN_ITEM.test(line)) continue;

    // Shape A: "Name   2   25.00   50.00" — quantity and unit price columns.
    const columns = line.match(QTY_UNIT_AMOUNT_TAIL);
    if (columns) {
      const name = cleanItemName(columns[1]!);
      const quantity = Number(columns[2]);
      const unitPrice = money(columns[3]!);
      const amount = money(columns[4]!);
      // Only trust the columns when they actually multiply out; otherwise
      // this is three unrelated numbers that happen to sit in a row.
      if (name.length >= 2 && Math.abs(quantity * unitPrice - amount) < 0.02) {
        items.push({ name, quantity, unitPrice, amount });
        continue;
      }
    }

    // Shape B: "Name  50.00", optionally prefixed "2 x Name  50.00".
    const trailing = line.match(TRAILING_AMOUNT);
    if (!trailing) continue;
    const amount = money(trailing[1]!);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    let remainder = line.slice(0, line.length - trailing[0].length);
    let quantity: number | null = null;
    const qtyPrefix = remainder.match(LEADING_QUANTITY);
    if (qtyPrefix) {
      quantity = Number(qtyPrefix[1]);
      remainder = remainder.slice(qtyPrefix[0].length);
    } else {
      const bareQty = remainder.match(LEADING_BARE_QUANTITY);
      if (bareQty) {
        quantity = Number(bareQty[1]);
        remainder = remainder.slice(bareQty[0].length);
      }
    }

    /*
     * An inline "@34.50" unit price, when the register printed one.
     *
     * Trusted OVER the quantity column, and only when it multiplies out
     * against the line's own total — the same discipline Shape A applies to
     * its three columns. That check is what makes this a correction rather
     * than a second guess: on the real receipt, "8 fi Eogacre 130 @33.50
     * 100.50" was stored as 8 units at 12.56, because the leading 8 is a
     * misread and the true line is 3 at 33.50. The printed unit price is
     * the only thing on that line that can prove it, since 100.50 / 33.50
     * is exactly 3 and 8 x 33.50 is nowhere near the total.
     *
     * When the figures do NOT multiply out, the quantity column stands and
     * only a literal @ is stripped from the name — an 8 that failed the
     * check is more likely part of the product than a mangled @.
     */
    let unitPrice: number | null = null;
    const inline = remainder.match(INLINE_UNIT_PRICE);
    if (inline) {
      const candidate = decimal(inline[2]!);
      const impliedQuantity = candidate > 0 ? amount / candidate : 0;
      const rounded = Math.round(impliedQuantity);
      if (rounded >= 1 && Math.abs(impliedQuantity - rounded) < 0.005) {
        unitPrice = candidate;
        quantity = rounded;
        remainder = remainder.slice(0, remainder.length - inline[0].length);
      } else if (inline[1] === "@") {
        remainder = remainder.slice(0, remainder.length - inline[0].length);
      }
    }

    const name = cleanItemName(remainder);
    // A line that is all numbers has no name, so it is a column of figures
    // rather than a purchase. Two characters of letters is the floor.
    if ((name.match(/[a-zA-Z]/g) ?? []).length < 2) continue;

    items.push({
      name,
      quantity,
      unitPrice: unitPrice ?? (quantity && quantity > 0 ? Math.round((amount / quantity) * 100) / 100 : null),
      amount,
    });
  }

  /*
   * The structural guard, which no amount of OCR corruption can defeat.
   *
   * A payment line carries the receipt's total by definition — "BDO ATM
   * 371.00" on a receipt totalling 371.00. So on a receipt with several
   * items, a candidate whose amount EQUALS the total is a payment or summary
   * line however its name came out of OCR, and admitting it would roughly
   * double the receipt.
   *
   * Guarded by `length > 1`, because on a genuine one-item receipt the item
   * legitimately equals the total and must be kept.
   */
  if (receiptTotal !== null && items.length > 1) {
    const filtered = items.filter((i) => Math.abs(i.amount - receiptTotal) >= 0.005);
    // Only apply it if something survives — a receipt whose every line equals
    // the total is not something this rule can reason about.
    if (filtered.length > 0) return filtered;
  }

  return items;
}

/**
 * Marks the start of a receipt, for counting how many are in one photograph.
 *
 * WHY THIS MARKER AND NOT A BETTER-SOUNDING ONE. The obvious candidates were
 * measured against the 31-image corpus (tests/ocr-accuracy/results.json), and
 * the obvious ones lose:
 *
 *   "SALES INVOICE" / "OFFICIAL RECEIPT"   1 of 31 receipts carry it
 *   a TIN / VAT-REG number                 3 of 31
 *   "Thank you"                            1 of 31
 *   a DATE: label                         28 of 31   <-- this one
 *
 * Counting the word TOTAL, which is the first thing anyone reaches for, is
 * actively wrong: a single real receipt in the corpus prints "Total gross
 * value", "Total QTY" AND "AMOUNT DUE", so it would report two receipts on
 * nearly every photograph. That is the cry-wolf failure reconcileItems is
 * written to avoid, and it is worse than not checking.
 *
 * Measured on the corpus: fires on 0 of 31 single receipts (no receipt carries
 * two date labels), and catches 81% of artificial two-receipt pairs. The
 * misses are all pairs built from the three receipts that print no date label
 * at all — a limit of the marker, not a tuning problem.
 */
const RECEIPT_START_MARKER = /\bdate\s*[:.]/gi;

/**
 * Whether one photograph appears to hold more than one receipt.
 *
 * Deliberately one-directional: false means "no evidence of a second
 * receipt", NOT "definitely one receipt". Two receipts photographed together
 * where neither prints a date label read past this undetected, and the items
 * failing to reconcile is what catches them instead.
 *
 * Nothing acts on this but a sentence on the confirm screen. Splitting the
 * photograph automatically would mean deciding which items belong to which
 * receipt, and a wrong split puts money against the wrong purchase — the
 * owner can see two receipts in their own hand far more reliably than this
 * can infer it.
 */
export function looksLikeMultipleReceipts(text: string | null | undefined): boolean {
  if (!text) return false;
  return (text.match(RECEIPT_START_MARKER) ?? []).length >= 2;
}

/**
 * How much of the shorter page's lines must reappear in the other to call it
 * a duplicate.
 *
 * A majority rather than a supermajority, deliberately: on a short receipt —
 * common in this market — a four-line page with one line OCR reads
 * differently already falls to a 0.75 overlap, so 0.8 would miss the exact
 * case this exists to catch. 0.6 still requires most of the page to agree,
 * which two genuinely different pages sharing only a header or a footer line
 * will not reach.
 */
const DUPLICATE_PAGE_OVERLAP = 0.6;

/**
 * Whether two photographed pages of a multi-page scan look like the same
 * page, shot twice — the owner's shutter finger firing early, or a retake
 * that was kept alongside the original by mistake.
 *
 * UNMEASURED, unlike looksLikeMultipleReceipts. That check had a 31-receipt
 * corpus of real photographs to test candidate markers against; there is no
 * equivalent corpus of "the same page photographed twice" pairs, because
 * nobody has one — it is not a thing anyone photographs on purpose to build
 * a test set from. So this is a considered threshold, not a validated one,
 * and the honest thing is to say so rather than borrow the confidence the
 * measurement above earned.
 *
 * A ratio rather than exact equality, because two photographs of the
 * identical physical page will not produce byte-identical OCR text — a
 * slightly different angle or a fold moves a handful of characters — and a
 * check that only caught perfect matches would miss the real case it exists
 * for. Compared as whole trimmed lines rather than characters: OCR noise
 * scrambles individual characters far more than it drops or repeats whole
 * lines, so the line is the more stable unit to compare on.
 *
 * Deliberately not folded into the upload pipeline's automatic decisions —
 * it only ever produces a sentence the owner can dismiss with one tap. Two
 * genuinely identical pages of a short receipt (a two-line kiosk slip
 * photographed as pages 1 and 2 by mistake) would otherwise have its real
 * page silently dropped by anything more automatic than a question.
 */
export function looksLikeDuplicatePage(pageA: string, pageB: string): boolean {
  const significantLines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0);

  const a = significantLines(pageA);
  const b = significantLines(pageB);
  if (a.length === 0 || b.length === 0) return false;

  const bLines = new Set(b);
  const shared = a.filter((line) => bLines.has(line)).length;
  return shared / Math.min(a.length, b.length) >= DUPLICATE_PAGE_OVERLAP;
}

// ============================================================
// Seams — where one photographed section runs into the next
// ============================================================
// The camera asks for 15-25% overlap between sections of a long receipt, so
// the owner can see where to continue (mobile ReceiptGuide). That overlap is
// what makes the sections obviously parts of ONE receipt — and it is also the
// only way a few item lines can get read twice, because pages are OCR'd
// separately and their text concatenated in order.
//
// WHAT THIS DELIBERATELY IS NOT. An earlier draft of the plan scored every
// line of page n against every line of page n+1, normalised currency symbols
// and punctuation, and dropped whatever passed a similarity threshold. That
// is a preference-based heuristic deciding which money lines survive, and
// this codebase already fixed the opposite rule for exactly this situation at
// rescueWithVision: a competing reading replaces the deterministic one "only
// on an OBJECTIVE test, never a preference". The objective test available
// here is the receipt's own printed total — see receiptScan.service.

/**
 * The most lines at a seam that will be considered overlap.
 *
 * The camera asks for a quarter of a frame; a quarter of a photographed
 * section is rarely more than a dozen printed lines. A cap matters because
 * without one the longest common run between two pages of a restock receipt —
 * where the same supplier's items repeat legitimately — could swallow a whole
 * page of genuine purchases.
 */
const MAX_SEAM_LINES = 12;

/** How much of a line must survive normalisation for it to be worth comparing. */
const MIN_SEAM_LINE_LENGTH = 3;

/**
 * Comparable form for seam matching.
 *
 * Whole lines, lower-cased, with runs of whitespace collapsed — and nothing
 * else. The temptation is to strip currency symbols and punctuation too, on
 * the grounds that OCR renders them inconsistently; the reason not to is that
 * those characters are most of what distinguishes one money line from
 * another, and a normaliser aggressive enough to match "P 45.00" with
 * "₱45,00" is also aggressive enough to match two genuinely different lines.
 * Being conservative here means missing some overlap, which costs a
 * reconciliation warning the owner can see. Being aggressive means deleting a
 * purchase, which costs money nobody notices.
 */
function seamKey(line: string): string {
  return line.trim().toLowerCase().replace(/\s+/g, " ");
}

function seamLines(text: string): string[] {
  return text
    .split("\n")
    .map(seamKey)
    .filter((line) => line.length >= MIN_SEAM_LINE_LENGTH);
}

export interface PageSeam {
  /** 1-indexed page whose TOP repeats the previous page's bottom. */
  pageNumber: number;
  /** How many lines repeat. */
  lineCount: number;
}

/**
 * The longest run of lines that ends page A and begins page B.
 *
 * An ANCHORED match — the run must be A's tail and B's head — not a search
 * for shared lines anywhere in either page. That distinction is the whole
 * safety property: a restock receipt legitimately repeats "san miguel pale
 * pilsen 1 case" on pages 1 and 3, and an unanchored search would find it and
 * call it overlap. Only a tail-to-head repeat is evidence that the camera
 * photographed the same strip of paper twice, because that is the only shape
 * the overlap guide can produce.
 *
 * Longest-first so a genuine 6-line overlap is not reported as a 1-line one
 * because the shorter run also matched.
 */
export function seamOverlapLength(pageA: string, pageB: string): number {
  const a = seamLines(pageA);
  const b = seamLines(pageB);
  const limit = Math.min(MAX_SEAM_LINES, a.length, b.length);

  for (let run = limit; run >= 1; run--) {
    let matches = true;
    for (let i = 0; i < run; i++) {
      if (a[a.length - run + i] !== b[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return run;
  }
  return 0;
}

/** Every seam in a scan, adjacent pages only. */
export function findPageSeams(pageTexts: string[]): PageSeam[] {
  const seams: PageSeam[] = [];
  for (let i = 1; i < pageTexts.length; i++) {
    const lineCount = seamOverlapLength(pageTexts[i - 1] ?? "", pageTexts[i] ?? "");
    if (lineCount > 0) seams.push({ pageNumber: i + 1, lineCount });
  }
  return seams;
}

/**
 * The pages' text joined with each seam's repeat removed from the later page.
 *
 * A CANDIDATE READING, not a decision. Nothing calls this and uses the result
 * unconditionally — receiptScan.service builds both this and the plain
 * concatenation, then keeps this one only when the arithmetic says it is
 * right. See `overlapSettlesTheGap` there.
 */
export function joinPagesWithoutSeams(pageTexts: string[]): string {
  if (pageTexts.length <= 1) return pageTexts.join("\n");

  const parts: string[] = [pageTexts[0] ?? ""];
  for (let i = 1; i < pageTexts.length; i++) {
    const page = pageTexts[i] ?? "";
    const overlap = seamOverlapLength(pageTexts[i - 1] ?? "", page);
    if (overlap === 0) {
      parts.push(page);
      continue;
    }

    /*
     * Dropped by counting SIGNIFICANT lines, then cutting the raw text at
     * that point — rather than by filtering the raw lines directly. The two
     * differ whenever OCR emits a blank or a one-character line inside the
     * overlap, and cutting at the wrong index there would take a line of real
     * purchases with it.
     */
    const rawLines = page.split("\n");
    let significantSeen = 0;
    let cutAt = 0;
    for (let index = 0; index < rawLines.length; index++) {
      if (seamKey(rawLines[index] ?? "").length >= MIN_SEAM_LINE_LENGTH) {
        significantSeen++;
        if (significantSeen === overlap) {
          cutAt = index + 1;
          break;
        }
      }
    }
    parts.push(rawLines.slice(cutAt).join("\n"));
  }
  return parts.join("\n");
}

export function parseReceiptFields(text: string): ParsedReceiptFields {
  const vendor = parseVendor(text);
  const date = parseDate(text);
  return {
    date: date?.iso ?? null,
    vendor,
    description: vendor ? `Purchase from ${vendor}` : "Receipt purchase",
    amount: parseAmount(text),
    dateAmbiguous: date?.ambiguous ?? false,
    dateSourceText: date?.sourceText ?? null,
  };
}

// ============================================================
// Confidence — how sure tesseract was, per field
// ============================================================
// A single number for the whole receipt is nearly useless: a page that reads
// 62% overall may have a perfectly crisp total and one mangled item name, and
// the owner needs to know WHICH. These map a parsed value back to the words it
// came from, so the confirm screen can point at the doubtful figure.

/** Comparable form: case and separators removed, so "1,220.00" matches "1220.00". */
function normaliseToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]/g, "");
}

/**
 * How sure tesseract was about a value it read.
 *
 * Returns the confidence of the WORD carrying the value where one can be
 * found, falling back to the line's own confidence, and null when the value
 * cannot be located at all — which happens when the parser derived it rather
 * than reading it (a computed unit price, say). Null means "not measured",
 * never "zero", and the UI must show those differently.
 */
export function confidenceForValue(lines: OcrLine[], value: string | number | null): number | null {
  if (value === null || value === "") return null;
  const target = normaliseToken(String(value));
  if (!target) return null;

  let best: number | null = null;

  for (const line of lines) {
    for (const word of line.words) {
      const w = normaliseToken(word.text);
      // An exact word wins outright — that is the token the value came from.
      if (w === target) return Math.round(word.confidence);
      if (target.length >= 3 && w.includes(target)) {
        best = Math.max(best ?? 0, Math.round(word.confidence));
      }
    }
    if (best === null && target.length >= 3 && normaliseToken(line.text).includes(target)) {
      best = Math.round(line.confidence);
    }
  }

  return best;
}

/**
 * The overall figure, as a percentage the owner can read.
 *
 * The mean tesseract itself reports, deliberately — inventing a friendlier
 * scale on top would be presenting a guess about a guess.
 */
export function overallConfidence(result: OcrResult): number {
  return Math.round(result.confidence);
}

// ============================================================
// Evidence — WHERE a parsed value came from
// ============================================================
// confidenceForValue answers "how sure was the engine about this value";
// these answer the companion question the review screen could never answer
// before: WHICH PAGE and WHICH PRINTED LINE the value was read from. The
// defect this fixes: the write path re-derived value locations to score
// confidence and then threw the location away, so "read from page 2:
// 'TOTAL 1,220.00'" was computed and discarded on every scan.

/** Where a value was found. pageNumber is 1-indexed; null means "only locatable in the concatenated document". */
export interface ValueEvidence {
  pageNumber: number | null;
  sourceText: string;
}

/**
 * Finds the printed line a parsed value came from, page by page.
 *
 * Same normalised-containment matching as confidenceForValue, so the line
 * this points at is the same line the confidence describes. Returns null
 * when the value cannot be located — a value the parser DERIVED rather than
 * read has no line to point at, and inventing one would be evidence-shaped
 * fiction. The >= 3 length floor mirrors confidenceForValue's: a one- or
 * two-character target matches half the receipt and proves nothing.
 */
export function locateValue(pageTexts: string[], value: string | number | null): ValueEvidence | null {
  if (value === null || value === "") return null;
  const target = normaliseToken(String(value));
  if (target.length < 3) return null;

  for (let page = 0; page < pageTexts.length; page++) {
    for (const line of (pageTexts[page] ?? "").split("\n")) {
      if (normaliseToken(line).includes(target)) {
        return { pageNumber: page + 1, sourceText: line.trim() };
      }
    }
  }

  // A value only locatable in the concatenated document (it straddled a page
  // boundary, or the caller passed a single combined text) keeps its source
  // text but honestly reports no page.
  for (const line of pageTexts.join("\n").split("\n")) {
    if (normaliseToken(line).includes(target)) {
      return { pageNumber: null, sourceText: line.trim() };
    }
  }
  return null;
}

/**
 * Evidence for each parsed line item, located by its AMOUNT.
 *
 * The amount rather than the name, because the stored name has been through
 * cleanItemName (brackets restored to letters, bullets stripped) and often no
 * longer matches the raw line character-for-character — the amount survives
 * verbatim. Two guards keep the pointing honest:
 *
 *   - lines the item parser itself would never admit (totals, VAT, payment
 *     lines) are excluded, so an item costing exactly the receipt total is
 *     not "evidenced" by the TOTAL line; and
 *   - each line is consumed once, so two items at the same price cannot both
 *     claim the same printed line — the same discipline repairItemNames
 *     applies when matching vision names by amount.
 *
 * Null per item where no line qualifies. Never invented.
 */
export function locateItemLines(pageTexts: string[], amounts: number[]): (ValueEvidence | null)[] {
  const candidates: { pageNumber: number; sourceText: string; normalised: string; used: boolean }[] = [];
  for (let page = 0; page < pageTexts.length; page++) {
    for (const line of (pageTexts[page] ?? "").split("\n")) {
      if (!line.trim()) continue;
      if (ADMINISTRATIVE_LINE.test(line) || NOT_AN_ITEM.test(line)) continue;
      candidates.push({ pageNumber: page + 1, sourceText: line.trim(), normalised: normaliseToken(line), used: false });
    }
  }

  return amounts.map((amount) => {
    const target = normaliseToken(amount.toFixed(2));
    const hit = candidates.find((c) => !c.used && c.normalised.includes(target));
    if (!hit) return null;
    hit.used = true;
    return { pageNumber: hit.pageNumber, sourceText: hit.sourceText };
  });
}

// ============================================================
// Reconciliation — do the items account for the total?
// ============================================================

/** Why a receipt did or didn't add up. */
export type ReconciliationReason =
  | "not-comparable"
  | "exact"
  | "matches-subtotal"
  | "explained-by-adjustment"
  | "unexplained";

export interface Reconciliation {
  /** Sum of the item amounts, or null when there are none. */
  itemsTotal: number | null;
  /** The receipt's printed total, as parsed. */
  total: number | null;
  /** total - itemsTotal. Positive means the items fall short. */
  difference: number | null;
  /**
   * True when the items account for the total — either exactly, or with a
   * gap the receipt itself explains. False ONLY for an unexplained gap.
   */
  reconciled: boolean;
  reason: ReconciliationReason;
}

/**
 * Money that legitimately sits between the items and the total.
 *
 * Kept separate from NOT_AN_ITEM, which is a broader denylist covering payment
 * lines and register furniture too. This is specifically the subset that
 * ADJUSTS the bill, and using the wider list here would let a "CASH 500.00"
 * tender line excuse a real 500.00 misread.
 */
const ADJUSTMENT_LINE = new RegExp(
  [
    String.raw`\b[vy]at\b`,
    String.raw`\b(tax|service\s*charge|svc\s*chg|rounding|round\s*off)\b`,
    String.raw`\b(discounts?|disc\.|less|senior|pwd|rebates?)\b`,
  ].join("|"),
  "i",
);

const SUBTOTAL_LINE = /\bsub\s*-?\s*total\b/i;
const RECONCILE_MONEY = /(\d+(?:,\d{3})*\.\d{2})/;

function moneyOnLine(line: string): number | null {
  const m = line.match(RECONCILE_MONEY);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

/** Centavos, so comparisons are integer-exact rather than float-approximate. */
function centavos(n: number): number {
  return Math.round(n * 100);
}

/**
 * Whether the item lines add up to the printed total.
 *
 * WHY THIS IS NOT JUST `sum === total`: measured against the corpus, a naive
 * equality check called 6 receipts broken and was RIGHT about 1. The other 5
 * were fine and simply carried tax or a discount — `1000.00` of goods against
 * a `1120.00` total is the Philippine 12% VAT, not a misread. A check that
 * cries wolf 5 times out of 6 trains owners to ignore it, which is worse than
 * not checking at all.
 *
 * So a gap is only reported when the receipt does not explain it:
 *
 *   - the items match a printed SUBTOTAL — whatever sits between that and the
 *     total is tax and charges, and the items themselves are sound; or
 *   - the gap equals an adjustment the receipt prints (a VAT line, a senior
 *     discount), individually or summed.
 *
 * What remains is a gap no line on the receipt accounts for, which is real
 * evidence that a figure was read wrong. That evidence is what earns the right
 * to spend an API call re-reading the image, and to point the owner at a line.
 */
export function reconcileItems(
  text: string,
  items: { amount: number }[],
  total: number | null,
): Reconciliation {
  if (total === null || items.length === 0) {
    return { itemsTotal: null, total, difference: null, reconciled: true, reason: "not-comparable" };
  }

  const itemsTotal = items.reduce((sum, i) => sum + centavos(i.amount), 0);
  const totalC = centavos(total);
  const difference = (totalC - itemsTotal) / 100;
  const base = { itemsTotal: itemsTotal / 100, total, difference };

  if (itemsTotal === totalC) return { ...base, reconciled: true, reason: "exact" };

  const lines = text.split("\n");

  // A printed subtotal the items match settles it: the items are right, and
  // the remainder is the receipt's own tax and charges.
  for (const line of lines) {
    if (!SUBTOTAL_LINE.test(line)) continue;
    const sub = moneyOnLine(line);
    if (sub !== null && centavos(sub) === itemsTotal) {
      return { ...base, reconciled: true, reason: "matches-subtotal" };
    }
  }

  // Otherwise the gap has to be accounted for by adjustment lines — each on
  // its own (the common case: one VAT line, one discount) or all together.
  const adjustments = lines
    .filter((line) => ADJUSTMENT_LINE.test(line) && !SUBTOTAL_LINE.test(line))
    .map(moneyOnLine)
    .filter((n): n is number => n !== null)
    .map(centavos);

  const gap = Math.abs(totalC - itemsTotal);
  const summed = adjustments.reduce((a, b) => a + b, 0);
  if (adjustments.some((a) => a === gap) || (adjustments.length > 1 && summed === gap)) {
    return { ...base, reconciled: true, reason: "explained-by-adjustment" };
  }

  return { ...base, reconciled: false, reason: "unexplained" };
}
