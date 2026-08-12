import sharp from "sharp";
import { logger } from "../config/logger";

/**
 * Where the receipt is inside a photograph, as four corners.
 *
 * WHY THIS RUNS ON THE SERVER. Detecting edges on the phone means one of:
 * a React Native document-scanner library, a custom Expo native module, or
 * OpenCV — and every one of those needs a development build, because none of
 * them exists in Expo Go. That is the same cost that ruled out on-device OCR
 * (see mobile ScanReceiptScreen's header note), and paying it here would buy
 * a capability the pipeline can get from a machine that already has `sharp`
 * loaded and is already being asked about this photograph's readability on
 * the same shutter press.
 *
 * So: the phone posts the image to a cheap endpoint that runs no OCR, writes
 * no row and stores no file, and gets back four corners and a confidence. The
 * crop editor uses them as a STARTING POSITION for handles the owner drags.
 * Nothing here decides anything.
 *
 * WHAT THIS IS NOT. It is not perspective correction — the corners describe a
 * quadrilateral, but the mobile crop that consumes them is axis-aligned,
 * because expo-image-manipulator cannot resample through a homography. It is
 * also not real-time: it runs once, after the shutter, on a still.
 */

/**
 * Detection runs on a downscaled copy for the same reason the quality check
 * does: a receipt's outline is a property of the image at any scale, and 320px
 * turns a multi-megapixel decode into about 100k values. Corners come back as
 * FRACTIONS of the image rather than pixels of this copy, so the client can
 * apply them to the full-resolution original without knowing this number.
 */
const ANALYSIS_WIDTH = 320;

export interface Point {
  /** 0-1, a fraction of the image's width. */
  x: number;
  /** 0-1, a fraction of the image's height. */
  y: number;
}

export interface DetectedCorners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export interface EdgeDetectionResult {
  /** Null when nothing receipt-shaped was found. Never an error. */
  corners: DetectedCorners | null;
  /**
   * 0-1. The client preselects the corners above a floor it owns
   * (`EDGE_CONFIDENCE_FLOOR` in mobile/src/lib/receiptCapture.ts) and falls
   * back to default handles below it. Deliberately a number rather than a
   * boolean: where the cut-off belongs is a UI decision, and hard-coding it
   * here would make it one this file could not see the consequences of.
   */
  confidence: number;
}

const NOT_FOUND: EdgeDetectionResult = { corners: null, confidence: 0 };

/**
 * Otsu's method: the intensity that best splits a histogram into two classes.
 *
 * A FIXED threshold cannot work here. The same receipt photographed on a dark
 * counter and on a white table has its paper at completely different
 * intensities, and the thing that stays true across both is that the image
 * contains two populations — paper and everything else. Otsu finds the split
 * between them by maximising between-class variance, which needs no
 * calibration against a corpus this project does not have.
 */
function otsuThreshold(histogram: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * The largest connected run of "paper" pixels.
 *
 * Iterative flood fill over an explicit stack rather than recursion: a bright
 * region on a 320px-wide image can run to tens of thousands of pixels, and a
 * recursive fill on that blows the call stack — a crash, on the request path,
 * for a photograph that is merely large and well-lit.
 *
 * Four-connectivity rather than eight, because a receipt is a solid sheet.
 * Eight-connectivity bridges regions that touch only at a corner, which on a
 * cluttered counter is how the paper and a bright coin beside it become one
 * "receipt" whose bounding quad covers both.
 */
function largestComponent(mask: Uint8Array, width: number, height: number): number[] | null {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let best: number[] | null = null;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;

    const component: number[] = [];
    stack.push(start);
    seen[start] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      component.push(index);
      const x = index % width;
      const y = (index / width) | 0;

      if (x > 0 && mask[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && mask[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && mask[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }

    if (best === null || component.length > best.length) best = component;
  }

  return best;
}

/**
 * The four extreme points of a blob, by the standard sum/difference trick.
 *
 * For any convex-ish region, the pixel minimising (x + y) is its top-left and
 * the one maximising it is its bottom-right; (x - y) picks out the other
 * diagonal. It is one pass and needs no convex hull, which matters because
 * this runs on the request path beside a readability check the owner is
 * waiting on.
 *
 * It is also why a NON-convex blob degrades gracefully rather than wrongly: a
 * receipt with a torn corner still yields four extremes that bound it, and
 * the rectangularity score below is what notices when the blob was not
 * receipt-shaped to begin with.
 */
function extremeCorners(component: number[], width: number) {
  let tl = component[0]!;
  let br = component[0]!;
  let tr = component[0]!;
  let bl = component[0]!;

  const sum = (i: number) => (i % width) + ((i / width) | 0);
  const diff = (i: number) => (i % width) - ((i / width) | 0);

  for (const index of component) {
    if (sum(index) < sum(tl)) tl = index;
    if (sum(index) > sum(br)) br = index;
    if (diff(index) > diff(tr)) tr = index;
    if (diff(index) < diff(bl)) bl = index;
  }

  const point = (i: number) => ({ x: i % width, y: (i / width) | 0 });
  return { tl: point(tl), tr: point(tr), br: point(br), bl: point(bl) };
}

/** Shoelace area of the quadrilateral, used to score how solid the find is. */
function quadArea(q: { tl: { x: number; y: number }; tr: { x: number; y: number }; br: { x: number; y: number }; bl: { x: number; y: number } }): number {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * The smallest share of the frame a blob may occupy and still be called the
 * receipt.
 *
 * A receipt someone has framed to photograph fills most of the picture. A
 * bright patch covering under a twelfth of it is a reflection, a tile, or a
 * coin — and proposing corners around one of those would put the crop editor's
 * handles somewhere actively misleading, which is worse than leaving them at
 * their sensible default.
 */
const MIN_AREA_FRACTION = 1 / 12;

/**
 * The largest share of the frame a blob may occupy and still be a receipt.
 *
 * Above this the mask has flooded rather than found anything — see
 * `scorePolarity`. A receipt photographed to fill the picture still leaves
 * some counter visible at its edges; a region with 92% of the frame has
 * swallowed those edges too, which means it has no edges to report.
 */
const MAX_AREA_FRACTION = 0.92;

/**
 * Scores one reading of the image: "the receipt is the bright region", or
 * "the receipt is the dark region".
 *
 * Returns null when this polarity finds nothing worth calling a receipt.
 */
function scorePolarity(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  paperIsBright: boolean,
): { quad: ReturnType<typeof extremeCorners>; confidence: number } | null {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const bright = gray[i]! > threshold;
    mask[i] = bright === paperIsBright ? 1 : 0;
  }

  const component = largestComponent(mask, width, height);
  if (!component) return null;

  const areaFraction = component.length / (width * height);
  if (areaFraction < MIN_AREA_FRACTION) return null;
  /*
   * A blob covering essentially the whole frame is not a receipt someone
   * framed — it is the mask having flooded, which is what happens on a white
   * receipt against a white table, or to the DARK reading of any ordinary
   * photograph where the background is simply everything.
   *
   * Rejected outright rather than scored low. Both produce the same client
   * behaviour (below the preselect floor, fall back to manual handles), but
   * returning corners around the entire photograph dresses "I could not tell"
   * up as an answer — and it is the kind of answer a later change might be
   * tempted to trust.
   */
  if (areaFraction > MAX_AREA_FRACTION) return null;

  const quad = extremeCorners(component, width);
  const area = quadArea(quad);
  if (area <= 0) return null;

  /*
   * CONFIDENCE, and what each term is actually asking.
   *
   * `fill` — how much of the quadrilateral the blob really occupies. A
   * receipt fills its own corners; an L-shaped smear of highlights spanning
   * the frame does not, and this is the term that catches it.
   *
   * `coverage` — how much of the FRAME the blob takes. A receipt someone
   * meant to photograph fills a good share of the picture; something well
   * under that is a reflection or a coin. The flooded end is not scored here
   * at all — it is rejected above, because it is not a weak answer but the
   * absence of one.
   *
   * Multiplied rather than averaged: both have to hold. An average lets one
   * strong term carry a weak one, and the whole point of the number is that
   * the client can refuse to preselect on it.
   *
   * FILL IS SQUARED, and that is not a fudge factor. The competing reading of
   * any ordinary photograph is its BACKGROUND — a ring with the receipt
   * punched out of it — whose extreme points are the frame's own corners. It
   * covers a healthy share of the picture, so `coverage` rewards it, and
   * measured on the fixtures it landed at 0.55-0.57: over the client's
   * preselect floor, meaning the crop editor would have opened with handles
   * around the whole photograph and called it the receipt.
   *
   * Fill is the term that actually tells those apart — a solid sheet fills
   * its own bounding quad (1.0), a ring fills about 0.58 of one. Squaring
   * leaves a genuine receipt untouched and collapses the ring to 0.33, which
   * is the separation the raw product did not give.
   */
  const fill = Math.min(1, component.length / area);
  const coverage = Math.min(1, areaFraction / 0.6);

  return { quad, confidence: Math.max(0, Math.min(1, fill * fill * coverage)) };
}

export async function detectReceiptCorners(buffer: Buffer): Promise<EdgeDetectionResult> {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize({ width: ANALYSIS_WIDTH, withoutEnlargement: true })
      .grayscale()
      /*
       * A blur before thresholding, which is standard and load-bearing — and
       * the SIZE of it is load-bearing too.
       *
       * A receipt is fine dark text on white. Threshold it raw and every line
       * of print becomes its own gap in the mask: the sheet stops being one
       * connected region and shatters into stripes, none of them big enough
       * to be the subject. Measured on a printed fixture at this analysis
       * size, sigma 1.5 left the sheet fragmented (it filled only 78% of its
       * own bounding quad, and the background outscored it); 2.5 merged the
       * print completely, and the sheet came back whole at fill 1.0.
       *
       * 3 is that, with margin for finer print than the fixture's. Going much
       * further starts to round the sheet's own edge — which is the one
       * boundary this exists to find — for no further gain.
       */
      .blur(3)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    if (width < 16 || height < 16) return NOT_FOUND;

    const gray = new Uint8Array(data.buffer, data.byteOffset, data.length);

    const histogram = new Array<number>(256).fill(0);
    for (let i = 0; i < gray.length; i++) histogram[gray[i]!]!++;
    const threshold = otsuThreshold(histogram, gray.length);

    /*
     * BOTH POLARITIES ARE TRIED, and the better-scoring one wins.
     *
     * The obvious assumption is that paper is the bright class — a thermal
     * receipt is near-white and a counter is darker. It holds most of the
     * time and it is what this did at first. But a receipt photographed on a
     * pale table, or a faded slip in shadow, inverts it, and assuming one
     * polarity meant confidently proposing corners around the TABLE in
     * exactly the situation where the owner most needed help cropping.
     *
     * Scoring both costs one more pass over a 320px image — a fraction of a
     * millisecond — and the score already measures the thing that decides
     * which is right: a blob that fills its own corners without flooding the
     * frame. Where neither reading manages that, both come back weak and the
     * client falls back to manual handles, which remains the correct answer.
     */
    const bright = scorePolarity(gray, width, height, threshold, true);
    const dark = scorePolarity(gray, width, height, threshold, false);

    const best = !bright ? dark : !dark ? bright : bright.confidence >= dark.confidence ? bright : dark;
    if (!best) return NOT_FOUND;

    const { quad, confidence } = best;
    return {
      corners: {
        topLeft: { x: quad.tl.x / width, y: quad.tl.y / height },
        topRight: { x: quad.tr.x / width, y: quad.tr.y / height },
        bottomRight: { x: quad.br.x / width, y: quad.br.y / height },
        bottomLeft: { x: quad.bl.x / width, y: quad.bl.y / height },
      },
      confidence,
    };
  } catch (err) {
    // Same contract as assessImageQuality: never throw. A file sharp cannot
    // decode is the upload path's problem to report, and "no corners" leaves
    // the crop editor exactly where it starts anyway.
    logger.error({ err }, "Could not detect receipt edges");
    return NOT_FOUND;
  }
}
