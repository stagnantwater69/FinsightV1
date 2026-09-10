import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { ocrResizeOptions, orientedDimensions, preprocessReceiptImage } from "../../src/services/ocr.service";

/*
 * WHICH DIMENSIONS THE OCR DOWNSCALE DECIDES ON.
 *
 * `ocrPreprocessSizing.test.ts` pins the pure choice of cap given a width and a
 * height. That test passes whether the width and height handed to it are the
 * stored ones or the EXIF-oriented ones, so it cannot catch the defect these
 * cover: `sharp(buffer).rotate().metadata()` reports the RAW STORED size, and
 * feeding that to `ocrResizeOptions` picks the cap for an image that `.rotate()`
 * is about to transpose.
 *
 * Both directions are checked, because the two failures are different and only
 * one of them is old:
 *   - stored portrait, DISPLAYED landscape — the long-receipt-lying-sideways
 *     case the elongation branch was written for. Reading stored dimensions
 *     takes the width cap and squeezes the print to a few hundred pixels of
 *     height, i.e. the branch never fires for the images that need it.
 *   - stored landscape, DISPLAYED portrait — a regression the branch
 *     introduced. Reading stored dimensions takes the HEIGHT cap and squeezes
 *     an ordinary tall receipt sideways, on an image that was previously not
 *     resized at all.
 *
 * The image is generated rather than taken from the accuracy corpus on purpose:
 * no corpus image carries an orientation flag, which is exactly why the corpus
 * cannot demonstrate this.
 */

const ORIENTATION_TRANSPOSED = 6; // rotate 90° clockwise on display

async function taggedJpeg(width: number, height: number, orientation: number) {
  return sharp({ create: { width, height, channels: 3, background: "white" } })
    .jpeg()
    .withMetadata({ orientation })
    .toBuffer();
}

describe("EXIF orientation and the OCR downscale", () => {
  it("swaps the axes for the transposed orientations and leaves the others alone", () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(orientedDimensions({ width: 900, height: 3000, orientation })).toEqual({ width: 900, height: 3000 });
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(orientedDimensions({ width: 900, height: 3000, orientation })).toEqual({ width: 3000, height: 900 });
    }
    // No flag at all is the overwhelmingly common case and must behave as before.
    expect(orientedDimensions({ width: 900, height: 3000 })).toEqual({ width: 900, height: 3000 });
    expect(orientedDimensions({ orientation: 6 })).toEqual({ width: undefined, height: undefined });
  });

  it("reads the oriented size from the header, which .rotate() does not provide", async () => {
    const image = await taggedJpeg(900, 3000, ORIENTATION_TRANSPOSED);
    const chained = await sharp(image).rotate().metadata();
    // The defect itself, pinned: chaining .rotate() changes nothing here.
    expect({ width: chained.width, height: chained.height }).toEqual({ width: 900, height: 3000 });
    expect(orientedDimensions(chained)).toEqual({ width: 3000, height: 900 });
  });

  it("does not squeeze a long receipt stored portrait but displayed landscape", async () => {
    // Stored 900x3000 + orientation 6 => reads as 3000x900, an elongated
    // landscape panorama, whose short edge is already under the 2000 cap.
    const image = await taggedJpeg(900, 3000, ORIENTATION_TRANSPOSED);
    const out = await sharp(await preprocessReceiptImage(image)).metadata();
    expect({ width: out.width, height: out.height }).toEqual({ width: 3000, height: 900 });

    // What the stored dimensions would have chosen instead: the width cap, on
    // an image whose width is the long edge — 2000x600.
    expect(ocrResizeOptions(900, 3000)).toEqual({ width: 2000, withoutEnlargement: true });
    expect(ocrResizeOptions(3000, 900)).toEqual({ height: 2000, withoutEnlargement: true });
  });

  it("does not squeeze a receipt stored landscape but displayed portrait", async () => {
    // Stored 3000x900 + orientation 6 => reads as 900x3000, an ordinary tall
    // receipt. The stored ratio is 3.33, so the stored dimensions would take
    // the height cap and produce a 600x2000 image OCR cannot read.
    const image = await taggedJpeg(3000, 900, ORIENTATION_TRANSPOSED);
    const out = await sharp(await preprocessReceiptImage(image)).metadata();
    expect({ width: out.width, height: out.height }).toEqual({ width: 900, height: 3000 });
  });

  it("still caps an unflagged image exactly as before", async () => {
    const image = await taggedJpeg(3000, 900, 1);
    const out = await sharp(await preprocessReceiptImage(image)).metadata();
    // Elongated landscape with no flag: the height cap applies, and 900 is
    // already under it, so nothing is resized.
    expect({ width: out.width, height: out.height }).toEqual({ width: 3000, height: 900 });

    const portrait = await taggedJpeg(2400, 3200, 1);
    const portraitOut = await sharp(await preprocessReceiptImage(portrait)).metadata();
    expect({ width: portraitOut.width, height: portraitOut.height }).toEqual({ width: 2000, height: 2667 });
  });
});
