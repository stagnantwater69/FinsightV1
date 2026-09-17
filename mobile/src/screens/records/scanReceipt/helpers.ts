import { api, ApiError } from "../../../lib/api";
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
 * The ceiling counted in polls rather than in wall-clock milliseconds.
 *
 * A phone suspends timers when the app goes to the background, so a
 * `Date.now()` deadline expires while nothing is being polled: three minutes
 * in someone's pocket used to surface as "taking longer than expected" for a
 * scan the server had already finished. Counting attempts makes the ceiling
 * mean what it was written to mean — this many unanswered polls — on a device
 * whose clock keeps running when its timers do not.
 */
export const SCAN_POLL_MAX_ATTEMPTS = Math.ceil(SCAN_POLL_TIMEOUT_MS / SCAN_POLL_INTERVAL_MS);

/**
 * How many polls in a row may fail before the read is called off.
 *
 * A single 500, or one request dropped as the phone hands over between cells,
 * used to report a scan as failed that the server finishes seconds later —
 * with the owner's photographs already uploaded and the work already done.
 * Only a transport-level or server-side failure is retried; a 401, 403 or 404
 * is an answer, not a blip, and repeating it would sign someone out three
 * times over.
 */
export const SCAN_POLL_MAX_CONSECUTIVE_ERRORS = 3;

function isTransientPollError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
}

/** Waits `ms`, or resolves as soon as `signal` aborts, leaving no timer behind. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Waits for a scan the server has accepted but not yet finished reading.
 *
 * Throws on a failed or never-finishing read rather than returning a
 * half-empty scan — scanPages' existing catch then shows the reason and
 * leaves the owner on the capture screen with their photos intact, which is
 * the same outcome any other failed scan has always had.
 */
export async function pollUntilRead(initial: ReceiptScanResult, signal?: AbortSignal): Promise<ReceiptScanResult> {
  const checkActive = () => {
    if (signal?.aborted) throw new Error("Receipt processing paused.");
  };
  checkActive();
  if (initial.processingStatus && initial.processingStatus !== "Processing") {
    if (initial.processingStatus === "Failed") {
      throw new ReceiptReadFailure(
        "failed",
        initial.processingError ?? "This receipt could not be read from its stored images.",
      );
    }
    return initial;
  }

  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < SCAN_POLL_MAX_ATTEMPTS; attempt += 1) {
    await delay(SCAN_POLL_INTERVAL_MS, signal);
    checkActive();
    let next: ReceiptScanResult;
    try {
      next = await api.get<ReceiptScanResult>(`/records/receipts/${initial.id}`, undefined, signal);
    } catch (err) {
      // An abort arrives here as a network failure; it ends the poll rather
      // than spending a retry on a screen nobody is looking at.
      checkActive();
      consecutiveErrors += 1;
      if (!isTransientPollError(err) || consecutiveErrors >= SCAN_POLL_MAX_CONSECUTIVE_ERRORS) throw err;
      continue;
    }
    consecutiveErrors = 0;
    checkActive();
    if (next.processingStatus === "Failed") {
      throw new ReceiptReadFailure(
        "failed",
        next.processingError ?? "This receipt could not be read from its stored images.",
      );
    }
    if (next.processingStatus === "Complete") return next;
  }
  throw new ReceiptReadFailure(
    "timeout",
    "This receipt is taking longer than expected. You can leave it processing and review the result later.",
  );
}

export class ReceiptReadFailure extends Error {
  constructor(
    public readonly kind: "failed" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "ReceiptReadFailure";
  }
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
  return sections.map((section, index) => {
    const processedMimeType = section.processedMimeType ?? "image/jpeg";
    const extension = processedMimeType === "image/png" ? "png" : processedMimeType === "image/webp" ? "webp" : "jpg";
    return {
      captureMode: section.captureMode,
      sourceAssetUri: section.sourceAssetUri,
      key: section.localId,
      uri: section.processedUri,
      fileName: `receipt-section-${index + 1}-${Date.now()}.${extension}`,
      mimeType: processedMimeType,
      quality: section.quality,
      checkingQuality: false,
      width: section.width,
      height: section.height,
      originalUri: section.originalUri,
      originalMimeType: section.originalMimeType ?? processedMimeType,
      originalWidth: section.originalWidth ?? section.width,
      originalHeight: section.originalHeight ?? section.height,
      captureSource: section.captureSource,
      processingMode: section.processingMode,
      transformVersion: section.transformVersion,
      cropCorners: section.cropCorners,
      documentConfidence: section.documentConfidence ?? section.edgeConfidence,
      ownerOverrodeLikelihood: section.ownerOverrodeLikelihood,
      receiptGroupId: section.receiptGroupId,
    };
  });
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
    captureMode: page.captureMode,
    sourceAssetUri: page.sourceAssetUri,
    localId: page.key,
    originalUri: page.originalUri ?? page.uri,
    originalMimeType: page.originalMimeType ?? page.mimeType,
    originalWidth: page.originalWidth ?? page.width,
    originalHeight: page.originalHeight ?? page.height,
    processedUri: page.uri,
    processedMimeType: page.mimeType,
    captureSource: page.captureSource,
    processingMode: page.processingMode,
    transformVersion: page.transformVersion,
    cropCorners: page.cropCorners,
    documentConfidence: page.documentConfidence,
    ownerOverrodeLikelihood: page.ownerOverrodeLikelihood,
    receiptGroupId: page.receiptGroupId,
    width: page.width,
    height: page.height,
    quality: page.quality,
  }));
}
