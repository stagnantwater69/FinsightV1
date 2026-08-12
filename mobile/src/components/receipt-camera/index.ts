/**
 * FinSight's receipt camera.
 *
 * The screen imports only `ReceiptCamera`; everything else here is internal
 * to it. Kept as a folder rather than one file because the capture screen,
 * the approval screen and the crop editor are three genuinely different
 * surfaces that happen to share a session, and one 900-line component is how
 * that stops being reviewable.
 */
export { ReceiptCamera } from "./ReceiptCamera";
export type { ReceiptSection } from "../../lib/receiptCapture";
