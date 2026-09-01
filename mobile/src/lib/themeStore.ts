import * as SecureStore from "expo-secure-store";

import type { ThemeMode, ThemePreference } from "../theme/palette";

/**
 * Where the appearance preference lives on a phone.
 *
 * PER-DEVICE, NOT PER-ACCOUNT, and deliberately so. Which theme someone wants
 * is a property of the screen they are looking at — a phone held in bright
 * sunlight at a market stall wants Light; the same owner's laptop indoors at
 * midnight does not have to agree. Syncing it would also mean a schema
 * migration, an endpoint and contract tests for a two-valued preference, which
 * is the same trade-off tourStorage.ts already reasoned through and declined.
 *
 * NOT KEYED BY USER, unlike tourStorage/onboardingDraft. Those are about what
 * an owner has been TAUGHT, which belongs to the person. This is about the
 * device's screen, and it has to be readable before anyone has signed in —
 * the login screen is the first thing painted on a cold start and it must not
 * flash white at someone who chose Dark.
 *
 * SecureStore rather than AsyncStorage, for the reason savedAccountStore.ts
 * gives: it is the key-value store the app already ships with, and none of
 * this is worth a new dependency.
 *
 * Every function swallows its errors. A preference that cannot be saved is a
 * small annoyance; a throw out of the provider that wraps the entire app is a
 * blank screen.
 */

// SecureStore keys must be alphanumeric, ".", "-" or "_" — no other punctuation.
const KEY = "finsight.appearance";

/**
 * What a device shows before anyone has chosen.
 *
 * STILL LIGHT, not "system", now that a system option exists — and that is a
 * deliberate, slightly awkward choice. There is nothing in this key that
 * distinguishes "a fresh install" from "an owner who has been running the
 * Light app since before the third option existed", because the absence of a
 * stored value is what both look like. Defaulting to "system" would therefore
 * flip the second group's app to Dark at sunset, unasked, on upgrade — the
 * silent redesign this comment has always argued against. An owner who wants
 * the phone to decide can say so in Settings in two taps; an owner who did not
 * ask for a change should not receive one.
 *
 * Any explicit choice already in the keystore reads back unchanged: "light"
 * and "dark" were the only values ever written, and both are still valid
 * preferences meaning exactly what they meant.
 */
export const DEFAULT_THEME: ThemeMode = "light";

/** The preference form of the same default. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = DEFAULT_THEME;

const MODES: readonly ThemeMode[] = ["light", "dark"];
const PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

const isMode = (value: unknown): value is ThemeMode =>
  typeof value === "string" && (MODES as readonly string[]).includes(value);

const isPreference = (value: unknown): value is ThemePreference =>
  typeof value === "string" && (PREFERENCES as readonly string[]).includes(value);

/**
 * What the owner chose, including "let the phone decide".
 *
 * THE SAME KEY as the mode functions below, on purpose. This is not a second
 * setting living beside the old one; it is the same setting with one more
 * legal value, so a stored "dark" is still a stored "dark" and there is no
 * migration step, no dual write and no window where the two disagree.
 */
export async function readThemePreference(): Promise<ThemePreference> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    // Anything unrecognised — a value from a future build, a truncated write —
    // reads as "never chosen". The worst case is one theme switch to redo,
    // never an app painted in half a palette.
    return isPreference(raw) ? raw : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export async function writeThemePreference(preference: ThemePreference): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, preference);
  } catch {
    // Intentionally ignored — see the module comment.
  }
}

/**
 * The narrow, palette-shaped view of the same key.
 *
 * Kept because a `ThemeMode` — a value that always names a real palette — is
 * what anything painting a colour wants, and because it is the honest answer
 * for a caller that cannot resolve "system" for itself. A stored "system"
 * reads as the default here rather than as a scheme, since this function has
 * no access to the device's scheme and guessing would be worse than saying
 * "the plain default". The app itself does not use this path: ThemeContext
 * reads the preference and resolves it against `Appearance`.
 */
export async function readThemeMode(): Promise<ThemeMode> {
  const preference = await readThemePreference();
  return isMode(preference) ? preference : DEFAULT_THEME;
}

export async function writeThemeMode(mode: ThemeMode): Promise<void> {
  await writeThemePreference(mode);
}
