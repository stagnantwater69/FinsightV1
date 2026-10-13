import {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "./receiptUploadContract";

/** Mirrors the API upload middleware; content bytes are still checked server-side. */
export const RECEIPT_MAX_BYTES = RECEIPT_UPLOAD_MAX_OBJECT_BYTES;
export const CSV_MAX_BYTES = 5 * 1024 * 1024;
const RECEIPT_MIME_TYPES: string[] = [...RECEIPT_UPLOAD_ALLOWED_MIME_TYPES];

export function receiptFileError(file: { name: string; size?: number; mimeType?: string }): string | null {
  if (file.size === 0) return "This file is empty. Choose another receipt.";
  if (file.size != null && file.size > RECEIPT_MAX_BYTES) return "Choose a receipt no larger than 10 MiB.";
  if (!/\.(jpe?g|png|webp)$/i.test(file.name) ||
      (file.mimeType && file.mimeType !== "application/octet-stream" && !RECEIPT_MIME_TYPES.includes(file.mimeType))) {
    return "Choose a JPG, PNG, or WebP image. PDF receipts are not supported.";
  }
  return null;
}

export function csvFileError(file: { name: string; size?: number }): string | null {
  if (!/\.csv$/i.test(file.name)) return "Choose a CSV file. Export Excel files as CSV first.";
  if (file.size === 0) return "This file is empty. Choose a CSV with transaction rows.";
  if (file.size != null && file.size > CSV_MAX_BYTES) return "Choose a CSV smaller than 5 MB.";
  return null;
}
