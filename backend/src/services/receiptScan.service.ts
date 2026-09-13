/**
 * Barrel for the receipt-scan feature.
 *
 * The implementation lives in `./receiptScan/*`, split along the seams the
 * feature already had — queue/worker mechanics, local extraction, gated provider rescue,
 * item categorisation, and confirm/split reconciliation — because the single
 * file this used to be had grown past the point a change to one concern could
 * be reviewed without reading all the others.
 *
 * This file exists so every import path that already says
 * `services/receiptScan.service` (routes, controllers, the background
 * worker, tests) keeps working unchanged; nothing here does any work of its
 * own beyond re-exporting.
 */
export type {
  ConfirmInput,
  ReceiptSplit,
  ReceiptUploadFile,
  ReceiptUploadSubmission,
  UploadInput,
  UploadPage,
} from "./receiptScan/types";
export { MAX_PAGES } from "./receiptScan/types";
export {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "../lib/receiptUploadContract";

export { deleteScanItem, updateScanItem, confirmReceipt } from "./receiptScan/reconciliation";

export { uploadAndScan, retryScan, getScan, getScanPageImage } from "./receiptScan/queue";
export { listReceiptScans, RECEIPT_HISTORY_STATUSES } from "./receiptScan/history";
export { runReceiptWorkerOnce } from "./receiptScan/worker";
