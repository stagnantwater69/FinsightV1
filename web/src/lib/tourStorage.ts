/**
 * Where the product tour's progress lives.
 *
 * WHY LOCALSTORAGE AND NOT A COLUMN. The User model has no settings/
 * preferences field today, and adding one for a single boolean-ish flag is a
 * schema migration plus an endpoint plus contract tests — real work that the
 * tour must not block on. This module is the seam: it exposes read/write of
 * a {status, step} pair and nothing else, so swapping the inside for an API
 * call later touches exactly one file. Until then the documented trade-off
 * is that tour state is per-device — a user who completes the tour on their
 * laptop will be offered it again on a new machine. For a guided tour that
 * is a mild annoyance (one visible Skip away), not data loss.
 *
 * Keyed by user id for the same reason lib/onboardingDraft.ts is: a shared
 * computer is the normal case for this product. Without the key, one owner
 * skipping the tour would silence it for every account on the machine.
 *
 * Every access is wrapped in try/catch — Safari private mode throws on
 * setItem, and a storage failure must never take the dashboard down with it.
 */

export type TourStatus = "not_started" | "in_progress" | "completed" | "skipped";

export interface StoredTour {
  status: TourStatus;
  /** Index into TOUR_STEPS, saved so an interrupted tour can resume. */
  step?: number;
  /**
   * Replay the tour on EVERY sign-in, ignoring a completed/skipped status.
   *
   * The tour is otherwise a once-per-account thing, which makes it almost
   * impossible to show to anyone: demonstrating it meant registering a new
   * account, and checking a change to it meant clearing storage by hand. This
   * flag is the supported way to keep it on — set from Profile, and left
   * alone by `stop()` so finishing the tour does not quietly switch it off.
   */
  alwaysShow?: boolean;
}

const KEY_PREFIX = "finsight.tour.";

const STATUSES: readonly TourStatus[] = ["not_started", "in_progress", "completed", "skipped"];

function keyFor(userId: number) {
  return `${KEY_PREFIX}${userId}`;
}

export function readTour(userId: number): StoredTour {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return { status: "not_started", alwaysShow: false };
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      STATUSES.includes((parsed as StoredTour).status)
    ) {
      const { status, step, alwaysShow } = parsed as StoredTour;
      return {
        status,
        step: typeof step === "number" && step >= 0 ? step : undefined,
        alwaysShow: alwaysShow === true,
      };
    }
    return { status: "not_started", alwaysShow: false };
  } catch {
    // Unreadable storage reads as "never seen the tour". The auto-start gate
    // still requires a loaded dashboard, so the worst case is an extra offer.
    return { status: "not_started", alwaysShow: false };
  }
}

export function writeTour(userId: number, value: StoredTour) {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(value));
  } catch {
    // Intentionally ignored — see module comment.
  }
}

/**
 * Flips the replay preference without disturbing progress.
 *
 * Read-modify-write rather than a whole-object write, because the caller is a
 * settings screen that knows nothing about which step the tour reached — and
 * overwriting `step` from there would silently restart an interrupted tour.
 */
export function setAlwaysShowTour(userId: number, alwaysShow: boolean) {
  writeTour(userId, { ...readTour(userId), alwaysShow });
}
