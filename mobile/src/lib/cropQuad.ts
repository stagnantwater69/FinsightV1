/**
 * Whether the four corners the owner has dragged form a crop the server will
 * actually accept — checked here, on the phone, while they are still dragging.
 *
 * WHY THIS EXISTS. `POST /records/receipts/transform` validates the quad in
 * `backend/src/lib/receiptPerspective.ts` (`validatePerspectiveCorners`) and
 * answers 400 when it is concave, self-crossing, wound the wrong way, has two
 * corners sitting on top of each other, or encloses almost nothing. Until this
 * module existed the crop editor let every one of those be built, uploaded the
 * whole original photograph, and only then told the owner — over mobile data,
 * in the shop, with the receipt still in their hand.
 *
 * THIS IS A MIRROR, NOT A SECOND OPINION. The thresholds and the winding test
 * below are the server's, copied deliberately so this cannot reject a quad the
 * server would have accepted (which would be the worse failure: an Apply button
 * that refuses work the backend was happy to do). The server remains the
 * authority — nothing here is a security control, and `applyCrop` still handles
 * a 400. If `validatePerspectiveCorners` changes, this must change with it;
 * tests/cropQuad.test.ts pins the shared numbers.
 *
 * No React and no react-native imports, for the same reason as receiptCapture.ts:
 * the camera itself has no render harness, so the geometry has to live where
 * vitest can reach it.
 */
import type { Corners, Point } from "./receiptCapture";

/**
 * The server's own figures, from `validatePerspectiveCorners`:
 *
 *   - every edge must be at least 8px long in ORIGINAL image pixels;
 *   - the shoelace area must be at least 64px²;
 *   - each turn must wind positively (clockwise in screen coordinates, where y
 *     grows downwards) by more than 1e-6, which is what rejects concave and
 *     self-crossing quads as well as an anticlockwise one.
 */
export const MIN_CROP_EDGE_PX = 8;
export const MIN_CROP_AREA_PX = 64;
export const CROP_WINDING_EPSILON = 1e-6;

/** Corner order matches the server's `points` array exactly. */
const ORDER = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

export type CropQuadProblem =
  /** A corner has been dragged outside the photograph, or is not a number. */
  | "outside-image"
  /** Concave, self-crossing, or dragged past a neighbour. */
  | "not-convex"
  /** Two corners are effectively on the same spot. */
  | "edge-too-short"
  /** A valid shape, but enclosing next to nothing. */
  | "area-too-small";

export function cropQuadPoints(corners: Corners): Point[] {
  return ORDER.map((key) => corners[key]);
}

/**
 * What is wrong with this quad, or null when the server would accept it.
 *
 * `width`/`height` are the ORIGINAL image's dimensions — the same pair
 * `applyCrop` sends the corners against, not the on-screen preview's.
 */
export function cropQuadProblem(corners: Corners, width: number, height: number): CropQuadProblem | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "outside-image";
  const points = cropQuadPoints(corners);
  if (points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > width || p.y > height)) {
    return "outside-image";
  }
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i]!, b = points[(i + 1) % 4]!, c = points[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross <= CROP_WINDING_EPSILON) return "not-convex";
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_CROP_EDGE_PX) return "edge-too-short";
    area += a.x * b.y - b.x * a.y;
  }
  if (area / 2 < MIN_CROP_AREA_PX) return "area-too-small";
  return null;
}

/**
 * The same in one sentence an owner can act on.
 *
 * Deliberately says what to do with the corners rather than naming the
 * geometry — "convex", "clockwise winding" and "self-intersecting" describe
 * the quad this code built, not anything the person holding the phone did.
 */
export function cropQuadHint(problem: CropQuadProblem): string {
  switch (problem) {
    case "outside-image":
      return "Keep all four corners inside the photo.";
    case "not-convex":
      return "The corners have crossed over each other. Put one on each corner of the receipt — top left, top right, bottom right, bottom left.";
    case "edge-too-short":
      return "Two corners are almost in the same place. Drag them apart to the edges of the receipt.";
    case "area-too-small":
      return "That selection is too small to read. Cover the whole receipt, including the total.";
  }
}

/** Convenience for the editor: the hint to show, or null when Apply may run. */
export function cropQuadIssue(corners: Corners, width: number, height: number): string | null {
  const problem = cropQuadProblem(corners, width, height);
  return problem ? cropQuadHint(problem) : null;
}

/** What the owner is told when the crop itself was refused. */
export const CROP_RETRY_MESSAGE =
  "That crop could not be applied. Drag the four corners back onto the edges of the receipt and try again, or use the original photo.";

/**
 * Turns a /transform failure into owner language.
 *
 * WHY IT IS NOT JUST `e.message`. The 400s that endpoint can answer include
 * sentences written for whoever built the client — "Crop corners must form a
 * clockwise convex receipt with distinct corners" — and showing that to a shop
 * owner names a property of a polygon rather than a thing to do. The geometry
 * cases are now caught locally before the upload, so a 400 that still arrives
 * is either drift between this mirror and the server or a photo the server
 * could not use; both are best answered with "put the corners back and try
 * again, or keep the original".
 *
 * NOT every 400, though: the same endpoint answers one about a photograph
 * being too large to straighten, which names the megapixels and the setting to
 * change. That is already owner language and more useful than anything this
 * could substitute, so only the geometry wording is replaced.
 */
const GEOMETRY_REFUSAL = /corner|convex|clockwise|winding|area/i;

export function transformFailureMessage(status: number | undefined, serverMessage?: string): string {
  const message = serverMessage?.trim();
  if (status === 400) {
    if (!message || GEOMETRY_REFUSAL.test(message)) return CROP_RETRY_MESSAGE;
    return message;
  }
  return message || CROP_RETRY_MESSAGE;
}
