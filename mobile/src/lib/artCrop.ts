/**
 * Fitting a mascot PNG into a box when the artwork does not fill its canvas.
 *
 * WHY THIS EXISTS: assets/FAB.png is a square export with the character
 * floating in a margin around it — the head, glasses and question bubble
 * together occupy about 64% of the canvas width — and it does not sit exactly
 * at the canvas centre. Rendering it at its box size therefore draws a small,
 * visibly off-centre character surrounded by padding.
 *
 * The fix is to draw the image oversized and offset it into place, which
 * needs a size and two margins derived from where the art actually is. Doing
 * that arithmetic inline in the component is how it would drift out of sync
 * with the asset, so it lives here once and is unit-tested — the numbers are
 * measured from the file and cannot be checked by reading the component.
 *
 * `GREETING_ART_BOUNDS` no longer has a live caller — Home's greeting now
 * plays a sequence of pre-cropped, background-removed frames generated from
 * assets/animatedgreeting.mp4 (see lib/greetingFrames.ts), each already
 * square and centred, so nothing needs runtime crop math any more. It stays
 * exported and tested regardless: it is real, checked-in art measurement and
 * a second worked example for `cropArtToBox`, and greeting.png itself is
 * still in the repo. Deleting the bounds over a UI change that could easily
 * reverse would just mean re-measuring the file by hand a second time.
 */

/** Where the visible artwork sits inside its canvas, as fractions of the canvas (0-1). */
export interface ArtBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CropResult {
  /** Width and height to render the (square) image at. */
  imageSize: number;
  marginLeft: number;
  marginTop: number;
}

/**
 * Size and position a square image so its artwork is centred in `boxSize` and
 * scaled to fill it.
 *
 * Scales by the LARGER of the art's two dimensions, so the whole character
 * fits — scaling by width alone clips a portrait subject's feet, which is
 * exactly what it did before this was derived rather than eyeballed.
 *
 * `fill` insets the art from the box edge: 1 has it touch the sides, which is
 * right for a rectangular container and too tight for a circular one, where
 * the corners of the art would be cut by the radius.
 */
export function cropArtToBox(bounds: ArtBounds, boxSize: number, fill = 1): CropResult {
  const artWidth = bounds.right - bounds.left;
  const artHeight = bounds.bottom - bounds.top;
  const imageSize = (boxSize * fill) / Math.max(artWidth, artHeight);

  // The art's centre, as a fraction of the canvas — not assumed to be 0.5.
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;

  return {
    imageSize,
    marginLeft: boxSize / 2 - centerX * imageSize,
    marginTop: boxSize / 2 - centerY * imageSize,
  };
}

/**
 * Measured from the asset files themselves (non-background pixel bounds).
 * If either PNG is re-exported, re-measure — these cannot be inferred from
 * the image at runtime without decoding it.
 */
export const FAB_ART_BOUNDS: ArtBounds = {
  left: 420 / 2048,
  top: 504 / 2048,
  right: 1752 / 2048,
  bottom: 1552 / 2048,
};

export const GREETING_ART_BOUNDS: ArtBounds = {
  left: 196 / 1024,
  top: 148 / 1024,
  right: 928 / 1024,
  bottom: 892 / 1024,
};
