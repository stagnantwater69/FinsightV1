import * as SecureStore from "expo-secure-store";

/**
 * Where the product tour's progress lives on a phone.
 *
 * WHY LOCAL AND NOT A COLUMN — the same reasoning web/src/lib/tourStorage.ts
 * carries, and deliberately unchanged. The User model has no settings or
 * preferences field, and adding one for a boolean-ish flag is a schema
 * migration plus an endpoint plus contract tests: real work the tour must not
 * block on. This module is the seam. It exposes read/write of one small record
 * and nothing else, so swapping the inside for an API call later touches
 * exactly one file per client. Until then the documented trade-off is that
 * tour state is per-device — someone who completes the tour on their laptop is
 * offered it again on their phone. For a guided tour that is one visible Skip
 * away, not data loss.
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

export type TourStatus = "not_started" | "in_progress" | "completed" | "skipped";

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
 * and a toggle on the More screen — and a plain `writeTour` from either would
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
