import * as SecureStore from "expo-secure-store";

import type { TourStatus, UserPreferences } from "./types";

/**
 * Where the product tour's progress lives on a phone.
 *
 * THE SERVER IS NOW THE SOURCE OF TRUTH, exactly as web/src/lib/tourStorage.ts
 * describes. `tourStatus`/`tourStep`/`tourAlwaysShow` are columns on the user
 * row, read with GET /auth/me and written with PATCH /auth/me/preferences — so
 * a tour finished on a laptop is not offered again on this phone, which is the
 * trade-off this module used to document as accepted.
 *
 * THE KEYSTORE STAYS, AS A CACHE. It is what the start gate can consult
 * without waiting on the network: without it the tour would either flash open
 * over a Home screen someone already toured, or have to be suppressed until
 * /auth/me settled. It is also what keeps the tour usable when that request
 * fails outright.
 *
 * This file is the seam, and it makes no API calls. TourContext asks it what
 * to believe (`reconcile`) and what to send (`preferencePatch`); the one
 * writer of preferences is AuthContext, so the settings screen and the tour
 * cannot end up holding two different answers.
 *
 * SecureStore rather than AsyncStorage, for the reason savedAccountStore.ts
 * gives: it is the key-value store the app already ships with, and none of
 * this is worth a new dependency.
 *
 * Keyed by user id, like onboardingDraft.ts — a phone gets handed around a
 * shop, and without the key one owner skipping the tour would silence it for
 * every account on the device.
 *
 * ASYNC WHERE WEB IS SYNC. localStorage answers immediately; SecureStore does
 * not. That difference is not hidden here — it is handed to TourContext, which
 * holds a "still reading" state and refuses to make a start/don't-start
 * decision until the stored value has actually arrived. Guessing "not seen
 * yet" while the read is in flight would open the tour over the dashboard of
 * someone who finished it weeks ago.
 *
 * Every function swallows its errors. A preference that cannot be saved is a
 * small annoyance; a throw out of the dashboard is not.
 */

/*
 * Re-exported rather than declared here: the four statuses are part of the API
 * contract (TOUR_STATUSES in auth.controller.ts) now that the server stores
 * them, and a second declaration is a second thing to keep in step. Callers
 * that think of it as tour state keep importing it from this module.
 */
export type { TourStatus };

export interface StoredTour {
  status: TourStatus;
  /** Index into TOUR_STEPS, saved so an interrupted tour can resume. */
  step?: number;
  /**
   * Replay the tour on every sign-in, whatever `status` says.
   *
   * This exists for the case the tour is most often needed for after launch:
   * showing the first-run experience to someone else — a new helper behind the
   * counter, a demo — without creating a throwaway account to get a fresh
   * `not_started` back. It is a preference rather than a one-shot, so it
   * survives the app being closed.
   */
  alwaysShow?: boolean;
}

// SecureStore keys must be alphanumeric, ".", "-" or "_" — no other punctuation.
const keyFor = (userId: number) => `finsight.tour.${userId}`;

const STATUSES: readonly TourStatus[] = ["not_started", "in_progress", "completed", "skipped"];

const BLANK: StoredTour = { status: "not_started" };

export async function readTour(userId: number): Promise<StoredTour> {
  try {
    const raw = await SecureStore.getItemAsync(keyFor(userId));
    if (!raw) return { ...BLANK };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...BLANK };

    const { status, step, alwaysShow } = parsed as Partial<StoredTour>;
    return {
      // An unrecognised status reads as "never seen the tour". The start gate
      // still requires a loaded dashboard, so the worst case of a corrupt
      // value is one extra offer, never a stuck or invisible tour.
      status: status && STATUSES.includes(status) ? status : "not_started",
      step: typeof step === "number" && Number.isFinite(step) && step >= 0 ? Math.floor(step) : undefined,
      // Only a real `true` counts. A truthy leftover of some other shape must
      // not silently pin the tour open on every launch.
      alwaysShow: alwaysShow === true ? true : undefined,
    };
  } catch {
    return { ...BLANK };
  }
}

export async function writeTour(userId: number, value: StoredTour) {
  try {
    await SecureStore.setItemAsync(keyFor(userId), JSON.stringify(value));
  } catch {
    // Intentionally ignored — see the module comment.
  }
}

/**
 * Record progress without disturbing the preference.
 *
 * The two are written from different places — the overlay advancing a step,
 * and a toggle on the Settings screen — and a plain `writeTour` from either would
 * drop whatever the other had just stored.
 */
export async function saveTourProgress(userId: number, status: TourStatus, step: number) {
  const current = await readTour(userId);
  await writeTour(userId, { ...current, status, step });
}

export async function saveAlwaysShowTour(userId: number, alwaysShow: boolean) {
  const current = await readTour(userId);
  await writeTour(userId, { ...current, alwaysShow: alwaysShow ? true : undefined });
}

/** The subset of UserPreferences this module ever writes. */
export type TourPreferencePatch = Pick<UserPreferences, "tourStatus" | "tourStep" | "tourAlwaysShow">;

/**
 * The largest step index the API will store (MAX_TOUR_STEP in
 * auth.controller.ts). Clamped rather than trusted, because a corrupt cache
 * entry must not turn into a 400 that loses the whole migration.
 */
const MAX_TOUR_STEP = 100;

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
    step:
      typeof preferences.tourStep === "number" && preferences.tourStep >= 0
        ? preferences.tourStep
        : undefined,
    alwaysShow: preferences.tourAlwaysShow === true ? true : undefined,
  };
}

export interface Reconciled {
  /** What both the cache and the start gate should now believe. */
  tour: StoredTour;
  /** Non-null when the server has to be told about local state — see below. */
  push: TourPreferencePatch | null;
}

/**
 * Decides, once per signed-in account, whether local state goes up or server
 * state comes down.
 *
 * MIGRATE UP EXACTLY ONCE. `tourStatus === null` is the server saying it has
 * never been told anything about this account — every user row starts that
 * way, including the rows of owners who finished the tour back when it lived
 * only in this keystore. Reading that null as "not_started" and carrying on
 * would re-offer the tour to all of them, and the first thing the tour then
 * wrote would bury the completed state for good. So a null adopts whatever is
 * cached on this phone and sends it up; anything else wins over the cache,
 * because it is the account's answer and this device's may be from another era.
 */
export function reconcile(local: StoredTour, preferences: UserPreferences): Reconciled {
  if (preferences.tourStatus === null) {
    return { tour: local, push: preferencePatch(local) };
  }
  return { tour: fromPreferences(preferences), push: null };
}
