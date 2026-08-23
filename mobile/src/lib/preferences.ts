import type { UserPreferences } from "./types";

/**
 * Account preferences, and the one rule for changing one.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE AuthContext (which is where
 * web keeps it): this project has no render harness, so anything written
 * inside a provider cannot be tested at all. The rule below is the one an
 * owner notices when it is wrong — a switch that stays where they left it
 * while the account never heard about the change — so it lives where a test
 * can drive it.
 */

/**
 * What an account looks like before its preferences arrive, and what a brand
 * new one gets.
 *
 * The mascot greeting defaults ON: it is Home's opening line today, and a
 * preference that has not loaded yet must never read as "the owner turned this
 * off" — that would blank the top of the dashboard on every cold start for a
 * beat, which looks like a bug and is one.
 *
 * `tourStatus`/`tourStep` default to null rather than "not_started"/0 because
 * null is the server's own "never been told", and lib/tourStorage.ts's
 * migrate-up depends on being able to tell those two apart.
 */
export const DEFAULT_PREFERENCES: UserPreferences = {
  showDashboardMascotMessage: true,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
};

/** A partial change laid over whatever is currently believed. */
export function mergePreferences(
  current: UserPreferences | null,
  patch: Partial<UserPreferences>,
): UserPreferences {
  return { ...(current ?? DEFAULT_PREFERENCES), ...patch };
}

/**
 * Applies a preference change optimistically, and puts it back if the account
 * refuses it.
 *
 * OPTIMISTIC, because these are switches: a toggle that waits for a round trip
 * before moving reads as a dead control on a phone with one bar of signal, and
 * every one of these settings is cheap to undo.
 *
 * ROLLBACK AND RETHROW, because the alternative is worse than the delay — a
 * switch left in the new position after a failed write promises a setting that
 * this phone believes and no other device will ever see. The throw is what
 * lets the caller say so.
 *
 * PARTIAL, not a whole-object write. The settings screen and the tour write
 * different fields from different places, and a whole-object write from either
 * would clobber the other's field with a stale value.
 *
 * `apply` is called with the SERVER'S answer on success rather than the local
 * merge, so a field another device changed since this one loaded comes down
 * with the reply instead of being silently re-asserted.
 */
export async function commitPreferences({
  current,
  patch,
  apply,
  send,
}: {
  current: UserPreferences | null;
  patch: Partial<UserPreferences>;
  apply: (next: UserPreferences | null) => void;
  send: (patch: Partial<UserPreferences>) => Promise<UserPreferences>;
}): Promise<void> {
  apply(mergePreferences(current, patch));
  try {
    apply(await send(patch));
  } catch (err) {
    apply(current);
    throw err;
  }
}
