/**
 * Where the spotlight, the scrim and the card go — as arithmetic, not as JSX.
 *
 * WHY THIS FILE EXISTS. Every visible defect the tour has had was a
 * coordinate, not a component: a hole drawn a status bar's height above the
 * button it was describing, a card that covered the very thing it pointed at,
 * a step that talked about figures which were scrolled off the screen. None of
 * that is reachable from the test runner while it lives inside a render — this
 * project has no React Native render harness — so the geometry lives out here
 * where tests/tourGeometry.test.ts can pin it.
 *
 * TWO COORDINATE SPACES, AND THE ONE RULE THAT KEEPS THEM STRAIGHT.
 * `measureInWindow` reports a target in WINDOW coordinates. The overlay draws
 * in its OWN coordinates. Those two spaces agree only by accident: an overlay
 * inside a Modal is a different native window from the app underneath it, and
 * on Android that window may or may not start below the status bar depending
 * on the launch mode — which is exactly how the spotlight ended up floating
 * above the tab bar icons. So the overlay measures ITSELF in window
 * coordinates too and every target is translated by that origin. The
 * subtraction is here; nothing else in the tour is allowed to assume the two
 * spaces are the same.
 */

export interface TourRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Breathing room around a spotlighted element unless the target overrides it. */
export const DEFAULT_PAD: Padding = { top: 8, right: 8, bottom: 8, left: 8 };

export function resolvePadding(pad?: Partial<Padding>): Padding {
  return { ...DEFAULT_PAD, ...(pad ?? {}) };
}

/**
 * A measured target, translated into the overlay's own space and padded.
 *
 * Clamped to the overlay on both axes so a partially off-screen element still
 * produces a sane hole rather than a rectangle with negative width.
 */
export function spotlightFrame(
  rect: TourRect,
  origin: { x: number; y: number },
  size: Size,
  pad?: Partial<Padding>,
): TourRect {
  const p = resolvePadding(pad);
  const left = rect.x - origin.x - p.left;
  const top = rect.y - origin.y - p.top;
  const right = left + rect.width + p.left + p.right;
  const bottom = top + rect.height + p.top + p.bottom;

  const clampedLeft = Math.max(0, Math.min(left, size.width));
  const clampedTop = Math.max(0, Math.min(top, size.height));
  return {
    x: clampedLeft,
    y: clampedTop,
    width: Math.max(0, Math.min(right, size.width) - clampedLeft),
    height: Math.max(0, Math.min(bottom, size.height) - clampedTop),
  };
}

/**
 * Is enough of the target actually on screen to be worth pointing at?
 *
 * A target scrolled almost entirely out of the viewport gives a sliver of a
 * hole against a description of something the owner cannot see — worse than
 * no spotlight at all, because it aims their attention at the wrong pixels.
 */
export function frameIsUsable(frame: TourRect, target: TourRect, minVisible = 0.6): boolean {
  if (frame.width <= 2 || frame.height <= 2) return false;
  if (target.height <= 0) return false;
  return frame.height >= target.height * minVisible;
}

/**
 * Do two measurements of the same element agree?
 *
 * The tour measures things that may still be MOVING — the "+" menu's actions
 * spring out along an arc from behind the button, and a rectangle sampled
 * while they travel is a hole where the circle briefly was. (That is exactly
 * what put the first spotlight of the quick-add steps on the "+" itself:
 * measured at the moment the arc had not yet left the button.) Waiting a fixed
 * time is a guess about a device's speed; waiting for two consecutive
 * measurements to agree is an observation, and it costs one extra sample when
 * nothing is moving.
 *
 * The tolerance absorbs sub-pixel rounding between the two samples, nothing
 * larger — a target still travelling moves much further than this between
 * frames.
 */
export function rectsAgree(a: TourRect, b: TourRect, tolerance = 1.5): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** The four dim panels that surround the hole. Never negative, never inverted. */
export function scrimPanels(frame: TourRect, size: Size) {
  const bottom = frame.y + frame.height;
  const right = frame.x + frame.width;
  return [
    { top: 0, left: 0, width: size.width, height: Math.max(0, frame.y) },
    { top: Math.min(bottom, size.height), left: 0, width: size.width, height: Math.max(0, size.height - bottom) },
    { top: frame.y, left: 0, width: Math.max(0, frame.x), height: frame.height },
    { top: frame.y, left: Math.min(right, size.width), width: Math.max(0, size.width - right), height: frame.height },
  ];
}

export interface CardPlacement {
  top: number;
  /** True when the card had to be put on the opposite side to the preferred one. */
  above: boolean;
  /** True when even the flipped side could not clear the spotlight. */
  overlaps: boolean;
}

/**
 * Where the card sits relative to the hole.
 *
 * Preference is "the side with more room", not "below unless the target is low
 * down": a header target on a phone leaves plenty of space beneath it, a tab
 * bar target leaves none, and picking by measured room handles both plus the
 * awkward middle — a target at 55% of the screen with a five-line card, which
 * the old bottom-half rule pushed into the spotlight it was describing.
 *
 * `overlaps` is reported rather than hidden. The overlay uses it to decide
 * whether the screen underneath needs to scroll before the step is shown.
 */
export function cardPlacement({
  frame,
  size,
  insets,
  cardHeight,
  gap,
}: {
  frame: TourRect;
  size: Size;
  insets: { top: number; bottom: number };
  cardHeight: number;
  gap: number;
}): CardPlacement {
  const minTop = insets.top + gap / 2;
  const maxTop = Math.max(minTop, size.height - insets.bottom - gap / 2 - cardHeight);

  const roomAbove = frame.y - gap - minTop;
  const roomBelow = size.height - insets.bottom - gap / 2 - (frame.y + frame.height + gap);
  const above = roomAbove > roomBelow;

  const wanted = above ? frame.y - gap - cardHeight : frame.y + frame.height + gap;
  const top = Math.max(minTop, Math.min(wanted, maxTop));
  const overlaps = top < frame.y + frame.height && top + cardHeight > frame.y;
  return { top, above, overlaps };
}

/**
 * How far the scrolling screen underneath has to move for a target to be both
 * on screen and clear of the card.
 *
 * Positive means "scroll the content up" (increase the offset). Zero means the
 * target is already sitting somewhere the card can work with, and the screen
 * is left alone — a tour that re-scrolls Home on every step reads as the app
 * fighting the owner for control of the page.
 */
export function scrollDeltaToReveal(
  rect: TourRect,
  { viewportTop, viewportBottom, preferredTop }: { viewportTop: number; viewportBottom: number; preferredTop: number },
): number {
  const fullyVisible = rect.y >= viewportTop && rect.y + rect.height <= viewportBottom;
  if (fullyVisible) return 0;
  return Math.round(rect.y - preferredTop);
}
