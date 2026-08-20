import type { TourStatus } from "./tourStorage";

/**
 * The one decision "does the tour open now?" comes down to.
 *
 * A PURE FUNCTION, ON PURPOSE. There is no render harness in this project, so
 * a rule living inside TourContext's effect could not be tested at all — and
 * this is the rule that decides whether an owner who has already been through
 * the tour gets it thrown over their dashboard again. The context does the
 * plumbing (reading the keystore, watching focus); this decides.
 *
 * The conditions mirror web's TourProvider, condition for condition:
 *
 *   - A SELECTED BUSINESS PROFILE. Someone who skipped setup has an app whose
 *     header, quick actions and dashboard all render nothing — touring an
 *     empty shell teaches nothing. Their status stays not_started, so the tour
 *     offers itself once a business exists.
 *   - ON THE HOME TAB, WITH ITS DATA LOADED. Every target except the tab bar
 *     lives on Home. Starting before the figures land would spotlight a
 *     skeleton; starting on another tab would point at things that are not
 *     there.
 *   - A STORED STATUS THAT IS NOT TERMINAL. completed and skipped both mean
 *     "I have dealt with this", and neither should be second-guessed.
 *
 * ...unless `alwaysShow` is on, which overrides the terminal statuses and
 * nothing else. It cannot conjure a tour without a business or off the Home
 * tab, because those two are not preferences — they are whether there is
 * anything to point at.
 */

export interface TourGateInput {
  /** What the keystore says about this user's last run. */
  status: TourStatus;
  /** "Replay on every login", from the More screen's Preferences section. */
  alwaysShow: boolean;
  hasProfile: boolean;
  /** Home's summary has actually arrived — not merely that Home is mounted. */
  dashboardLoaded: boolean;
  onHomeTab: boolean;
}

export function shouldStartTour({
  status,
  alwaysShow,
  hasProfile,
  dashboardLoaded,
  onHomeTab,
}: TourGateInput): boolean {
  if (!hasProfile || !onHomeTab || !dashboardLoaded) return false;
  if (alwaysShow) return true;
  return status !== "completed" && status !== "skipped";
}

/**
 * Where a run picks up.
 *
 * An interrupted tour (the phone locked, a call came in, the owner wandered
 * off to Records) is stored as in_progress with its step and resumes there.
 * Anything else — including a replay driven by `alwaysShow` over a completed
 * status — starts at the beginning, because that is what "show me the tour
 * again" means.
 *
 * The stored index is clamped rather than trusted: a shortened step list would
 * otherwise resume past the end and open on nothing.
 */
export function resumeStepIndex(
  status: TourStatus,
  step: number | undefined,
  stepCount: number,
): number {
  if (stepCount <= 0) return 0;
  if (status !== "in_progress") return 0;
  if (typeof step !== "number" || !Number.isFinite(step) || step < 0) return 0;
  return Math.min(Math.floor(step), stepCount - 1);
}
