import { createContext, useContext } from "react";

/**
 * The tour's context object and its reader, split out from the provider.
 *
 * TourContext.tsx renders TourOverlay and TourOverlay reads the context, so
 * keeping both here breaks the import cycle between them: nothing in this
 * file renders anything, so either side can depend on it. Mobile does the
 * same in mobile/src/context/tourContextValue.ts.
 *
 * The name is deliberately not a case variation of TourContext.tsx: two files
 * differing only in case are the same file on macOS and Windows checkouts.
 */

export interface TourContextValue {
  /** id of the active step, or null. */
  activeStepId: string | null;
  active: boolean;
  /** The dashboard should show the "take the tour?" invitation. */
  offered: boolean;
  /** Accept the invitation: open the tour at step 0. */
  accept: () => void;
  /** Decline the invitation. Stored as `skipped`; the menu can still restart it. */
  decline: () => void;
  /**
   * Whether there is anything worth touring yet.
   *
   * False for an owner who chose "Skip for now" and has no business. The
   * provider's auto-start has always honoured that; `restart` did not, and the two
   * entry points disagreeing is what made "Restart product tour" produce a
   * four-step stub of a ten-step tour. The controls that offer the tour read
   * this so they can say WHY it is unavailable rather than doing nothing.
   */
  available: boolean;
  stepIndex: number;
  setStepIndex: (i: number) => void;
  /** Ends the tour and records why. */
  stop: (status: "completed" | "skipped") => void;
  /** Rewinds to step 0 and (re)arms auto-start — the account-menu entry. */
  restart: () => void;
  /** Replay on every sign-in, regardless of a completed/skipped status. */
  alwaysShow: boolean;
  /**
   * Rejects if the account could not be told, having already put the switch
   * back — so the settings screen can say so rather than showing a preference
   * that only this browser believes.
   */
  setAlwaysShow: (value: boolean) => Promise<void>;
}

/** Exported for tests/harnesses that drive the overlay with a hand-built value. */
export const TourContext = createContext<TourContextValue | null>(null);

/** Null-safe consumer for chrome that may render without the provider (tests). */
export function useTourOptional() {
  return useContext(TourContext);
}
