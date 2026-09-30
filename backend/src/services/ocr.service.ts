import { createWorker, type Worker as TesseractWorker } from "tesseract.js";
import type { Worker as WorkerThread } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { reconcileItems } from "../lib/receiptTextSignals";
export {
  findPageSeams,
  joinPagesWithoutSeams,
  looksLikeDuplicatePage,
  looksLikeMultipleReceipts,
  receiptItemsReconcile,
  reconcileItems,
  seamOverlapLength,
} from "../lib/receiptTextSignals";
export type { PageSeam, Reconciliation, ReconciliationReason } from "../lib/receiptTextSignals";

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
// v3 normalized confidence values and added stage timings. v4 adds locale-aware
// totals and structural vendor filters; neither version changes provider dispatch.
// v5 reads two-line item rows (figures on one line, name on the other) and the
// "T" VAT flag, so long supermarket receipts in those layouts return items.
export const PARSER_VERSION = "ocr-parser-v5";
/**
 * v2: the downscale cap follows the SHORT edge on an elongated LANDSCAPE image
 * (a long receipt lying along the frame's long axis) instead of always the
 * width, and the orientation that decision is made on is the EXIF-APPLIED one
 * (see `orientedDimensions`), not the raw stored one. Portrait and ordinary
 * photographs are preprocessed exactly as v1 did.
 */
export const PREPROCESS_VERSION = "ocr-preprocess-v2";

const TESSERACT_WORKER_OPTIONS = {
  langPath: env.TESSERACT_LANG_PATH,
  gzip: false,
  cacheMethod: "none",
} as const;

/*
 * Warm tesseract worker pool.
 *
 * Creating a worker loads the WASM engine and the packaged language data, a
 * few hundred milliseconds that used to be paid on every recognition, twice
 * per page. Workers are created lazily on first use and kept for the life of
 * the process, with the same options as before, so a warm worker returns the
 * same text and confidences a cold one did.
 *
 * Lifecycle: each slot runs one recognition at a time and further calls
 * queue in arrival order. A worker whose recognition rejected, or whose
 * thread exited, is discarded and the next call spawns a fresh one.
 * `shutdownOcr()` terminates the pool; a call after it starts over.
 *
 * Memory: tesseract.js writes each image to one fixed path (`/input`) in the
 * worker's in-memory FS and `SetImageFile` replaces the previous pix, so at
 * most the last image read is resident. Nothing on this side keeps the
 * buffer after `recognize` resolves.
 *
 * Idle workers are unref()ed so a one-shot script (the CI offline-OCR smoke)
 * still exits on its own; a worker is ref()ed while a job runs.
 */

/** Original + processed image of one page, read side by side. */
const OCR_POOL_SIZE = 2;

interface PoolSlot {
  worker: Promise<TesseractWorker> | null;
  busy: boolean;
}

const pool: PoolSlot[] = Array.from({ length: OCR_POOL_SIZE }, () => ({ worker: null, busy: false }));
const waiters: ((slot: PoolSlot) => void)[] = [];

/** The worker_threads handle tesseract.js keeps on its worker object (untyped upstream). */
function threadOf(worker: TesseractWorker): WorkerThread | undefined {
  return (worker as unknown as { worker?: WorkerThread }).worker;
}

function acquireSlot(): Promise<PoolSlot> {
  const idle = pool.find((slot) => !slot.busy);
  if (idle) {
    idle.busy = true;
    return Promise.resolve(idle);
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot(slot: PoolSlot): void {
  const next = waiters.shift();
  if (next) {
    next(slot); // stays busy, handed straight on
    return;
  }
  slot.busy = false;
}

async function discardWorker(slot: PoolSlot): Promise<void> {
  const pending = slot.worker;
  slot.worker = null;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Already dead or never came up; there is nothing left to release.
  }
}

function workerFor(slot: PoolSlot): Promise<TesseractWorker> {
  if (slot.worker) return slot.worker;
  const created = createWorker(env.TESSERACT_LANG, undefined, TESSERACT_WORKER_OPTIONS).then((worker) => {
    const thread = threadOf(worker);
    thread?.unref();
    // A thread that dies on its own must not leave a dead handle in the slot.
    thread?.once("exit", () => {
      if (slot.worker === created) slot.worker = null;
    });
    return worker;
  });
  created.catch(() => {
    if (slot.worker === created) slot.worker = null;
  });
  slot.worker = created;
  return created;
}

/**
 * How long one recognition may take before its worker is presumed wedged.
 *
 * Measured worst case across the corpus is a few seconds on a large photo, so
 * nothing healthy comes near this. It is a safety net for a WASM loop that
 * never returns: tripping it fails one scan, where the alternative is the
 * whole worker process stopping forever.
 */
const RECOGNITION_TIMEOUT_MS = 120_000;

/**
 * A promise that rejects when the worker's thread dies.
 *
 * tesseract.js settles a job only on a `message` from its thread, and its node
 * transport listens for nothing else — no `error`, no `exit`. So a thread that
 * aborts mid-recognition (a WASM out-of-memory on a large page) leaves the job
 * promise pending FOREVER. Without this, that pending promise held the pool
 * slot busy, held `workerBusy` in worker.ts true, and let the scan's heartbeat
 * keep renewing a lease nobody was working on: one bad image stopped every
 * receipt, CSV, purge and analysis job in the process until it was restarted.
 *
 * Promise.race subscribes to this, so a rejection arriving after the job
 * already won is delivered to a handler rather than becoming an unhandled
 * rejection. `dispose` keeps a long-lived thread from accumulating listeners.
 */
function threadDeath(thread: WorkerThread | undefined): { promise: Promise<never>; dispose: () => void } {
  if (!thread) return { promise: new Promise<never>(() => {}), dispose: () => {} };
  const onExit = (code: number) => rejectWith(new Error(`OCR worker thread exited (code ${code}) mid-recognition`));
  const onError = (err: Error) => rejectWith(err);
  let rejectWith: (err: Error) => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    rejectWith = reject;
    thread.once("exit", onExit);
    thread.once("error", onError);
  });
  return {
    promise,
    dispose: () => {
      thread.off("exit", onExit);
      thread.off("error", onError);
    },
  };
}

/** Runs one recognition on a pooled worker, queuing when both are busy. */
async function withPooledWorker<T>(job: (worker: TesseractWorker) => Promise<T>): Promise<T> {
  const slot = await acquireSlot();
  try {
    const worker = await workerFor(slot);
    const thread = threadOf(worker);
    thread?.ref();
    const death = threadDeath(thread);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        job(worker),
        death.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`OCR recognition exceeded ${RECOGNITION_TIMEOUT_MS} ms`)),
            RECOGNITION_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch (err) {
      // Includes the two cases above: the worker is not trustworthy either way.
      await discardWorker(slot);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      death.dispose();
      thread?.unref();
    }
  } finally {
    // A failed creation has already cleared the slot (see workerFor).
    releaseSlot(slot);
  }
}

export async function warmOcrPool(): Promise<number> {
  const slots = await Promise.all(Array.from({ length: OCR_POOL_SIZE }, () => acquireSlot()));
  try {
    await Promise.all(slots.map((slot) => workerFor(slot)));
    return slots.length;
  } finally {
    for (const slot of slots) releaseSlot(slot);
  }
}

/**
 * A throwaway worker for calls that set engine parameters (the accuracy
 * harness's PSM/DPI sweeps). `setParameters` is sticky on a worker, so a
 * sweep must not leave its settings on a pooled one.
 */
async function withEphemeralWorker<T>(
  params: Record<string, string>,
  job: (worker: TesseractWorker) => Promise<T>,
): Promise<T> {
  const worker = await createWorker(env.TESSERACT_LANG, undefined, TESSERACT_WORKER_OPTIONS);
  try {
    await worker.setParameters(params);
    return await job(worker);
  } finally {
    await worker.terminate();
  }
}

function engineParams(options: OcrEngineOptions): Record<string, string> {
  const params: Record<string, string> = {};
  if (options.pageSegMode) params.tessedit_pageseg_mode = options.pageSegMode;
  if (options.dpi) params.user_defined_dpi = options.dpi;
  return params;
}

function recognizeWith<T>(options: OcrEngineOptions, job: (worker: TesseractWorker) => Promise<T>): Promise<T> {
  const params = engineParams(options);
  return Object.keys(params).length > 0 ? withEphemeralWorker(params, job) : withPooledWorker(job);
}

/**
 * Terminates every warm worker; for graceful shutdown of the worker process.
 *
 * Slots are released and anyone still queued is rejected rather than left
 * waiting on a pool that no longer has workers. The pool is not sealed: a
 * later call spawns fresh workers, which is what the accuracy harness and the
 * tests that call this directly rely on.
 */
export async function shutdownOcr(): Promise<void> {
  const queued = waiters.splice(0, waiters.length);
  await Promise.all(pool.map((slot) => discardWorker(slot)));
  for (const slot of pool) slot.busy = false;
  // Resolved, not rejected: each waiter re-enters withPooledWorker's try block
  // and spawns a fresh worker, so a shutdown racing a queued call costs a
  // cold start rather than failing that scan.
  for (const resolve of queued) resolve(pool[0]!);
}

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
/**
 * Above this width-to-height ratio a photograph is a receipt lying along the
 * frame's LONG axis, not an ordinary picture — see `preprocessReceiptImage`.
 */
const ELONGATED_RATIO = 3;

/**
 * Which edge the OCR downscale caps, given the image's own (EXIF-oriented)
 * dimensions. Exported so the choice can be tested without running tesseract.
 */
/**
 * The image's dimensions AS IT WILL BE READ — after the EXIF orientation flag
 * has been applied, which is what `.rotate()` does to the pixels a moment later.
 *
 * THE TRAP THIS EXISTS TO AVOID. `sharp(buffer).rotate().metadata()` reports
 * the RAW STORED width and height, not the oriented ones: `.rotate()` is a
 * pipeline operation and `metadata()` reads the header, so chaining them does
 * nothing at all. Verified against the installed sharp — a 900x3000 JPEG tagged
 * `orientation: 6` reports 900x3000 either way, and the oriented size appears
 * only under `metadata.autoOrient`. Feeding the stored dimensions to
 * `ocrResizeOptions` picks the cap for an image that is about to be rotated out
 * from under it, which gets BOTH orientations wrong: a long receipt stored
 * portrait but displayed landscape takes the width cap and is squeezed to
 * 2000x300 (the exact failure the elongation branch was added for), and one
 * stored landscape but displayed portrait takes the height cap and is squeezed
 * to 300x2000, which is worse — it was never resized at all before.
 *
 * Orientations 5-8 are the transposed ones, so those swap the axes. Same test
 * and same reasoning as `boundedPerspectiveDimensions`'s caller in
 * lib/receiptPerspective.ts; the two must agree about what "the image's width"
 * means or a corrected receipt and the OCR of it disagree about their own shape.
 */
export function orientedDimensions(metadata: { width?: number; height?: number; orientation?: number }) {
  const swapped = (metadata.orientation ?? 1) >= 5;
  return swapped
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

export function ocrResizeOptions(width: number | undefined, height: number | undefined) {
  const landscapePanorama = !!width && !!height && width / height >= ELONGATED_RATIO;
  return landscapePanorama
    ? { height: MAX_WIDTH, withoutEnlargement: true as const }
    : { width: MAX_WIDTH, withoutEnlargement: true as const };
}

/** Exported so the orientation/downscale wiring can be tested without running tesseract. */
export async function preprocessReceiptImage(buffer: Buffer): Promise<Buffer> {
  /*
   * The cap is applied to whichever edge carries CHARACTER WIDTH, which is
   * the short one — not unconditionally to the width.
   *
   * A receipt is nearly always taller than it is wide, so capping width is the
   * same thing as capping the short edge and this behaves exactly as it always
   * has. It stops being the same thing for a long receipt that arrives lying
   * along the frame's long axis — a perspective-corrected panorama whose
   * corners were labelled sideways, or a long receipt photographed rotated. A
   * 12000x1800 image capped to 2000 wide comes out 2000x300: forty lines of
   * print squeezed into three hundred pixels, which is not a hard read but an
   * impossible one. Capping the SHORT edge instead keeps the same pixels per
   * character in either orientation.
   *
   * Only elongated landscape images take the other branch, so nothing in the
   * accuracy corpus changes (its landscape images are all under the cap and
   * were never resized at all). Still a behaviour change, hence the
   * PREPROCESS_VERSION bump above.
   */
  let dimensions: { width?: number; height?: number } = {};
  try {
    dimensions = orientedDimensions(await sharp(buffer).metadata());
  } catch {
    // Metadata is advisory here; the width cap is the safe default without it.
  }

  return sharp(buffer)
    .rotate()
    .resize(ocrResizeOptions(dimensions.width, dimensions.height))
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

function normaliseOcrConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

/**
 * Reads a receipt, keeping the confidence tesseract reports.
 *
 * `blocks: true` is required — tesseract.js omits the block/paragraph/line
 * tree by default and returns only flat text, so the per-word confidences
 * simply are not there unless asked for.
 */
export async function extractReceipt(buffer: Buffer, options: OcrEngineOptions = {}): Promise<OcrResult> {
  const startedAt = performance.now();
  const preprocessingStartedAt = performance.now();
  let image = buffer;
  let usedPreprocessedImage = false;
  try {
    image = await preprocessReceiptImage(buffer);
    usedPreprocessedImage = true;
  } catch (err) {
    logger.error({ err }, "Receipt image preprocessing failed; reading the original image instead");
  }
  const preprocessingMs = Math.max(0, Math.round(performance.now() - preprocessingStartedAt));
  const engineStartedAt = performance.now();

  try {
    const result = await recognizeWith(options, async (worker) => {
      const { data } = await worker.recognize(image, {}, { blocks: true, text: true });

      const lines: OcrLine[] = [];
      // Tesseract's types omit the optional block tree requested above.
      for (const block of ((data as unknown as { blocks?: unknown[] }).blocks ?? []) as any[]) {
        for (const paragraph of block?.paragraphs ?? []) {
          for (const line of paragraph?.lines ?? []) {
            lines.push({
              text: String(line?.text ?? ""),
              confidence: normaliseOcrConfidence(line?.confidence),
              words: (line?.words ?? []).map((w: any) => ({
                text: String(w?.text ?? ""),
                confidence: normaliseOcrConfidence(w?.confidence),
              })),
            });
          }
        }
      }

      return { text: data.text, confidence: normaliseOcrConfidence(data.confidence), lines };
    });
    const engineMs = Math.max(0, Math.round(performance.now() - engineStartedAt));
    logger.info(
      {
        operation: "receipt-ocr",
        outcome: "succeeded",
        usedPreprocessedImage,
        stageTimings: {
          preprocessingMs,
          engineMs,
          totalMs: Math.max(0, Math.round(performance.now() - startedAt)),
        },
      },
      "Receipt OCR completed",
    );
    return result;
  } catch (error) {
    const failureKind = error instanceof Error ? error.name : "unknown";
    logger.error(
      {
        operation: "receipt-ocr",
        outcome: "failed",
        failureKind,
        usedPreprocessedImage,
        stageTimings: {
          preprocessingMs,
          engineMs: Math.max(0, Math.round(performance.now() - engineStartedAt)),
          totalMs: Math.max(0, Math.round(performance.now() - startedAt)),
        },
      },
      "Receipt OCR failed",
    );
    throw error;
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

  return recognizeWith(options, async (worker) => {
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
    const { data } = await worker.recognize(image);
    return data.text;
  });
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

/**
 * A tax-breakdown annotation that happens to contain the word "total", but
 * states the TAX portion, not the amount paid — "TOTAL INCLUDES 6% GST 1.08",
 * "(Total Included GST @ 6%: 1.42)". The tell is "total" and the tax name
 * (gst/vat) sharing a line with a full "includ-" word; the genuine total line
 * on the same receipts reads "Total (incl GST) 19.00" — "incl", not
 * "include[sd]" — with the amount trailing the parenthetical rather than
 * being introduced by it, so this does not also catch that line. Measured:
 * a McDonald's receipt's GST note (1.08) and a Malaysian bakery's GST note
 * (1.42) both outscored the receipt's real total by being read first.
 */
const TAX_INCLUSIVE_NOTE = /\btotal\b[^\n]*\binclud(?:e[sd]?|ing)\b[^\n]*\b(gst|vat)\b/i;

/**
 * A payment/tender line — "Cash Tendered 50.00", "Change Due 0.39" — carries
 * money that is not the transaction total and must never win the max-value
 * fallback used when no line reads as a total at all. Mirrors the equivalent
 * guard already applied to line items (NOT_AN_ITEM) — extended here to the
 * receipt-level amount for the same reason: a register that prints a tender
 * amount larger than the total (change owed, or a round banknote handed
 * over) would otherwise be picked as "the" amount.
 */
const TENDER_LINE = /\b(cash(?:\s+tendered)?|tendered|amount\s+tendered|change(?:\s+due)?)\b/i;

function parseAmount(text: string): number | null {
  return readReceiptTotal(text)?.value ?? null;
}

/**
 * The receipt's total, and whether the paper labelled it as one.
 *
 * `labelled` is false only for the last-resort reading, the largest figure on
 * the page, which on a section photographed above the TOTAL line is simply
 * the most expensive purchase.
 */
function readReceiptTotal(text: string): { value: number; labelled: boolean } | null {
  const lines = text.split("\n");
  // Require two decimal digits in both locale formats, including OCR-inserted spaces.
  // The lookarounds prevent partial matches inside dates and longer decimals.
  const moneySource = String.raw`(?<![\d.,])(?:\d+(?:,\d{3})*\s*\.\s*\d{2}|\d+(?:\.\d{3})*\s*,\s*\d{2})(?![\d.,])`;
  const moneyPattern = new RegExp(`(${moneySource})`);
  const parseMoney = (raw: string): number => {
    const compact = raw.replace(/\s/g, "");
    const comma = compact.lastIndexOf(",");
    const point = compact.lastIndexOf(".");
    return comma > point
      ? Number(compact.replace(/\./g, "").replace(",", "."))
      : Number(compact.replace(/,/g, ""));
  };

  const totalCandidates = lines.filter(
    (line) => /\btotal\b/i.test(line)
      && !/\bsub\s*-?\s*total\b/i.test(line)
      && !/\btotal\s+incid[eê]ncias\b/i.test(line)
      && !TAX_INCLUSIVE_NOTE.test(line),
  );

  /*
   * A few phrasings name the FINAL figure explicitly, and take priority over
   * any other total-shaped line further up the same receipt when both are
   * present — checked in this order, not blended with a general
   * "prefer-the-last-total-line" rule, because the last total-shaped line is
   * NOT reliably the right one (a trailing "GST included in total: 1.49"
   * annotation loses to an earlier plain total on a real receipt in this
   * corpus, which a blanket "prefer last" would have got wrong):
   *
   *   - "Net Total" — the post-rounding figure some GST receipts print after
   *     an earlier "Total Sales (Incl. GST)" subtotal. Measured: a real
   *     receipt printed "Total Sales (Incl. GST @6%) RM18.29" before "Net
   *     Total RM18.30" (the rounded figure actually paid), and first-match
   *     picked the pre-rounding one.
   *   - "Total Payable" — the figure a multi-tier VAT breakdown (zero-rated
   *     and standard-rated subtotals, each printed as its own "Total ...
   *     supplies" line) resolves to. Measured: a real invoice printed "Total
   *     0% supplies: 18.92", "Total 6% supplies (excl. GST): 56.93", "Total
   *     6% supplies (Inc. GST): 60.34" and "Total 0% supplies: 13.92" before
   *     the actual "Total Payable: 79.26", and first-match picked the first
   *     zero-rated subtotal instead of the payable figure at the end.
   */
  const priority = [/\bnet\s*total\b/i, /\btotal\s+payable\b/i]
    .map((pattern) => totalCandidates.find((line) => pattern.test(line)))
    .find((line): line is string => line !== undefined);
  const ordered = priority ? [priority, ...totalCandidates.filter((line) => line !== priority)] : totalCandidates;

  // Try every total-shaped line in order, not just the first — a header like
  // "QTY ITEM TOTAL" matches the keyword but carries no money, and bailing
  // out there (rather than trying the next candidate) used to fall all the
  // way through to the max-value fallback below, where a "Cash Tendered"
  // line could win instead. Measured on a real McDonald's receipt.
  for (const line of ordered) {
    const total = /\btotal\b/i.exec(line);
    const afterLabel = total ? line.slice(total.index + total[0].length).match(moneyPattern) : null;
    const match = afterLabel ?? line.match(moneyPattern);
    if (match) return { value: parseMoney(match[1]!), labelled: true };
  }

  // A strict Qty/count/money summary can recover a payable amount when its label is unreadable.
  // Tesseract's evidenced Q-to-B confusion is allowed only within that complete row shape.
  const quantitySummaryPattern = new RegExp(String.raw`^\s*[qb]ty\s+\d+\s+${moneySource}\s*$`, "i");
  const quantitySummary = lines.find((line) => quantitySummaryPattern.test(line));
  const summaryMatch = quantitySummary?.match(moneyPattern);
  if (summaryMatch) return { value: parseMoney(summaryMatch[1]!), labelled: true };

  // Fall back to the largest decimal-looking number anywhere in the
  // receipt — usually the total is the biggest line-item-shaped number.
  // Tender/change lines are excluded so a banknote handed over, or change
  // owed, cannot be mistaken for the total when no line reads as one.
  const allMatches = lines
    .filter((line) => !TENDER_LINE.test(line))
    .flatMap((line) => [...line.matchAll(new RegExp(`(${moneySource})`, "g"))])
    .map((m) => parseMoney(m[1]!));
  if (allMatches.length > 0) {
    return { value: Math.max(...allMatches), labelled: false };
  }

  return null;
}

// Generic document furniture that is never the store's name.
const NOT_A_VENDOR =
  /^[\W_]*(sales\s+invoice|official\s+receipt|invoice|receipt|cash\s+invoice|statement|order\s+slip)[\W_]*$/i;

const BARE_BUSINESS_CATEGORY = /^[\W_]*(restaurant|store|shop|market|bakery|cafe)[\W_]*$/i;

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
 * Customer-service phone lines ("Guest Relations Center : 1300-13-1300").
 * These read as a business-type phrase to VENDOR_KEYWORD ("center" is one of
 * the words) and are printed in the footer — the same place a real footer
 * vendor name is expected — so they can outscore the true name on keyword
 * plus position alone. Requires BOTH a contact-role phrase and a
 * phone-number-shaped digit run, so an address or reference line with either
 * signal alone is not caught by this. Measured: a real McDonald's receipt
 * read "Guest Relations Center : 1300-13-1300" as the vendor over
 * "McDonald's" a few lines above it.
 */
const CONTACT_CENTER_LINE =
  /\b(guest\s+relations|customer\s+(service|care|support)|call\s*center|contact\s*(center|us)|hotline|helpline)\b.*\d{3,4}[-\s]\d{2,4}[-\s]\d{3,4}/i;

/**
 * Suggested-gratuity boilerplate ("SUGGESTED TIP", "BEFORE DISCOUNTS" — the
 * header some US POS systems print above a table of 18%/20%/22% tip
 * suggestions). Never the store's name, but ordinary prose with real letters
 * and multiple words that would otherwise pass every other filter. Measured:
 * a real steakhouse receipt read the (OCR-garbled) "BEFORE DISCOUNTS" line as
 * the vendor over "SASKA'S" a few lines above it.
 */
const GRATUITY_BOILERPLATE_LINE = /\b(suggested\s+(tip|gratuity)|before\s+discounts?)\b/i;

const CHECK_SPLIT_LINE = /\b(separate|split)\s+checks?\b/i;
const SERVICE_METADATA_LINE = /\b(table|party|check|server|svr\w*)\s*(?:#|:)?\s*\d/i;

/**
 * Words that mark a line as a business name rather than an address or a
 * scrap of OCR noise. Deliberately Philippine-retail flavoured, because that
 * is the market — a "sari-sari store" or a "marketing corporation" is a shop,
 * a line reading "Dore" is almost certainly a mangled logo. "Tindahan" is the
 * Filipino word for "store" and appears as often as the English word on
 * small-shop receipts.
 */
const VENDOR_KEYWORD =
  /\b(store|shop|mart|market|supermarket|grocery|groceries|trading|enterprise|enterprises|corporation|corp|incorporated|inc|company|co|merchandise|merchandising|pharmacy|bakery|bakeries|hardware|sari-?sari|tindahan|foods?|restaurant|cafe|coffee|eatery|carinderia|depot|supply|supplies|center|centre)\b/i;

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
    // A customer-service phone line or a suggested-gratuity table header is
    // footer boilerplate, same reasoning as CLOSING_LINE just above.
    .filter(({ line }) => !CONTACT_CENTER_LINE.test(line))
    .filter(({ line }) => !GRATUITY_BOILERPLATE_LINE.test(line))
    .filter(({ line }) => !CHECK_SPLIT_LINE.test(line))
    .filter(({ line }) => !SERVICE_METADATA_LINE.test(line))
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
    if (BARE_BUSINESS_CATEGORY.test(line)) points -= 80;

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
      /\b(st|street|ave|avenue|blvd|boulevard|rd|road|blk|block|brgy|barangay|city|purok|zone|highway|bldg|building)\b/i.test(
        line,
      )
    ) {
      points -= 30;
    }
    // Address structure outweighs a business-like phrase such as "Market Place".
    if (
      /^\W*\d+\s+.*\b(st|street|ave|avenue|blvd|boulevard|rd|road|place|plaza|highway)\b/i.test(line)
      || /\b[A-Z]{2}\s+\d{4,6}\s*$/i.test(line)
    ) points -= 100;
    // Digits belong to addresses and reference numbers far more than to names.
    points -= (line.match(/\d/g) ?? []).length * 2;

    /*
     * A standalone run of 5+ digits next to little else is a store/location
     * ID line, not a name — "i Restaurant 1100580 i" is the generic word
     * "Restaurant" plus a store number and OCR-noise filler characters, with
     * nothing that reads as an actual proper name. Gated on word count (<= 2
     * real words) so it does NOT catch a genuine business name that happens
     * to carry a registration number, e.g. "KING'S CONFECTIONERY S/B
     * 273500-U (KSB)" — that line has four real words and must keep scoring
     * on its own merits. Measured: the Carl's Jr. store-ID line outscored
     * "CARL'S JR" itself a few lines above it.
     */
    if (/\b\d{5,}\b/.test(line) && words.length <= 2) points -= 60;

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
    // Summary and total lines. Bare "amount" (not just "amt") is needed for
    // the plain "Amount: 24.95" label some US receipts print on its own line
    // above the total — found reading as a purchased item on a real receipt.
    String.raw`\b(sub\s*-?\s*total|total|amt|amount|balance)\b`,
    // Tax lines. [VY] for the V->Y misread; the trailing part covers
    // "VATable Sales", "VAT-Exempt Sales", "Zero-Rated Sales".
    String.raw`\b[vy]at(able)?\b`,
    String.raw`\b(tax|zero\s*-?\s*rated|vat\s*-?\s*exempt|exempt|non\s*-?\s*taxable)\b`,
    // A GST/tax-summary breakdown row, printed under a "GST Summary" or
    // similar header on Malaysian receipts — the tax classification code
    // (SR/ZR/IR/ES) followed by its rate, e.g. "SR @ 6% 8.21 0.49" or
    // "IR (0%) 4.99 0.20". These carry the receipt's SALES total by tax
    // class, not a purchase, and were found reading as purchased items on
    // two real receipts.
    String.raw`\b(sr|zr|ir|es)\s*(@|\()\s*\d{1,3}%`,
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
 * real-01-ph-pos-photo in the corpus, not hypothesised. Gaisano registers
 * print "T" (taxable) in the same position: "115.25T" on a real three-page
 * Gaisano Grand receipt left every one of its 53 items unread.
 */
const TRAILING_AMOUNT = /(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s*[VZEXT]?\s*$/i;

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
    .replace(/[.\s|\\]+$/, "")
    .trim();
}

// ============================================================
// Two-line item rows
// ============================================================
// Many Philippine supermarket registers print one purchase across TWO lines:
// the figures on one (quantity, unit price, line total, often a product code
// in front) and the description on the other. Which comes first depends on
// the register:
//
//   figures first (Gaisano)            name first (Puregold-style)
//   005705486  1  115.25  115.25T      OISHI FISH CRACKERS 24g/100
//   FEMME BT300 2PLY 128+CTTN              4     6.80    27.20V
//
// A single-line reader sees neither half as a purchase — the figures line has
// no name and the name line has no amount — so a long receipt printed this way
// came back with no items at all.
//
// The figures line is what makes pairing safe: quantity x unit price has to
// equal the line total, so a row of unrelated numbers (a VAT breakdown, a
// cashier number) is never read as a purchase, and the OCR tolerances below
// can only ever admit a row the arithmetic has already confirmed.

/** The figures half of a two-line row. */
interface FiguresRow {
  /** The printed product code, when the register prints one ("005705486"). */
  code: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/**
 * Table edges and stray punctuation OCR leaves around a column of figures: a
 * dark margin read as "|", a speck read as "'" or ".". Never a minus sign or
 * a parenthesis: "20.00-" and "(20.00)" are how registers print a void or a
 * return, and stripping them would book money coming back as money spent.
 */
const FIGURES_EDGE_NOISE = /^[\s|¦![\]{}~_"'`:;,.*•·»«]+|[\s|¦![\]{}~_"'`:;,.*•·»«]+$/g;

/**
 * A printed money figure, with the decimal point OCR sometimes reads as a
 * comma ("27,20"). The optional trailing character is the VAT class flag on a
 * line total ("115.25T"), which tesseract reads as often as not as a digit
 * ("115.257", "115.251"); it is only accepted on the total and only because
 * the row must multiply out. A unit price may have lost its last zero
 * ("130.5"), for the same reason.
 */
const FIGURE_MONEY = /^(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})([A-Za-z*#]|\d)?$/;
const FIGURE_UNIT_PRICE = /^(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{1,2})$/;

/** A quantity column: whole units, or a weight to three decimals. l, I and | are misread ones. */
const FIGURE_QUANTITY = /^[0-9OoIl|]{1,4}(?:\.\d{1,3})?$/;

/** The separator some registers print between quantity and unit price ("4 x 6.80", "4 @ 6.80"). */
const FIGURE_TIMES = /^[x×@*]$/i;

/**
 * A lone symbol OCR made of a speck, a pen stroke or a misread digit ("¥",
 * "©", "§"). Dropped from a figures row before it is read; whatever it hid, the
 * row still has to multiply out to be believed.
 */
const FIGURE_SPECK = /^[^\p{L}\p{N}.,@*×()-]$/u;

function figureMoney(token: string, unitPrice = false): number | null {
  // O read for 0 and l/I for 1 inside the figure itself, never in the flag.
  const figure = token.replace(/^[\dOoIl,]+[.,][\dOoIl]{1,2}/, (digits) => digits.replace(/[Oo]/g, "0").replace(/[Il]/g, "1"));
  const match = (unitPrice ? FIGURE_UNIT_PRICE : FIGURE_MONEY).exec(figure);
  if (!match) return null;
  const value = Number(`${match[1]!.replace(/,/g, "")}.${match[2]}`);
  return Number.isFinite(value) && value > 0 && value < 10_000_000 ? value : null;
}

function figureQuantity(token: string): number | null {
  const quantity = token.replace(/\.$/, "");
  if (!FIGURE_QUANTITY.test(quantity)) return null;
  const value = Number(quantity.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1"));
  return Number.isFinite(value) && value > 0 && value < 10_000 ? value : null;
}

/**
 * A product code: mostly digits, O and l/I read for 0 and 1, and the odd
 * symbol OCR puts in place of a digit ("004%7265"). Only ever a fallback name
 * and a key for matching the same row in two photographs.
 */
function figureCode(token: string): string | null {
  if (!/^[A-Za-z0-9%#&$§-]{4,20}$/.test(token)) return null;
  const normalised = token.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
  const digits = (normalised.match(/\d/g) ?? []).length;
  return digits >= 4 && digits / normalised.length >= 0.6 ? normalised : null;
}

/**
 * Reads a line that is ONLY figures: `[code] [qty] [x|@] unitPrice amount[flag]`.
 *
 * Returns null for anything with words on it — those are single-line items or
 * not purchases at all — and for any row whose figures do not multiply out.
 * When the printed quantity does not multiply out but the total is an exact
 * whole multiple of the unit price, the multiple is the quantity: the same
 * correction the inline "@" reading makes, for the same reason (a 1 read as 7
 * must not put seven units in the owner's books).
 */
function parseFiguresRow(rawLine: string): FiguresRow | null {
  const line = rawLine.replace(/₱|PHP|Php/g, " ").replace(FIGURES_EDGE_NOISE, "");
  if (!line) return null;
  const tokens = line.split(/\s+/).filter((token) => !FIGURE_SPECK.test(token));
  // A flag printed apart from the total ("115.25 T"), or a speck after it.
  const last = tokens[tokens.length - 1];
  if (tokens.length > 3 && last && /^[A-Za-z0-9|¦!*#]{1,2}$/.test(last) && figureMoney(tokens[tokens.length - 2]!) !== null) {
    tokens.pop();
  }
  if (tokens.length < 3 || tokens.length > 5) return null;

  const amount = figureMoney(tokens[tokens.length - 1]!);
  const unitPrice = figureMoney(tokens[tokens.length - 2]!, true);
  if (amount === null || unitPrice === null) return null;

  const leading = tokens.slice(0, -2);
  if (leading.length > 0 && FIGURE_TIMES.test(leading[leading.length - 1]!)) leading.pop();
  let code: string | null = null;
  let printedQuantity: number | null = null;
  if (leading.length === 2) {
    code = figureCode(leading[0]!);
    printedQuantity = figureQuantity(leading[1]!);
    if (code === null || printedQuantity === null) return null;
  } else if (leading.length === 1) {
    printedQuantity = figureQuantity(leading[0]!);
    if (printedQuantity === null) {
      code = figureCode(leading[0]!);
      if (code === null) return null;
    }
  } else {
    return null;
  }

  if (printedQuantity !== null && Math.abs(printedQuantity * unitPrice - amount) < 0.02) {
    return { code, quantity: printedQuantity, unitPrice, amount };
  }
  const implied = amount / unitPrice;
  const whole = Math.round(implied);
  if (whole >= 1 && whole < 10_000 && Math.abs(implied - whole) < 0.005) {
    return { code, quantity: whole, unitPrice, amount };
  }
  return null;
}

/**
 * "PWD" on a supermarket description is POWDER ("BEAR BRAND PWD SWAK 33G/1",
 * "TIDE PWD 70G"); the persons-with-disability discount it also names comes
 * with its own context on the line — a rate, "disc", an ID, "SC/PWD".
 */
const PWD_DISCOUNT_CONTEXT = /%|\bdisc|\bid\b|#|\bname\b|\bsc\s*\//i;

/**
 * A line that can be the description half of a two-line row: real words, no
 * money at the end, and none of the furniture the item parser already refuses.
 */
function isItemNameLine(rawLine: string): boolean {
  const line = rawLine.replace(/₱|PHP|Php|\$/g, " ").trim();
  if (!line) return false;
  const denylisted = PWD_DISCOUNT_CONTEXT.test(line) ? line : line.replace(/\bpwd\b/gi, "powder");
  if (ADMINISTRATIVE_LINE.test(line) || NOT_AN_ITEM.test(denylisted) || CLOSING_LINE.test(line)) return false;
  // A line ending in money is a purchase or a summary in its own right.
  if (TRAILING_AMOUNT.test(line)) return false;
  // "ADDRESS:" and "No Of Items : 239" are labels, not products.
  if (/:\s*$/.test(line) || /\s:\s/.test(line)) return false;
  const visible = line.replace(/\s/g, "");
  const letters = (visible.match(/[A-Za-z]/g) ?? []).length;
  const digits = (visible.match(/\d/g) ?? []).length;
  return letters >= 3 && letters / visible.length >= 0.3 && (letters + digits) / visible.length >= 0.6;
}

interface TwoLineRows {
  /** Figures line index -> the item it carries (null when it could not be named). */
  rows: Map<number, { name: string; row: FiguresRow } | null>;
  /** Line indexes consumed as the description half of a row. */
  names: Set<number>;
}

/**
 * Pairs each figures line with its description, deciding once per receipt
 * whether descriptions print above or below their figures.
 *
 * The decision is a count, not a guess: a figures-first block starts with a
 * figures line under the column header and ends with a description above the
 * total, so more figures lines have a description BELOW them than above, and
 * the other way round for name-first. A tie means both ends of the block are
 * descriptions — a page that starts mid-receipt, say — and falls to the one
 * structural hint left: registers that print a product code lead the item
 * with it (the code sits in the ITEM column), so code-bearing rows read
 * figures-first.
 *
 * A figures line whose description is missing (the line was unreadable, or
 * cut off at the edge of a photograph) keeps its printed product code as its
 * name; without a code there is nothing printed to call it, and it is dropped
 * rather than named by invention — the gap then shows against the total.
 */
function pairTwoLineRows(lines: string[]): TwoLineRows {
  const rows: TwoLineRows["rows"] = new Map();
  const names = new Set<number>();
  const present = lines.flatMap((line, index) => (line.trim() ? [index] : []));
  const figures = new Map<number, FiguresRow>();
  const nameLines = new Set<number>();
  for (const index of present) {
    const row = parseFiguresRow(lines[index]!);
    if (row) figures.set(index, row);
    else if (isItemNameLine(lines[index]!)) nameLines.add(index);
  }
  if (figures.size === 0) return { rows, names };

  const position = new Map(present.map((index, at) => [index, at]));
  const neighbour = (index: number, step: -1 | 1): number | undefined => present[position.get(index)! + step];
  let above = 0;
  let below = 0;
  for (const index of figures.keys()) {
    if (nameLines.has(neighbour(index, -1) ?? -1)) above++;
    if (nameLines.has(neighbour(index, 1) ?? -1)) below++;
  }
  const withCodes = [...figures.values()].filter((row) => row.code !== null).length;
  const figuresFirst = below > above || (below === above && withCodes * 2 > figures.size);

  for (const [index, row] of figures) {
    const partner = neighbour(index, figuresFirst ? 1 : -1);
    if (partner !== undefined && nameLines.has(partner) && !names.has(partner)) {
      const name = cleanItemName(lines[partner]!);
      if ((name.match(/[A-Za-z]/g) ?? []).length >= 3) {
        names.add(partner);
        rows.set(index, { name, row });
        continue;
      }
    }
    rows.set(index, row.code ? { name: row.code, row } : null);
  }
  return { rows, names };
}

/**
 * A purchased line plus where it was printed, for callers that need to know
 * which photograph an item came from.
 */
export interface LocatedLineItem extends ParsedLineItem {
  /** Index, in `text.split("\n")`, of the line carrying the item's amount. */
  lineIndex: number;
  /** The printed product code of a two-line row, when the register prints one. */
  code: string | null;
  /** Read from a two-line row, whose printed quantity x unit price made its total. */
  twoLineRow: boolean;
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
  return parseLocatedLineItems(text).map(({ name, quantity, unitPrice, amount }) => ({ name, quantity, unitPrice, amount }));
}

/**
 * A single-line item name that reads as words, for registers that print their
 * purchases as two-line rows. There a line of text ending in money is rarely
 * a purchase: it is a figures row OCR garbled past reading ("0F663300 3 0 NB
 * 299.51", read from 005443300 3 99.75 299.25T), and its "name" is the
 * wreckage of the code and quantity columns.
 */
function readsAsWords(name: string): boolean {
  const visible = name.replace(/\s/g, "");
  const letters = (visible.match(/[A-Za-z]/g) ?? []).length;
  return letters >= 3 && letters / visible.length >= 0.5 && !/^\S*\d{4,}/.test(name);
}

/** `parseLineItems`, keeping each item's source line and printed product code. */
export function parseLocatedLineItems(text: string): LocatedLineItem[] {
  const items: LocatedLineItem[] = [];
  // The receipt's own total, used by the structural guard at the bottom.
  const receiptTotal = readReceiptTotal(text);
  const lines = text.split("\n");
  const twoLine = pairTwoLineRows(lines);
  /*
   * A register that prints its purchases as two-line rows ends them at the
   * TOTAL line; what follows is tender, change and tax, and a line there that
   * slipped past the denylist ("OHNGE wwe) 2.75", the CHANGE line) is not a
   * purchase. Single-line receipts keep every line, as they always have.
   */
  const twoLineRegister = twoLine.rows.size >= 3;
  let lastTotalLine = -1;
  for (let index = lines.length - 1; twoLineRegister && index >= 0 && lastTotalLine < 0; index--) {
    const line = lines[index]!;
    if (/\btotal\b/i.test(line) && !/\bsub\s*-?\s*total\b/i.test(line) && /\d\s*[.,]\s*\d{2}/.test(line)) lastTotalLine = index;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const pair = twoLine.rows.get(lineIndex);
    if (pair !== undefined) {
      if (pair) {
        const { code, quantity, unitPrice, amount } = pair.row;
        items.push({ name: pair.name, quantity, unitPrice, amount, lineIndex, code, twoLineRow: true });
      }
      continue;
    }
    // The description half of a two-line row carries no amount of its own.
    if (twoLine.names.has(lineIndex)) continue;

    const line = lines[lineIndex]!.replace(/₱|PHP|Php|\$/g, " ").trimEnd();
    if (!line.trim()) continue;
    // Administrative furniture and summary lines are never purchases.
    if (ADMINISTRATIVE_LINE.test(line) || NOT_AN_ITEM.test(line)) continue;
    if (lastTotalLine >= 0 && lineIndex > lastTotalLine) continue;

    // Shape A: "Name   2   25.00   50.00" — quantity and unit price columns.
    const columns = line.match(QTY_UNIT_AMOUNT_TAIL);
    if (columns) {
      const name = cleanItemName(columns[1]!);
      const quantity = Number(columns[2]);
      const unitPrice = money(columns[3]!);
      const amount = money(columns[4]!);
      // Only trust the columns when they actually multiply out; otherwise
      // this is three unrelated numbers that happen to sit in a row.
      if (name.length >= 2 && Math.abs(quantity * unitPrice - amount) < 0.02 && (!twoLineRegister || readsAsWords(name))) {
        items.push({ name, quantity, unitPrice, amount, lineIndex, code: null, twoLineRow: false });
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
    if (twoLineRegister && !readsAsWords(name)) continue;

    items.push({
      name,
      quantity,
      unitPrice: unitPrice ?? (quantity && quantity > 0 ? Math.round((amount / quantity) * 100) / 100 : null),
      amount,
      lineIndex,
      code: null,
      twoLineRow: false,
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
   *
   * And only against a total the paper actually states. With no TOTAL line
   * the "total" is merely the largest figure, which on a section photographed
   * above the TOTAL line is the most expensive purchase — and this used to
   * delete it from every such page. That figure counts as the total only when
   * the other items add up to it, i.e. when it IS one with its label misread.
   */
  if (receiptTotal !== null && items.length > 1) {
    const filtered = items.filter((i) => Math.abs(i.amount - receiptTotal.value) >= 0.005);
    const isTotal = receiptTotal.labelled || reconcileItems(text, filtered, receiptTotal.value).reconciled;
    // Only apply it if something survives — a receipt whose every line equals
    // the total is not something this rule can reason about.
    if (filtered.length > 0 && isTotal) return filtered;
  }

  return items;
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
      if (w === target) return normaliseOcrConfidence(word.confidence);
      if (target.length >= 3 && w.includes(target)) {
        best = Math.max(best ?? 0, normaliseOcrConfidence(word.confidence));
      }
    }
    if (best === null && target.length >= 3 && normaliseToken(line.text).includes(target)) {
      best = normaliseOcrConfidence(line.confidence);
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
  return normaliseOcrConfidence(result.confidence);
}

/**
 * The same figure for a receipt photographed in several sections: the mean
 * over every word on every page, which is what tesseract's own page
 * confidence is for a single page.
 *
 * Not the worst page. One section of a long receipt that reads badly — a
 * handwritten note across the header, say — used to set the figure for the
 * whole receipt, so a clean three-page read was presented as "hard to read"
 * throughout. The weak page is still named, by its own LOW_CONFIDENCE
 * warning, and still triggers review on its own.
 */
export function documentConfidence(results: OcrResult[]): number {
  if (results.length === 1) return overallConfidence(results[0]!);
  let sum = 0;
  let words = 0;
  for (const result of results) {
    for (const line of result.lines) {
      for (const word of line.words) {
        if (!word.text.trim()) continue;
        sum += normaliseOcrConfidence(word.confidence);
        words++;
      }
    }
  }
  if (words > 0) return normaliseOcrConfidence(sum / words);
  // No word tree to average: weight each page's own figure by how much it read.
  const weights = results.map((result) => Math.max(1, result.text.trim().length));
  const weighted = results.reduce((total, result, index) => total + overallConfidence(result) * weights[index]!, 0);
  return normaliseOcrConfidence(weighted / weights.reduce((total, weight) => total + weight, 0));
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
 *     claim the same printed line.
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
