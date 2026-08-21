import type { ReceiptField } from "../../lib/receiptWarnings";
import type { Origin, ScanStage } from "./types";
import { SCAN_STAGES } from "./types";

export const STAGE_LABELS: Record<ScanStage, string> = {
  uploading: "Uploading",
  reading: "Reading text",
  checking: "Checking totals",
  categorising: "Categorising",
};

export const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Matches the server's own MAX_PAGES (receiptScan.service.ts) — kept in the
 * comment rather than imported, since the client has no access to backend
 * source; the server is still the one place that actually enforces it. */
export const MAX_RECEIPT_FILES = 8;

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
