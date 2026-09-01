import { useCallback, useEffect, useRef, useState } from "react";
import * as haptics from "../../lib/haptics";
import { scanReceiptWithNativeDocumentScanner } from "../../lib/nativeReceiptScanner";
import { ANDROID_RECEIPT_SCANNER_ENABLED } from "../../lib/receiptScannerFeature";
import {
  createScannerLaunchGuard,
  launchReceiptScanner,
  type ScannerLaunchOutcome,
} from "../../lib/receiptScannerLaunch";
import { ScannerFailureState, ScannerLaunchingState, ScannerUnsupportedState } from "./ScannerStatusStates";
import type { ReceiptSection } from "../../lib/receiptCapture";

/**
 * FinSight's Android receipt scanner: Google ML Kit Document Scanner, and
 * nothing else.
 *
 * WHAT THIS USED TO BE. Until this replacement, this file rendered FinSight's
 * own camera on `expo-camera` — a manual shutter, a receipt-shaped guide, a
 * torch toggle, an overlap guide for long receipts, and a post-shutter crop
 * editor — with the platform document scanner offered as an ADDITIONAL button
 * above the shutter. That custom camera is gone from this journey. It is not
 * a fallback any more: a scanner failure, a cancellation or an unsupported
 * runtime all stay on THIS component's own states (see
 * `./ScannerStatusStates`) and never open a viewfinder FinSight draws itself.
 * See `docs/receipt-camera.md` for the full account of why, and
 * `docs/receipt-scanner-improvement-plan.md` for what shipped in each phase.
 *
 * WHY NO FALLBACK, RATHER THAN "SCANNER FIRST, CAMERA IF IT FAILS". A silent
 * switch between two different capture implementations is exactly the
 * behaviour the product decision this component implements forbids — see the
 * `ScannerFailureState` comment. A genuine failure is shown, with a retry that
 * re-opens the SAME scanner and a "Go back" that leaves this screen; neither
 * quietly hands the owner a different camera they did not choose.
 *
 * THE ONE RULE THIS SCREEN STILL ENFORCES: nothing is uploaded from here.
 * `onDone` hands the approved pages to the caller (`ScanReceiptScreen` or the
 * tab bar's Scan modal in App.tsx) as an ordinary `ReceiptSection[]`, in the
 * same shape and the same reading order the manual camera used to produce —
 * the review, upload, OCR and confirmation pipeline downstream of it is
 * completely unchanged. ML Kit itself never creates a financial record.
 *
 * PLATFORM SCOPE. Android only, and only inside a native development/EAS
 * build — `ANDROID_RECEIPT_SCANNER_ENABLED` is false on iOS, inside Expo Go,
 * and when the feature is explicitly configured off (see
 * `lib/receiptScannerConfig.ts`). Every one of those renders
 * `ScannerUnsupportedState` instead of attempting the dynamic import that
 * would otherwise ask Nitro for a native module Expo Go cannot provide.
 */
export function ReceiptCamera({
  initialSections = [],
  onCancel,
  onDone,
}: {
  /**
   * Sections already photographed in this receipt's session, from a previous
   * "Add another section" round. Appended to, never replaced — see
   * `launchReceiptScanner`.
   */
  initialSections?: ReceiptSection[];
  onCancel: () => void;
  /** Handed the finished session, in reading order. Never called empty. */
  onDone: (sections: ReceiptSection[]) => void;
}) {
  const [state, setState] = useState<"launching" | "unsupported" | "failed">(
    ANDROID_RECEIPT_SCANNER_ENABLED ? "launching" : "unsupported",
  );
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  /**
   * The concurrency guard requirement 3 asks for: two launch attempts (the
   * mount-time auto-launch and a fast double-tap on "Retry scanner") must not
   * both be able to open the scanner at once. `useRef` rather than the guard
   * living in component state for the same reason the old camera's
   * `captureLock` did — see `createScannerLaunchGuard`'s own comment.
   */
  const guard = useRef(createScannerLaunchGuard());

  const launch = useCallback(() => {
    if (!guard.current.tryEnter()) return;
    setState("launching");
    setFailureMessage(null);

    void launchReceiptScanner(initialSections, scanReceiptWithNativeDocumentScanner, ANDROID_RECEIPT_SCANNER_ENABLED)
      .then((outcome: ScannerLaunchOutcome) => {
        switch (outcome.kind) {
          case "success":
            haptics.succeeded();
            onDone(outcome.sections);
            return;
          case "cancelled":
            // Cancellation is not an error — see the requirement this
            // implements. Returns to whatever screen opened this one without
            // any notice at all.
            onCancel();
            return;
          case "unsupported":
            setState("unsupported");
            return;
          case "failure":
            haptics.failed();
            setFailureMessage(outcome.message);
            setState("failed");
            return;
        }
      })
      .finally(() => guard.current.exit());
  }, [initialSections, onCancel, onDone]);

  /**
   * Launches automatically on mount — "Scan receipt" opening this screen IS
   * the action that opens ML Kit, with no extra button in between. Mount-only:
   * `launch` closes over `initialSections`, which is fixed for the life of
   * this component (a fresh mount is how a new "Add another section" round
   * arrives, carrying the updated list as a new prop).
   */
  useEffect(() => {
    launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "unsupported") return <ScannerUnsupportedState onCancel={onCancel} />;
  if (state === "failed") {
    return (
      <ScannerFailureState
        message={failureMessage ?? "Auto scan couldn't start on this device or build."}
        onRetry={launch}
        onGoBack={onCancel}
      />
    );
  }
  return <ScannerLaunchingState />;
}
