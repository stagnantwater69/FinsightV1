import { space } from "../theme/tokens";

/*
 * The floating tab bar's geometry, in one place, because two components draw
 * against it: the bar itself, and the quick-add speed dial that has to put its
 * X exactly over the bar's "+" and stack its actions above it. A number guessed
 * twice drifts the first time one of them changes.
 */

/** Height of the pill that holds the four tabs, and of the "+" beside it. */
export const BAR_HEIGHT = 64;
export const BAR_MAX_WIDTH = 720;

export function barHeightForScale(fontScale: number): number {
  return BAR_HEIGHT + Math.ceil(Math.max(0, fontScale - 1) * 40);
}

export function barSideInset(windowWidth: number): number {
  return BAR_SIDE + Math.max(0, (windowWidth - BAR_MAX_WIDTH) / 2);
}

/** Gap between the pill and the screen's side edges. */
export const BAR_SIDE = space.lg;

/** Gap between the bar and the bottom safe-area edge. */
export const BAR_LIFT = space.sm;

/** Gap between the pill and the "+". */
export const BAR_GAP = 10;

/** The whole strip the bar occupies, from the bottom of the screen up. */
export function barAreaHeight(bottomInset: number, fontScale = 1): number {
  return barHeightForScale(fontScale) + BAR_LIFT + Math.max(bottomInset, space.sm) + space.sm;
}

/** Distance from the bottom of the screen to the centre of the "+". */
export function addCentreFromBottom(bottomInset: number, fontScale = 1): number {
  return Math.max(bottomInset, space.sm) + BAR_LIFT + barHeightForScale(fontScale) / 2;
}
