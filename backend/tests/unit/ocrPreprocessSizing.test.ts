import { describe, expect, it } from "vitest";
import { ocrResizeOptions } from "../../src/services/ocr.service";

/*
 * Which edge the OCR downscale caps. The cap exists to bound cost, and the
 * edge it is applied to is what decides how many pixels a printed character
 * keeps — capping the wrong one on a sideways long receipt squeezes forty
 * lines of print into a few hundred pixels of height.
 */
describe("OCR downscale target", () => {
  it.each([
    [3024, 4032],
    [1064, 589],
    [1200, 12000],
    [2000, 2000],
  ])("caps the width of an ordinary or portrait image %ix%i", (width, height) => {
    expect(ocrResizeOptions(width, height)).toEqual({ width: 2000, withoutEnlargement: true });
  });

  it.each([
    [12000, 1800],
    [16000, 2048],
    [6000, 2000],
  ])("caps the height of an elongated landscape panorama %ix%i", (width, height) => {
    expect(ocrResizeOptions(width, height)).toEqual({ height: 2000, withoutEnlargement: true });
  });

  it("falls back to the width cap when dimensions are unknown", () => {
    expect(ocrResizeOptions(undefined, undefined)).toEqual({ width: 2000, withoutEnlargement: true });
    expect(ocrResizeOptions(1200, undefined)).toEqual({ width: 2000, withoutEnlargement: true });
  });

  it("switches edges exactly at the elongation ratio", () => {
    expect(ocrResizeOptions(2999, 1000)).toEqual({ width: 2000, withoutEnlargement: true });
    expect(ocrResizeOptions(3000, 1000)).toEqual({ height: 2000, withoutEnlargement: true });
  });

  it("changes nothing for the accuracy corpus's small landscape images", () => {
    // Several corpus images (e.g. 1064x324) are elongated landscape, so they
    // take the new branch — but both caps are above their own edges and
    // `withoutEnlargement` means neither resizes them at all. Pinned so the
    // corpus cannot be silently re-scaled by a later change to either cap.
    for (const [width, height] of [[1064, 324], [1086, 403], [1064, 329]] as const) {
      const options = ocrResizeOptions(width, height);
      const cap = "width" in options ? options.width : options.height;
      expect(cap).toBeGreaterThan(Math.max(width, height));
    }
  });
});
