import { describe, expect, it } from "vitest";
import { cropArtToBox, FAB_ART_BOUNDS, GREETING_ART_BOUNDS, type ArtBounds } from "../src/lib/artCrop";

/**
 * The mascot assets are square PNGs with the character floating in a wide
 * margin. The components draw them oversized and clip them, which only looks
 * right if the size and offsets are derived from where the art actually sits.
 *
 * The bug this guards is quiet: get the scale wrong by a few percent and the
 * owl's feet are shaved off by the bottom of its box, which nobody notices in
 * a diff and everybody notices on a phone.
 */

/** Where the art lands inside the box, given a crop result. */
function renderedArtBox(bounds: ArtBounds, boxSize: number, fill = 1) {
  const { imageSize, marginLeft, marginTop } = cropArtToBox(bounds, boxSize, fill);
  return {
    left: marginLeft + bounds.left * imageSize,
    right: marginLeft + bounds.right * imageSize,
    top: marginTop + bounds.top * imageSize,
    bottom: marginTop + bounds.bottom * imageSize,
  };
}

describe("cropArtToBox", () => {
  it("centres the artwork in the box", () => {
    const box = renderedArtBox(GREETING_ART_BOUNDS, 92);
    expect((box.left + box.right) / 2).toBeCloseTo(46, 6);
    expect((box.top + box.bottom) / 2).toBeCloseTo(46, 6);
  });

  it("keeps the whole of the greeting mascot inside its box", () => {
    const box = renderedArtBox(GREETING_ART_BOUNDS, 92);
    // The regression: scaling by width alone put the bottom past 92 and cut
    // the owl's feet off.
    expect(box.left).toBeGreaterThanOrEqual(-0.001);
    expect(box.top).toBeGreaterThanOrEqual(-0.001);
    expect(box.right).toBeLessThanOrEqual(92.001);
    expect(box.bottom).toBeLessThanOrEqual(92.001);
  });

  it("keeps the whole of the FAB mascot inside its circle, inset by the fill factor", () => {
    const box = renderedArtBox(FAB_ART_BOUNDS, 60, 0.92);
    expect(box.left).toBeGreaterThanOrEqual(-0.001);
    expect(box.top).toBeGreaterThanOrEqual(-0.001);
    expect(box.right).toBeLessThanOrEqual(60.001);
    expect(box.bottom).toBeLessThanOrEqual(60.001);
  });

  it("scales the art to fill the box on its longer side", () => {
    // A square subject filling half its canvas must be drawn at twice the box.
    const half: ArtBounds = { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
    expect(cropArtToBox(half, 100).imageSize).toBeCloseTo(200, 6);
  });

  it("insets by the fill factor", () => {
    const half: ArtBounds = { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
    const box = renderedArtBox(half, 100, 0.5);
    expect(box.right - box.left).toBeCloseTo(50, 6);
  });

  it("corrects for art that is off-centre in its canvas", () => {
    // Art hugging the left edge still ends up centred in the box.
    const offset: ArtBounds = { left: 0, top: 0.25, right: 0.5, bottom: 0.75 };
    const box = renderedArtBox(offset, 100);
    expect((box.left + box.right) / 2).toBeCloseTo(50, 6);
  });
});
