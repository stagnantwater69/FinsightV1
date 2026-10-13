/**
 * Page navigation rules for the receipt camera's review screen.
 *
 * No React imports, like receiptCapture.ts: the camera has no device harness,
 * so the rules that decide what the confirm button does and when Add Page is
 * offered live where vitest can check them directly.
 */

export type ReviewSessionMode = "standard" | "batch";

/**
 * What the green confirm button does for the page on screen.
 *
 * - `keep-page`: a Batch capture that has not been accepted yet. Keeping it
 *   adds it to the batch and returns to the camera for the next receipt.
 * - `finish-batch`: every page is accepted; hand the batch to processing.
 * - `use-receipt`: Standard mode's single receipt.
 */
export type ReviewConfirmAction = "keep-page" | "finish-batch" | "use-receipt";

export function reviewConfirmAction(mode: ReviewSessionMode, stagedOnScreen: boolean): ReviewConfirmAction {
  if (mode === "standard") return "use-receipt";
  return stagedOnScreen ? "keep-page" : "finish-batch";
}

export function clampPageIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(index)));
}

/**
 * The dashed Add Page card at the end of the pager. Only a Batch with room
 * left offers it, and never while a capture waits to be kept or discarded:
 * leaving that page would strand an unconfirmed photo.
 */
export function showAddPageSlot(mode: ReviewSessionMode, full: boolean, staged: boolean): boolean {
  return mode === "batch" && !full && !staged;
}

/** Which page a horizontal pager settled on after a swipe. */
export function pageIndexFromOffset(offsetX: number, pageWidth: number, slotCount: number): number {
  if (!(pageWidth > 0)) return 0;
  return clampPageIndex(offsetX / pageWidth, slotCount);
}

export function pagerPosition(index: number, count: number): string {
  return `${clampPageIndex(index, count) + 1}/${Math.max(count, 1)}`;
}
