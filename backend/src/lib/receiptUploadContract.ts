export const RECEIPT_UPLOAD_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES = 80 * 1024 * 1024;
export const RECEIPT_UPLOAD_MAX_LOGICAL_PAGES = 8;

export const RECEIPT_UPLOAD_ALLOWED_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
] as const);

export type ReceiptUploadMimeType = (typeof RECEIPT_UPLOAD_ALLOWED_MIME_TYPES)[number];

export const RECEIPT_UPLOAD_MAX_MULTIPART_OBJECTS = RECEIPT_UPLOAD_MAX_LOGICAL_PAGES * 2;
