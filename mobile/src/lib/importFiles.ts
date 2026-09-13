/** Mirrors the API upload middleware; content bytes are still checked server-side. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const CSV_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function receiptFileError(file: { name: string; size?: number; mimeType?: string }): string | null {
  if (file.size === 0) return "This file is empty. Choose another receipt.";
  if (file.size != null && file.size > RECEIPT_MAX_BYTES) return "Choose a receipt smaller than 10 MB.";
  if (!/\.(jpe?g|png|webp)$/i.test(file.name) ||
      (file.mimeType && file.mimeType !== "application/octet-stream" && !RECEIPT_MIME_TYPES.includes(file.mimeType))) {
    return "Choose a JPG, PNG, or WebP image. PDF receipts are not supported.";
  }
  return null;
}

export function receiptMimeType(name: string): string {
  return /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg";
}

export function csvFileError(file: { name: string; size?: number }): string | null {
  if (!/\.csv$/i.test(file.name)) return "Choose a CSV file. Export Excel files as CSV first.";
  if (file.size === 0) return "This file is empty. Choose a CSV with transaction rows.";
  if (file.size != null && file.size > CSV_MAX_BYTES) return "Choose a CSV smaller than 5 MB.";
  return null;
}
