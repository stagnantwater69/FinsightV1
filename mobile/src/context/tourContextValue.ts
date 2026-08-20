import { createContext, useContext } from "react";

/**
 * The tour's context object and its reader, split out from the provider.
 *
 * WHY A SEPARATE FILE. TourContext.tsx renders TourOverlay, and TourOverlay
 * reads the context — a require cycle, which Metro reports at startup and
 * which is not merely cosmetic: whichever module loads second sees the other's
 * exports half-initialised, so the failure mode is an undefined import at some
 * point in the future rather than an error today. Nothing renders anything
 * here, so both sides can depend on it and neither depends on the other.
 *
 * The name is deliberately not a case variation of TourContext.tsx: two files
 * differing only in case are the same file on macOS and Windows checkouts.
 */

export interface TourHomeStage {
  onHomeTab: boolean;
  dashboardLoaded: boolean;
}

export interface TourContextValue {
  active: boolean;
  stepIndex: number;
  /** id of the current step, or null when no tour is running. */
  activeStepId: string | null;
  /** Forward over the steps whose targets are on screen; finishes at the end. */
  next: () => void;
  /** Backward over the same set; a no-op on the first eligible step. */
  back: () => void;
  stop: (status: "completed" | "skipped") => void;
  /** Rewind to step 0 and re-arm the start gate — the More screen's entry. */
  restart: () => void;
  alwaysShow: boolean;
  setAlwaysShow: (value: boolean) => void;
  /** Home tells the provider when it is focused and its summary has landed. */
  reportHomeStage: (stage: TourHomeStage) => void;
}

export const TourContext = createContext<TourContextValue | null>(null);

/**
 * Null-safe consumer. The provider only exists inside the signed-in navigator,
 * and several of the components that read it (the More screen, Home) are also
 * reachable in states where it does not — so nothing here may assume it.
 */
export function useTourOptional() {
  return useContext(TourContext);
}
