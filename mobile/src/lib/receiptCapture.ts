/**
 * The arithmetic behind the receipt camera, kept out of the components.
 *
 * WHY THIS IS A SEPARATE FILE. The camera screen is the one part of this app
 * that cannot be checked by running it: the mobile suite has no render
 * harness (73 tests, none mount a component — see
 * docs/multi-page-receipts-plan.md §8), so anything living inside
 * `ReceiptCamera.tsx` is verifiable only by hand on a physical Android phone.
 * Crop geometry, section limits and ordering are exactly the parts where a
 * quiet off-by-one produces a receipt cropped through its own total, so they
 * live here where vitest can reach them and the components stay as thin a
 * shell as the work allows.
 *
 * Nothing here imports React or react-native, deliberately — that is what
 * keeps it runnable under plain vitest with no native module shims.
 */

/**
 * How many photographs one receipt may be split into.
 *
 * MIRRORS `MAX_PAGES` in backend/src/services/receiptScan.service.ts, which
 * is the figure that actually decides — multer is configured with it and the
 * service rejects a ninth page with a 400. Duplicated rather than fetched
 * because a capture session has to know its own ceiling before it has spoken
 * to the server at all, and a camera that lets someone shoot nine sections
 * and only then says no has wasted the one thing this whole feature is about:
 * the owner standing there with the receipt in their hand.
 *
 * If the backend figure moves, this must move with it. The contract test in
 * tests/receiptCapture.test.ts pins the number so the two cannot drift
 * silently.
 */
export const MAX_SECTIONS = 8;

/**
 * JPEG compression for a captured section, 0-1.
 *
 * RAISED FROM 0.7, which is what the old `ImagePicker.launchCameraAsync` call
 * used. 0.7 was inherited from the profile-photo picker, where it is right —
 * an avatar is displayed at 72px and nobody reads it. A receipt is read by an
 * OCR engine at full resolution, and the detail 0.7 throws away is precisely
 * the thin thermal print that separates an 8 from a 6.
 *
 * Not 1.0: the difference between 0.9 and 1.0 on a photograph is visually
 * nil and costs roughly double the bytes, and these are uploaded from a phone
 * on mobile data, up to eight at a time. 0.9 is the point where the file
 * stops growing faster than the readability does.
 *
 * This is a starting value chosen on that reasoning, NOT a measured optimum —
 * there is no corpus of the same faint thermal receipt captured at several
 * compression levels to measure against. Say so rather than implying it was
 * tuned.
 */
export const CAPTURE_QUALITY = 0.9;

/**
 * How much of the previous section the owner is asked to re-photograph.
 *
 * The overlap exists so the server can tell that page 3 begins where page 2
 * ended; see the seam detection in backend/src/services/ocr.service.ts. It is
 * expressed as a FRACTION OF THE FRAME rather than a number of lines because
 * the camera has no idea how tall a line of print is.
 *
 * Guidance only. Nothing blocks a capture that ignores it — see
 * `overlapGuideHeight`'s caller.
 */
export const OVERLAP_TARGET = { min: 0.15, max: 0.25 } as const;

export interface Point {
  x: number;
  y: number;
}

/**
 * The four corners of the receipt within a captured photograph, in image
 * pixels — NOT screen points. Screen coordinates are a property of the phone
 * the photo was reviewed on; the crop has to survive being applied to the
 * original file.
 */
export interface Corners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

/** One photograph in a capture session, before the receipt is scanned. */
export interface ReceiptSection {
  /** Local only, for list keys — the server assigns nothing until upload. */
  localId: string;
  /** The photograph as captured, kept so a crop can always be undone. */
  originalUri: string;
  /** What will actually be uploaded: cropped and rotated, or the original. */
  processedUri: string;
  width: number;
  height: number;
  /** Where the owner (or edge detection) put the corners. Absent if uncropped. */
  cropCorners?: Corners;
  /**
   * How sure the edge detector was, 0-1, or undefined when it did not run or
   * could not answer. Never gates anything — see `shouldPreselectCorners`.
   */
  edgeConfidence?: number;
  /**
   * The readability reading taken while this was still a pending capture.
   *
   * Carried through rather than re-fetched once the section reaches the scan
   * screen: it is the same file and the same measurement, and asking the
   * server twice for one photograph would double the traffic of a session
   * whose whole point is being usable in a shop on mobile data. Null when the
   * check could not run, which is a missing nicety and never an error.
   */
  quality: SectionQuality | null;
}

/** What /records/receipts/quality-check answers about one photograph. */
export interface SectionQuality {
  sharpness: number;
  brightness: number;
  tooBlurredToTrust: boolean;
  /** Present since the dimension check was added; absent on older responses. */
  width?: number;
  height?: number;
  tooSmallToRead?: boolean;
}

/**
 * A rectangle in image pixels, as expo-image-manipulator's `crop` wants it.
 */
export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Where a `contain`-fitted image actually sits inside its box.
 *
 * Shared by the crop editor and the capture preview because both draw over a
 * photograph in IMAGE coordinates while the screen works in points, and the
 * two must agree exactly — an outline the preview draws around the receipt
 * and a crop the editor then cuts somewhere else is worse than not drawing
 * the outline at all.
 *
 * `contain` rather than `cover`: a preview that crops the photograph to fill
 * its box would hide the very edges the owner is being asked to check.
 */
export function fitImageInBox(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
): { scale: number; offsetX: number; offsetY: number; width: number; height: number } {
  // Guard the degenerate case rather than returning Infinity: a photograph
  // whose dimensions have not arrived yet would otherwise place every corner
  // handle at NaN, which React Native renders as a silently invisible view.
  if (imageWidth <= 0 || imageHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0, width: 0, height: 0 };
  }
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { scale, offsetX: (boxWidth - width) / 2, offsetY: (boxHeight - height) / 2, width, height };
}

/**
 * The capture guide's rectangle, in screen points.
 *
 * PROPORTIONAL, NOT FIXED. The first version used fixed insets — 132pt of
 * headroom, 188pt of footroom, 26pt at each side — chosen against one phone.
 * On a real device, inside a screen that still had a navigation header and a
 * tab bar eating into it, that left a small squarish box in the middle of a
 * tall preview: the frame implied the receipt had to fit in a quarter of the
 * screen, and a receipt is neither square nor small.
 *
 * Two things fix that. The camera is now genuinely full-screen, and this
 * scales with the screen instead of guessing at it.
 *
 * The floors matter as much as the fractions: the top strip has to clear the
 * status bar, the close button and two lines of instruction, and the bottom
 * has to clear the section strip and the shutter. Below those the chrome
 * would sit on top of the frame, so the fractions are allowed to grow the
 * margins on a big screen but never to shrink them past what the controls
 * need.
 */
export function guideRect(screenWidth: number, screenHeight: number) {
  const top = Math.max(112, screenHeight * 0.14);
  const bottom = Math.max(172, screenHeight * 0.21);
  // 4% a side, where it was a fixed 26pt. A receipt photographed in portrait
  // is nearly as wide as the frame, and margin that exists only to look tidy
  // is margin that makes someone step backwards and lose resolution.
  const side = screenWidth * 0.04;

  return {
    top,
    bottom,
    side,
    width: screenWidth - side * 2,
    height: Math.max(0, screenHeight - top - bottom),
  };
}

/** Keeps a dragged handle inside the photograph it belongs to. */
export function clampToImage(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(point.x, 0), width),
    y: Math.min(Math.max(point.y, 0), height),
  };
}

/**
 * Where the crop handles start when nothing better is known.
 *
 * Inset from the frame rather than flush with it, so all four handles are
 * visible and grabbable immediately — corners sitting exactly on the image
 * edge are half off-screen and are the first thing that makes a crop editor
 * feel broken. The inset also matches roughly where the capture guide sat, so
 * an owner who framed their receipt inside the guide finds the handles
 * already close to its edges.
 */
export function defaultCorners(width: number, height: number, inset = 0.06): Corners {
  const dx = width * inset;
  const dy = height * inset;
  return {
    topLeft: { x: dx, y: dy },
    topRight: { x: width - dx, y: dy },
    bottomRight: { x: width - dx, y: height - dy },
    bottomLeft: { x: dx, y: height - dy },
  };
}

/** The whole photograph, for the crop editor's "Reset" control. */
export function fullFrameCorners(width: number, height: number): Corners {
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: width, y: 0 },
    bottomRight: { x: width, y: height },
    bottomLeft: { x: 0, y: height },
  };
}

/**
 * The smallest crop worth applying, as a fraction of each axis.
 *
 * A crop below this is almost always a mis-drag rather than an intention —
 * two handles pulled together by accident — and applying it would hand OCR a
 * sliver of paper. `cornersToCropRect` refuses rather than clamping up to it,
 * because silently cropping somewhere the owner did not ask for is worse than
 * leaving the photograph alone.
 */
const MIN_CROP_FRACTION = 0.1;

/**
 * The axis-aligned rectangle a set of corners actually cuts.
 *
 * WHY A BOUNDING BOX AND NOT THE QUADRILATERAL ITSELF. Cutting along an
 * arbitrary quad is perspective correction, and doing it properly means
 * resampling the image through a homography — which expo-image-manipulator
 * cannot do (it offers crop, rotate, flip, resize) and which in Expo Go has
 * no native module available to do it either. The honest options were a
 * rectangle, or a dev-client migration for a capability the OCR pipeline has
 * never asked for. This returns the rectangle.
 *
 * The four handles are still four rather than two, and that is not decoration:
 * a receipt photographed slightly askew has its corners at four different
 * offsets, and letting the owner place all four means the bounding box lands
 * where the paper is instead of where a two-handle rectangle guessed. The
 * editor shades everything outside this rectangle so what is kept is never a
 * surprise.
 *
 * Returns null when the result would be degenerate or trivially small, which
 * the caller reads as "upload the original untouched".
 */
export function cornersToCropRect(corners: Corners, width: number, height: number): CropRect | null {
  const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomRight.x, corners.bottomLeft.x];
  const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomRight.y, corners.bottomLeft.y];

  // Rounded outward, so a crop never shaves a pixel column off the edge of
  // print the owner deliberately included.
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys)));

  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < width * MIN_CROP_FRACTION || cropHeight < height * MIN_CROP_FRACTION) return null;

  return { originX: left, originY: top, width: cropWidth, height: cropHeight };
}

/**
 * Whether a crop is worth performing at all.
 *
 * An owner who opens the crop editor, looks, and applies without moving
 * anything should not pay for a re-encode that throws away JPEG quality for
 * no change in content. "Near enough to the whole frame" is judged per axis
 * against the same 2% either side.
 */
export function cropChangesAnything(rect: CropRect, width: number, height: number): boolean {
  const margin = 0.02;
  return (
    rect.originX > width * margin ||
    rect.originY > height * margin ||
    rect.width < width * (1 - margin) ||
    rect.height < height * (1 - margin)
  );
}

/**
 * How the crop editor should open.
 *
 * The rule the plan fixed in advance, and the reason edge detection can never
 * lose an owner their photograph: a confident detection preselects its
 * corners, anything less falls back to the default inset, and BOTH are then
 * dragged by hand if they are wrong. Detection failing is not an error state
 * here — it is the same screen with different starting handles.
 */
export const EDGE_CONFIDENCE_FLOOR = 0.55;

export function shouldPreselectCorners(confidence: number | undefined | null): boolean {
  return typeof confidence === "number" && confidence >= EDGE_CONFIDENCE_FLOOR;
}

/**
 * Turns the edge detector's answer into corners this file can use.
 *
 * The server returns FRACTIONS of the image (0-1), not pixels, and that is
 * deliberate on both sides: it detects on a downscaled copy whose dimensions
 * the phone never learns, and the phone holds the full-resolution original.
 * Fractions are the only unit both agree on. Converting here — once, in the
 * one place that knows the real dimensions — is what stops a 320px-wide
 * analysis coordinate from being applied to a 3000px-wide photograph.
 *
 * Returns null for a missing or malformed answer rather than throwing: the
 * detector is an enhancement, and every caller already has a path for it
 * having said nothing.
 */
export function cornersFromFractions(
  fractional: Corners | null | undefined,
  width: number,
  height: number,
): Corners | null {
  if (!fractional) return null;
  const scale = (p: Point | undefined): Point | null => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return clampToImage({ x: p.x * width, y: p.y * height }, width, height);
  };

  const topLeft = scale(fractional.topLeft);
  const topRight = scale(fractional.topRight);
  const bottomRight = scale(fractional.bottomRight);
  const bottomLeft = scale(fractional.bottomLeft);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;

  return { topLeft, topRight, bottomRight, bottomLeft };
}

/**
 * The corners the crop editor opens with, given whatever detection managed.
 *
 * Every argument may be absent and the function still returns a usable quad —
 * that is the whole point. A detector that timed out, returned nonsense, or
 * was never called all land on the same safe default.
 */
export function initialCorners(
  width: number,
  height: number,
  detected?: Corners | null,
  confidence?: number | null,
): Corners {
  if (detected && shouldPreselectCorners(confidence)) {
    return {
      topLeft: clampToImage(detected.topLeft, width, height),
      topRight: clampToImage(detected.topRight, width, height),
      bottomRight: clampToImage(detected.bottomRight, width, height),
      bottomLeft: clampToImage(detected.bottomLeft, width, height),
    };
  }
  return defaultCorners(width, height);
}

// ============================================================
// The session — an ordered set of sections, not N receipts
// ============================================================

/** Whether another section may be photographed. */
export function canAddSection(count: number): boolean {
  return count < MAX_SECTIONS;
}

/**
 * What the camera says about where the owner is in the session.
 *
 * "Section 3 of 3" rather than "3 photos": the sentence has to carry that
 * these are parts of ONE receipt, because the entire failure this feature
 * exists to prevent is a long receipt entered as three separate purchases.
 * The count is of sections ALREADY taken plus the one being framed, which is
 * why it reads `of` the same number while shooting.
 */
export function sectionLabel(capturedCount: number): string {
  const current = capturedCount + 1;
  return `Section ${current} of ${current}`;
}

/** The same idea, for a section already in the strip. */
export function sectionOrdinal(index: number, total: number): string {
  return `Section ${index + 1} of ${total}`;
}

/**
 * Moves a section earlier or later in the printed order.
 *
 * Order is the client's assertion and the server trusts it (see
 * docs/multi-page-receipts-plan.md §4), so this is the only thing standing
 * between a receipt photographed bottom-up and an item list in the wrong
 * sequence. Out-of-range moves return the list unchanged rather than
 * throwing — the arrows at the ends of the strip are disabled, and a
 * disabled control that still explodes when a race gets past it is not worth
 * the risk.
 */
export function moveSection<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

/**
 * The instruction shown over the live preview.
 *
 * Different for the first section, because there is nothing to align to yet
 * and telling someone to match an overlap they have not created is noise.
 */
export function captureInstruction(capturedCount: number): string {
  return capturedCount === 0
    ? "Position one receipt inside the frame. Keep it flat and avoid shadows or glare."
    : "Align the last few lines of the previous section, then continue downward.";
}

/**
 * How tall the ghosted overlap strip is drawn, as a fraction of the guide.
 *
 * The midpoint of the target band rather than its floor: an owner aligns to
 * roughly where the strip ends, so anchoring at 15% would make 15% the
 * typical outcome and every capture that fell short of it useless. Aiming at
 * 20% leaves room to undershoot and still land inside the band.
 */
export function overlapGuideHeight(): number {
  return (OVERLAP_TARGET.min + OVERLAP_TARGET.max) / 2;
}

/**
 * Local id for a section.
 *
 * Time plus randomness rather than a counter, because sections are removed
 * and reordered and a counter would reissue an id that a stale render still
 * holds — which in a list keyed by it means one section's image appearing
 * under another's controls.
 */
export function newSectionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
