import type { ReceiptField } from "../../lib/receiptWarnings";
import type { Origin, ScanStage } from "./types";
import { SCAN_STAGES } from "./types";

export const STAGE_LABELS: Record<ScanStage, string> = {
  uploading: "Uploading",
  reading: "Reading text",
  checking: "Checking totals",
  categorising: "Categorising",
};

export const RECEIPT_UPLOAD_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES = 80 * 1024 * 1024;
export const RECEIPT_UPLOAD_MAX_LOGICAL_PAGES = 8;
export const RECEIPT_UPLOAD_ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const ACCEPTED_TYPES = RECEIPT_UPLOAD_ALLOWED_MIME_TYPES.join(",");
export const MAX_FILE_BYTES = RECEIPT_UPLOAD_MAX_OBJECT_BYTES;
export const MAX_RECEIPT_FILES = RECEIPT_UPLOAD_MAX_LOGICAL_PAGES;

export type ReceiptUploadFile = Pick<File, "name" | "size" | "type" | "lastModified">;
export type ReceiptUploadFileIssue = "EMPTY" | "UNSUPPORTED_TYPE" | "TOO_LARGE";

export function receiptUploadFileIssue(file: ReceiptUploadFile): ReceiptUploadFileIssue | null {
  if (file.size === 0) return "EMPTY";
  if (!RECEIPT_UPLOAD_ALLOWED_MIME_TYPES.some((allowed) => allowed === file.type.toLowerCase())) {
    return "UNSUPPORTED_TYPE";
  }
  if (file.size > RECEIPT_UPLOAD_MAX_OBJECT_BYTES) return "TOO_LARGE";
  return null;
}

export function receiptUploadBytes(files: readonly Pick<ReceiptUploadFile, "size">[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

export function exceedsReceiptUploadAggregateLimit(
  files: readonly Pick<ReceiptUploadFile, "size">[],
): boolean {
  return receiptUploadBytes(files) > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES;
}

export function receiptUploadSelectionError(
  selected: readonly ReceiptUploadFile[],
  incoming: readonly ReceiptUploadFile[],
): string | null {
  const empty = incoming.find((file) => receiptUploadFileIssue(file) === "EMPTY");
  if (empty) return `${empty.name} is empty. Choose another photo.`;

  const seen = new Set(selected.map((file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`));
  for (const file of incoming) {
    const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    if (seen.has(key)) return "That photo is already selected. Choose a different photo.";
    seen.add(key);
  }

  const combined = [...selected, ...incoming];
  if (combined.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
    const extra = combined.length - RECEIPT_UPLOAD_MAX_LOGICAL_PAGES;
    return `A receipt can have at most ${RECEIPT_UPLOAD_MAX_LOGICAL_PAGES} photos. Remove ${extra} ${extra === 1 ? "photo" : "photos"}.`;
  }

  const badType = incoming.find((file) => receiptUploadFileIssue(file) === "UNSUPPORTED_TYPE");
  if (badType) return `${badType.name} is not an accepted photo. Choose a JPEG, PNG or WEBP image.`;

  const tooBig = incoming.find((file) => receiptUploadFileIssue(file) === "TOO_LARGE");
  if (tooBig) return `${tooBig.name} is larger than 10 MiB. Choose a smaller photo.`;

  if (exceedsReceiptUploadAggregateLimit(combined)) {
    return "The selected photos total more than 80 MiB. Remove a photo or choose smaller files.";
  }

  return null;
}

/**
 * How often, and for how long, to ask whether a scan has finished reading.
 *
 * 1.5s is short enough that a fast read feels immediate and long enough that
 * a slow one does not flood the server — the endpoint being polled runs two
 * indexed queries and no OCR, so this is cheap, but it is still a request per
 * interval per scanning owner.
 *
 * The ceiling is generous because the work behind it genuinely is slow: up to
 * MAX_RECEIPT_FILES pages of Tesseract, sometimes a vision-model round trip,
 * then the categoriser. It exists to end a wait that will never finish (a
 * server restart mid-read strands a scan on "Processing"), not to cut short
 * one that is merely taking its time.
 */
export const SCAN_POLL_INTERVAL_MS = 1500;
export const SCAN_POLL_TIMEOUT_MS = 3 * 60 * 1000;

export const ORIGIN_CHIP: Partial<Record<Origin, { label: string; tone: string }>> = {
  read: { label: "Read from receipt", tone: "bg-tint-info text-tone-info ring-edge-info" },
  derived: { label: "Suggested from the vendor", tone: "bg-tint-info text-tone-info ring-edge-info" },
  missing: { label: "Not found — please enter", tone: "bg-tint-accent text-tone-accent ring-edge-accent" },
};

/** Human names for the extracted fields, used wherever one is named in prose. */
export const FIELD_LABELS: Record<ReceiptField, string> = {
  date: "Date",
  description: "Description",
  vendor: "Vendor",
  amount: "Amount",
};

export { SCAN_STAGES };
