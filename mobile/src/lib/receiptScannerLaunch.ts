/**
 * The orchestration behind launching Google ML Kit Document Scanner, kept out
 * of the component so it can be tested under plain vitest.
 *
 * WHY THIS EXISTS SEPARATELY FROM `nativeReceiptScanner.ts`. That file talks
 * to the native module: it dynamically imports `expo-document-scanner`, calls
 * `scanDocument`, and turns the pages it returns into `ReceiptSection`s. This
 * file is one layer up — it is the state machine ReceiptCamera.tsx used to
 * carry inline, extracted so the four outcomes (launched a scan and it
 * succeeded, the owner cancelled, the runtime cannot run a scanner at all, or
 * the scan genuinely failed) and the "two launches cannot run concurrently"
 * rule are each a plain function a test can call directly, rather than
 * behaviour only reachable by pressing a button on a screen this project has
 * no render harness deep enough to drive.
 *
 * ML Kit IS THE ONLY CAPTURE PATH ON ANDROID NOW. There is no fallback
 * branch here to "open the old camera" — that camera no longer exists in this
 * journey. A failure is a `failure` outcome the screen displays with retry and
 * go-back actions; it is never silently swapped for a different capture
 * implementation.
 */

import {
  isScannerCancellation,
  remainingScannerCapacity,
  scannerFailureMessage,
  type ReceiptSection,
} from "./receiptCapture";

export type ScannerLaunchOutcome =
  | { kind: "success"; sections: ReceiptSection[] }
  | { kind: "cancelled" }
  /** The runtime cannot run a scanner at all: Expo Go, iOS, or the flag is off. */
  | { kind: "unsupported" }
  /** A genuine scanner failure — bad state, no Play Services, a real error. */
  | { kind: "failure"; message: string };

/**
 * Runs one attempt at opening the platform scanner and turning its answer
 * into an outcome the screen can render.
 *
 * `existingSections` is the session already on hand (from a previous "Add
 * another section" round) — its length is what decides how many pages ML Kit
 * may still add, and it is what the returned pages are appended to. Passing
 * it in rather than closing over component state is what makes this callable
 * from a test with an arbitrary starting count.
 *
 * `scan` is `scanReceiptWithNativeDocumentScanner` in production and a fake in
 * tests — this file never imports `expo-document-scanner` itself, which is
 * also why it is safe to import unconditionally in Expo Go: nothing here
 * touches Nitro.
 */
export async function launchReceiptScanner(
  existingSections: ReceiptSection[],
  scan: (remainingPages: number) => Promise<ReceiptSection[]>,
  enabled: boolean,
): Promise<ScannerLaunchOutcome> {
  if (!enabled) return { kind: "unsupported" };

  const remaining = remainingScannerCapacity(existingSections.length);
  if (remaining === 0) {
    // Reaching this needs the entry point to have handed over eight sections
    // already, which the calling screens do not do — but a state machine that
    // trusts its caller's arithmetic is exactly the kind of bug this file
    // exists to keep out of a component. Answered as a failure with the same
    // recovery actions as any other, not a silent no-op.
    return {
      kind: "failure",
      message: "This receipt already has the most sections FinSight can hold.",
    };
  }

  try {
    const scanned = await scan(remaining);
    // scanReceiptWithNativeDocumentScanner never resolves with an empty array
    // (it throws first) — this is defensive, and treated as a cancellation
    // rather than a failure: nothing was captured, which is exactly what
    // backing out of the scanner without taking a photo looks like.
    if (scanned.length === 0) return { kind: "cancelled" };
    return { kind: "success", sections: [...existingSections, ...scanned] };
  } catch (error) {
    if (isScannerCancellation(error)) return { kind: "cancelled" };
    return { kind: "failure", message: scannerFailureMessage(error) };
  }
}

/**
 * Guards against two scanner launches racing each other.
 *
 * A plain boolean rather than component state, for the same reason the old
 * camera's `captureLock` ref existed: state updates are asynchronous, so two
 * taps landing in the same frame (a slow double-tap on "Retry scanner", or the
 * mount-time auto-launch effect re-running under React's dev-mode double
 * invoke) would both read the old "not launching" value. `tryEnter` is
 * synchronous and is what actually makes a second launch impossible while one
 * is already in flight.
 */
export function createScannerLaunchGuard() {
  let inFlight = false;
  return {
    /** True and locks if nothing was already running; false if it was. */
    tryEnter(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    /** Always safe to call, including when nothing was locked. */
    exit(): void {
      inFlight = false;
    },
    get isInFlight(): boolean {
      return inFlight;
    },
  };
}
