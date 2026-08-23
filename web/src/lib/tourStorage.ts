import type { TourStatus, UserPreferences } from "./types";

/**
 * Where the product tour's progress lives.
 *
 * THE SERVER IS NOW THE SOURCE OF TRUTH. `tourStatus`/`tourStep`/
 * `tourAlwaysShow` are columns on the user row, read with GET /auth/me and
 * written with PATCH /auth/me/preferences — so a tour finished on a laptop is
 * not offered again on a phone, which is exactly the trade-off this module
 * used to document as accepted.
 *
 * LOCALSTORAGE STAYS, AS A CACHE. It is what the auto-start gate can read
 * synchronously on the first render, before /auth/me has answered: without it
 * the tour would either flash open over a dashboard someone already toured, or
 * have to be suppressed until the network settled. It is also what keeps the
 * tour usable when the account request fails outright.
 *
 * Keyed by user id for the same reason lib/onboardingDraft.ts is: a shared
 * computer is the normal case for this product. Without the key, one owner
 * skipping the tour would silence it for every account on the machine.
 *
 * Every access is wrapped in try/catch — Safari private mode throws on
 * setItem, and a storage failure must never take the dashboard down with it.
 *
 * This file is the seam. TourContext asks it what to believe (`reconcile`)
 * and what to send (`preferencePatch`); it does not know the shape of the
 * preferences payload, and no API call is made from here — the one writer of
 * preferences is AuthContext, so the settings screen and the tour cannot end
 * up holding two different answers.
 */

export type { TourStatus };

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
   * flag is the supported way to keep it on — set from Account settings, and
   * left alone by `stop()` so finishing the tour does not quietly switch it
   * off.
   */
  alwaysShow?: boolean;
}

/** The subset of UserPreferences this module ever writes. */
export type TourPreferencePatch = Pick<UserPreferences, "tourStatus" | "tourStep" | "tourAlwaysShow">;

const KEY_PREFIX = "finsight.tour.";

const STATUSES: readonly TourStatus[] = ["not_started", "in_progress", "completed", "skipped"];

/**
 * The largest step index the API will store (MAX_TOUR_STEP in
 * auth.controller.ts). Clamped rather than trusted, because a corrupt cache
 * entry must not turn into a 400 that loses the whole migration.
 */
const MAX_TOUR_STEP = 100;

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

/** What to send the server for a given local state. */
export function preferencePatch(tour: StoredTour): TourPreferencePatch {
  return {
    tourStatus: tour.status,
    tourStep: Math.min(Math.max(tour.step ?? 0, 0), MAX_TOUR_STEP),
    tourAlwaysShow: tour.alwaysShow === true,
  };
}

/** The account's stored preferences, read as local tour state. */
export function fromPreferences(preferences: UserPreferences): StoredTour {
  return {
    status: preferences.tourStatus ?? "not_started",
    step: typeof preferences.tourStep === "number" && preferences.tourStep >= 0 ? preferences.tourStep : undefined,
    alwaysShow: preferences.tourAlwaysShow === true,
  };
}

export interface Reconciled {
  /** What both the cache and the gate should now believe. */
  tour: StoredTour;
  /** Non-null when the server has to be told about local state — see below. */
  push: TourPreferencePatch | null;
}

/**
 * Decides, once per sign-in, whether local state goes up or server state comes
 * down.
 *
 * MIGRATE UP EXACTLY ONCE. `tourStatus === null` is the server saying it has
 * never been told anything about this account — every user row starts that way,
 * including the rows of owners who completed the tour back when it was
 * localStorage-only. Reading a null as "not_started" and carrying on would
 * re-offer the tour to all of them, and the first thing the tour then wrote
 * would bury the completed state for good. So a null adopts whatever is
 * cached here and sends it up; anything else wins over the cache, because it
 * is the account's answer and this machine's may be from another era.
 */
export function reconcile(local: StoredTour, preferences: UserPreferences): Reconciled {
  if (preferences.tourStatus === null) {
    return { tour: local, push: preferencePatch(local) };
  }
  return { tour: fromPreferences(preferences), push: null };
}
