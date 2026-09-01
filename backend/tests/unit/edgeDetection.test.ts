import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { detectReceiptCorners } from "../../src/lib/edgeDetection";

/**
 * Built from generated images, like imageQuality.test.ts and for the same
 * reason: the real corpus is gitignored because some of it is real receipts,
 * and a suite that needs it does not run anywhere.
 *
 * What these assert is the RELATIONSHIP the crop editor depends on — a bright
 * sheet on a dark counter yields corners near its actual edges and a
 * confidence above the client's preselect floor; anything the detector cannot
 * genuinely find yields a confidence below it. Absolute corner pixels are not
 * asserted, because they would pin the test to one version of sharp's
 * resampling rather than to the behaviour the feature needs.
 */

/** The client's own cut-off, mirrored — mobile/src/lib/receiptCapture.ts. */
const EDGE_CONFIDENCE_FLOOR = 0.55;

/**
 * A bright rectangle on a dark ground: a receipt on a counter, reduced to the
 * only property the detector actually uses.
 */
async function receiptOnDarkCounter(): Promise<Buffer> {
  const width = 600;
  const height = 800;
  const pixels = Buffer.alloc(width * height, 35);
  for (let y = 150; y < 650; y++) {
    pixels.fill(240, y * width + 100, y * width + 500);
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

describe("detectReceiptCorners", () => {
  it("finds a receipt against a dark background, confidently enough to preselect", async () => {
    const result = await detectReceiptCorners(await receiptOnDarkCounter());

    expect(result.corners).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(EDGE_CONFIDENCE_FLOOR);
  });

  it("returns corners as fractions of the image, near the sheet's real edges", async () => {
    const { corners } = await detectReceiptCorners(await receiptOnDarkCounter());
    expect(corners).not.toBeNull();

    // The sheet spans x 100-500 of 600 and y 150-650 of 800, so 0.167-0.833
    // and 0.188-0.813. Generous tolerance: detection runs on a 320px-wide
    // downscale, and a pixel there is three of the original.
    expect(corners!.topLeft.x).toBeCloseTo(0.167, 1);
    expect(corners!.topLeft.y).toBeCloseTo(0.188, 1);
    expect(corners!.bottomRight.x).toBeCloseTo(0.833, 1);
    expect(corners!.bottomRight.y).toBeCloseTo(0.813, 1);
  });

  it("keeps every corner inside the image", async () => {
    const { corners } = await detectReceiptCorners(await receiptOnDarkCounter());
    for (const point of Object.values(corners!)) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  /**
   * THE FAILURE THAT MATTERS, and the reason confidence is a number rather
   * than a boolean. A white receipt on a white table gives Otsu nothing to
   * split, the mask floods the frame, and the extreme points come back as the
   * frame's own corners — a confident-looking answer that is really "I could
   * not tell". The coverage term is what collapses the score there, so the
   * client falls back to default handles instead of preselecting a crop
   * around the whole photograph.
   */
  it("is not confident when the mask floods, as on a white-on-white shot", async () => {
    const flat = await sharp(Buffer.alloc(600 * 800, 250), {
      raw: { width: 600, height: 800, channels: 1 },
    })
      .png()
      .toBuffer();

    const result = await detectReceiptCorners(flat);
    expect(result.confidence).toBeLessThan(EDGE_CONFIDENCE_FLOOR);
  });

  it("finds nothing in a bright speck too small to be the subject", async () => {
    const width = 600;
    const height = 800;
    const pixels = Buffer.alloc(width * height, 30);
    // ~1.5% of the frame: a reflection or a coin, not a receipt.
    for (let y = 400; y < 470; y++) {
      pixels.fill(245, y * width + 300, y * width + 380);
    }
    const speck = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();

    const result = await detectReceiptCorners(speck);
    expect(result.corners).toBeNull();
    expect(result.confidence).toBe(0);
  });

  /**
   * Same contract as assessImageQuality: never throw. A file that cannot be
   * decoded is the upload path's problem to report, and "no corners" leaves
   * the crop editor exactly where it starts anyway.
   */
  it("answers rather than throwing on something that is not an image", async () => {
    const result = await detectReceiptCorners(Buffer.from("this is not an image"));
    expect(result).toEqual({ corners: null, confidence: 0 });
  });

  /**
   * THE CASE THAT MADE PRINT MATTER.
   *
   * A real receipt is not a blank rectangle — it is fine dark text on white.
   * Thresholded raw, every character becomes a hole and the sheet stops being
   * one connected region, so the largest component ends up being a margin
   * rather than the receipt. The blur before thresholding is what merges the
   * print back into the paper without moving the sheet's own edge.
   */
  it("finds a printed receipt, not just a blank rectangle", async () => {
    const width = 600;
    const height = 800;
    const pixels = Buffer.alloc(width * height, 35);
    for (let y = 150; y < 650; y++) {
      pixels.fill(240, y * width + 100, y * width + 500);
    }
    // Text-like bars across the sheet, the same shape imageQuality's fixture
    // uses — this is what fragments the mask without a blur.
    for (let y = 170; y < 630; y += 16) {
      for (let row = 0; row < 5; row++) {
        pixels.fill(25, (y + row) * width + 120, (y + row) * width + 480);
      }
    }
    const printed = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();

    const result = await detectReceiptCorners(printed);
    expect(result.confidence).toBeGreaterThan(EDGE_CONFIDENCE_FLOOR);
    expect(result.corners!.topLeft.x).toBeCloseTo(0.167, 1);
    expect(result.corners!.bottomRight.y).toBeCloseTo(0.813, 1);
  });

  /**
   * THE REGRESSION THIS ALMOST SHIPPED WITH.
   *
   * The strongest competing reading of any ordinary photograph is its
   * BACKGROUND — a ring with the receipt punched out of it, whose extreme
   * points are the frame's own corners. It covers a healthy share of the
   * picture, so it scored 0.55-0.57: just over the preselect floor. The crop
   * editor would have opened with handles around the entire photograph and
   * presented that as the detected receipt.
   *
   * Squaring `fill` is what separates them, so this asserts the property
   * directly rather than only checking the winner: whatever is returned must
   * not be the whole frame.
   */
  it("never proposes the background ring as the receipt", async () => {
    const { corners } = await detectReceiptCorners(await receiptOnDarkCounter());
    // The frame's own corners would be 0,0 → 1,1. The receipt's are inset.
    expect(corners!.topLeft.x).toBeGreaterThan(0.05);
    expect(corners!.topLeft.y).toBeGreaterThan(0.05);
    expect(corners!.bottomRight.x).toBeLessThan(0.95);
    expect(corners!.bottomRight.y).toBeLessThan(0.95);
  });

  /**
   * THE ASSUMPTION THAT NEEDED BOTH DIRECTIONS.
   *
   * "Paper is the bright class" holds most of the time — a thermal receipt on
   * a counter — and assuming it was what this did at first. A receipt on a
   * pale table inverts it, and a single-polarity detector would confidently
   * propose corners around the TABLE, in exactly the situation where the
   * owner most needs help cropping. Both readings are scored; the better one
   * wins.
   */
  it("finds a dark receipt on a pale table", async () => {
    const width = 600;
    const height = 800;
    const pixels = Buffer.alloc(width * height, 235);
    for (let y = 150; y < 650; y++) {
      pixels.fill(60, y * width + 100, y * width + 500);
    }
    const inverted = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();

    const result = await detectReceiptCorners(inverted);
    expect(result.confidence).toBeGreaterThan(EDGE_CONFIDENCE_FLOOR);
    expect(result.corners!.topLeft.x).toBeCloseTo(0.167, 1);
    expect(result.corners!.topLeft.y).toBeCloseTo(0.188, 1);
    expect(result.corners!.bottomRight.x).toBeCloseTo(0.833, 1);
  });

  it("returns distinct candidates when two receipts share one photograph", async () => {
    const width = 900;
    const height = 700;
    const pixels = Buffer.alloc(width * height, 30);
    for (let y = 100; y < 600; y++) {
      pixels.fill(240, y * width + 60, y * width + 380);
      pixels.fill(240, y * width + 520, y * width + 840);
    }
    const image = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const result = await detectReceiptCorners(image);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates![0]!.corners.topLeft.x).not.toBeCloseTo(
      result.candidates![1]!.corners.topLeft.x,
      1,
    );
  });
});
