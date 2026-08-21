import { api } from "../../../lib/api";
import type { ReceiptSection } from "../../../lib/receiptCapture";
import type { CapturedPage, ReceiptScanResult } from "./types";

/**
 * How often, and for how long, to ask whether a scan has finished reading.
 *
 * Matches the web client's figures deliberately — the same server work is
 * being waited on, and two different cadences would be two numbers to keep
 * in step for no reason. The endpoint polled runs two indexed queries and no
 * OCR, so this is cheap; the generous ceiling exists to end a wait that will
 * never finish (a server restart mid-read strands a scan on "Processing"),
 * not to cut short one that is merely slow.
 */
const SCAN_POLL_INTERVAL_MS = 1500;
const SCAN_POLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Waits for a scan the server has accepted but not yet finished reading.
 *
 * Throws on a failed or never-finishing read rather than returning a
 * half-empty scan — scanPages' existing catch then shows the reason and
 * leaves the owner on the capture screen with their photos intact, which is
 * the same outcome any other failed scan has always had.
 */
export async function pollUntilRead(initial: ReceiptScanResult, mayRetry = true): Promise<ReceiptScanResult> {
  if (initial.processingStatus && initial.processingStatus !== "Processing") {
    if (initial.processingStatus === "Failed") {
      if (mayRetry) {
        const retried = await api.post<ReceiptScanResult>(`/records/receipts/${initial.id}/retry`);
        return pollUntilRead(retried, false);
      }
      throw new Error(initial.processingError ?? "This receipt could not be read. Try scanning it again.");
    }
    return initial;
  }

  const deadline = Date.now() + SCAN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_INTERVAL_MS));
    const next = await api.get<ReceiptScanResult>(`/records/receipts/${initial.id}`);
    if (next.processingStatus === "Failed") {
      if (mayRetry) {
        const retried = await api.post<ReceiptScanResult>(`/records/receipts/${initial.id}/retry`);
        return pollUntilRead(retried, false);
      }
      throw new Error(next.processingError ?? "This receipt could not be read. Try scanning it again.");
    }
    if (next.processingStatus === "Complete") return next;
  }
  throw new Error("This receipt is taking longer than expected to read. Try scanning it again.");
}

/**
 * Turns a finished capture session into the page list this screen already
 * uploads.
 *
 * A DELIBERATE SEAM. The camera is new; the upload is not. `scanPages` below
 * has always sent a `files` array in page order and the server has always
 * read one, and none of that changes because the photographs now arrive from
 * a different screen. Everything the new camera knows that the old flow did
 * not — crop corners, edge confidence — stops here, because the request
 * format is a contract with a server that never asked for it.
 *
 * The readability reading DOES cross over, already measured, so a section
 * approved in the camera is not sent for the same check twice.
 */
export function pagesFromSections(sections: ReceiptSection[]): CapturedPage[] {
  return sections.map((section, index) => ({
    key: section.localId,
    uri: section.processedUri,
    fileName: `receipt-section-${index + 1}-${Date.now()}.jpg`,
    // Always JPEG: the camera saves JPEG and every crop re-renders as JPEG.
    // The server's upload filter accepts jpeg|png|webp, so this is inside
    // what it allows rather than a new claim about what it takes.
    mimeType: "image/jpeg",
    quality: section.quality,
    checkingQuality: false,
    width: section.width,
    height: section.height,
    originalUri: section.originalUri,
  }));
}

/**
 * The same conversion backwards, for reopening the camera on a session that
 * is already part-photographed.
 *
 * Without this, tapping "Add another section" from the capture card would
 * open a camera holding nothing, and finishing it would replace the sections
 * already taken instead of extending them — a long receipt losing its first
 * two pages to the act of photographing its third. The camera owns the whole
 * ordered session while it is open, so it has to be given the whole session.
 */
export function sectionsFromPages(pages: CapturedPage[]): ReceiptSection[] {
  return pages.map((page) => ({
    localId: page.key,
    originalUri: page.originalUri ?? page.uri,
    processedUri: page.uri,
    width: page.width,
    height: page.height,
    quality: page.quality,
  }));
}
