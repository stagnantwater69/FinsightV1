import type { ReceiptSection } from "./receiptCapture";

/**
 * Sections photographed in the tab bar's camera, handed to the screen that
 * scans them.
 *
 * WHY THE CAMERA IS NOT A SCREEN ANY MORE. The Scan button used to work by
 * navigating — `navigate("Records", { screen: "ScanReceipt", … })` — which
 * meant pressing it pushed a screen onto ANOTHER tab's stack just to get a
 * camera up. Everything that went wrong afterwards came from that one
 * decision: the Records tab lit up instead of Scan; pressing Records did
 * nothing because Records was already "focused"; the nested-navigation params
 * stuck to the Records route and replayed on every later press, reopening the
 * scanner at someone who wanted their records; and backing out of the camera
 * stranded the owner on a screen they never asked for.
 *
 * The camera is now a modal owned by the tab bar. Pressing Scan changes no
 * navigation state at all — it opens the camera where the owner already is,
 * and cancelling leaves them exactly there.
 *
 * WHY A MODULE-LEVEL VALUE AND NOT A ROUTE PARAM: the same reason as
 * `flash.ts`, plus a sharper one learned the hard way. Route params persist
 * on the route and get REPLAYED by React Navigation's tab handler — that is
 * precisely the bug this whole rearrangement exists to remove, and handing
 * the sections over as params would walk straight back into it. Photographs
 * are also not something to serialise into navigation state that gets kept
 * for the life of the app.
 *
 * Consumed exactly once, which is why it is a take and not a get: a second
 * screen focusing later must not re-scan a receipt that has already been
 * scanned and possibly already saved.
 */

let pending: ReceiptSection[] | null = null;

/** Hand a finished capture session to the scan screen. */
export function handOffSections(sections: ReceiptSection[]): void {
  pending = sections.length > 0 ? sections : null;
}

/** Read the handed-over session and clear it. Null when there is none. */
export function takeHandedOffSections(): ReceiptSection[] | null {
  const sections = pending;
  pending = null;
  return sections;
}
