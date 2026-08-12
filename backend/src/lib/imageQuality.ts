import sharp from "sharp";
import { logger } from "../config/logger";

/**
 * How readable a receipt photograph is, measured before the owner starts
 * correcting what OCR made of it.
 *
 * WHY THIS IS SERVER-SIDE. The obvious place to catch a bad capture is the
 * camera, but on-device image analysis in Expo needs native modules — the same
 * constraint that ruled out ML Kit. Measuring here costs one extra pass over an
 * image already in memory, works identically for a phone capture and a browser
 * upload, and keeps one pipeline rather than two that can disagree about what
 * "too blurry" means.
 *
 * WHY IT IS WORTH DOING AT ALL. Nothing downstream recovers detail a capture
 * did not record — preprocessing and engine tuning were both measured against
 * exactly that and moved nothing. So the useful move is not to try harder on a
 * bad photograph but to say so while the owner is still holding the receipt. A
 * retake costs five seconds; correcting a garbled extraction costs far more.
 */

/**
 * Everything is measured on a downscaled grayscale copy.
 *
 * 400px is enough for sharpness to be stable — blur is a property of the image
 * as a whole, not of fine detail — and it turns a multi-megapixel decode into
 * about 160k values, so the assessment costs milliseconds rather than
 * competing with OCR itself.
 */
const ANALYSIS_WIDTH = 400;

export interface ImageQuality {
  /**
   * Variance of the Laplacian: the standard sharpness measure. High means
   * strong local intensity changes — edges, and therefore legible print. Low
   * means those transitions are smeared, which is what blur is.
   */
  sharpness: number;
  /**
   * Mean brightness, 0-255. RECORDED BUT NOT ACTED ON. Measured against the
   * corpus it did not separate readable photographs from unreadable ones: the
   * darkest image there (mean 109) reads perfectly, while one at 136 fails. It
   * is kept because it costs one accumulator in a loop that is already running
   * and because it is the obvious thing to re-check once there are real
   * photographs taken in poor light to calibrate against.
   */
  brightness: number;
  /** True when the photograph is too smeared to be worth trusting. */
  tooBlurredToTrust: boolean;
  /** The photograph's own pixel width, after EXIF rotation. */
  width: number;
  /** The photograph's own pixel height, after EXIF rotation. */
  height: number;
  /**
   * True when the image simply does not carry enough pixels for OCR to have
   * a fair chance, whatever else is right about it.
   *
   * A SEPARATE QUESTION FROM SHARPNESS, and worth asking separately: a
   * downscaled screenshot of a receipt, or a heavily-compressed image
   * forwarded through a chat app, can be perfectly sharp at the size it
   * arrives and still have had the thermal print resampled away. Sharpness
   * measures how crisp the transitions are; this measures whether there are
   * enough of them to read. Advisory like everything else here — a small
   * photograph is sometimes the only photograph of that purchase.
   */
  tooSmallToRead: boolean;
}

/**
 * The narrow edge below which a receipt photograph is called out as small.
 *
 * Tesseract wants roughly 20px of height per line of text to read it
 * reliably. A receipt fills the frame's long axis with something like 40-60
 * printed lines, which puts the useful floor for the SHORT edge — the one
 * that carries line width, and therefore character width — at around a
 * thousand pixels. Every phone camera this app will meet clears that by a
 * wide margin; what does not clear it is a screenshot, a chat-app re-encode,
 * or a gallery image someone already shrank. Those are exactly the cases
 * worth a sentence before the owner waits on a bad read.
 *
 * Like SHARPNESS_FLOOR this rejects nothing. Unlike SHARPNESS_FLOOR it is
 * reasoned from how OCR works rather than calibrated against the corpus,
 * because every image in the corpus is a full-size camera photograph and none
 * of them exercises this at all. Said plainly rather than implied.
 */
export const MIN_READABLE_EDGE = 1000;

/**
 * Sharpness at or below which a photograph is called out to the owner.
 *
 * CALIBRATED, and the calibration is thinner than the number looks — see
 * tests/ocr-accuracy/quality-calibration.ts, which scores every corpus image
 * against whether its parse was right.
 *
 * Images that read cleanly score 878 to 7943. The genuinely unreadable one —
 * the crumpled thermal photograph on a wooden table, where OCR finds zero of
 * two line items — scores 637. 750 sits between those with room either side,
 * and rejects nothing that reads correctly across all 31 images.
 *
 * WHAT IT CANNOT DO, stated so nobody expects more of it. The corpus's other
 * badly-read photograph scores 1076, ABOVE the cleanest-reading blurred image
 * at 878, so no sharpness threshold can catch it without also flagging a
 * photograph that reads perfectly. Blur is one reason a receipt is hard to
 * read and this measures only that one. It is a hint, not a gate — which is
 * also why nothing here rejects an upload.
 */
export const SHARPNESS_FLOOR = 750;

/**
 * A 3x3 Laplacian. Convolving with this leaves flat regions near zero and
 * edges far from it, so the VARIANCE of the result is high for a sharp image
 * and collapses toward zero as detail is smeared away.
 */
function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  // The border is skipped rather than padded: a padded edge invents intensity
  // transitions that are not in the photograph, and would inflate sharpness on
  // exactly the blurry images this needs to catch.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = 4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      sum += value;
      sumSquares += value * value;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/**
 * Measures a photograph. Never throws — a file sharp cannot decode is a
 * problem for the upload path to report, and null means "not measured" so a
 * caller stays silent rather than guessing.
 */
export async function assessImageQuality(buffer: Buffer): Promise<ImageQuality | null> {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize({ width: ANALYSIS_WIDTH, withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const gray = new Uint8Array(data.buffer, data.byteOffset, data.length);

    let total = 0;
    for (let i = 0; i < gray.length; i++) total += gray[i]!;

    const sharpness = laplacianVariance(gray, info.width, info.height);

    /*
     * Dimensions come from a SECOND read of the metadata, not from `info`
     * above — `info` describes the 400px analysis copy, which would report
     * every photograph ever taken as too small. `.rotate()` is applied the
     * same way so a portrait photo carrying EXIF orientation reports the
     * edges it will actually be read at rather than the ones it was stored
     * at, which are swapped.
     */
    const meta = await sharp(buffer).rotate().metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    return {
      sharpness,
      brightness: total / gray.length,
      tooBlurredToTrust: sharpness < SHARPNESS_FLOOR,
      width,
      height,
      // The SHORT edge, because that is the one carrying character width. A
      // long thin crop of a receipt is a normal thing to upload and is not
      // unreadable for being tall.
      tooSmallToRead: width > 0 && height > 0 && Math.min(width, height) < MIN_READABLE_EDGE,
    };
  } catch (err) {
    logger.error({ err }, "Could not assess receipt image quality");
    return null;
  }
}

/*
 * A NOTE ON GLARE, so it is not attempted again the same way.
 *
 * A first version counted pixels at or above intensity 250 and called that
 * glare. Measured across the corpus it was meaningless: images that read
 * perfectly averaged 79.7% "glare", because a receipt is mostly white paper
 * and white paper is exactly what that counts. The metric was measuring the
 * subject, not a defect.
 *
 * Real glare is a bright REGION where the print is lost — a local property, so
 * detecting it needs local statistics (a bright area whose local variance has
 * collapsed), not a global histogram. That is worth building, but only against
 * photographs that actually have glare on them, and the corpus has none.
 */
