import * as SecureStore from "expo-secure-store";

import type { ThemeMode } from "../theme/palette";

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
 * Light, not the OS setting. There is no system/auto mode here on purpose:
 * the app follows the switch in Settings and nothing else, so "what did I
 * pick" has exactly one answer. Light is the default because it is the app
 * every existing owner already has, and a silent redesign on upgrade is not
 * a feature.
 */
export const DEFAULT_THEME: ThemeMode = "light";

const MODES: readonly ThemeMode[] = ["light", "dark"];

const isMode = (value: unknown): value is ThemeMode =>
  typeof value === "string" && (MODES as readonly string[]).includes(value);

export async function readThemeMode(): Promise<ThemeMode> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    // Anything unrecognised — a value from a future build, a truncated write —
    // reads as "never chosen". The worst case is one theme switch to redo,
    // never an app painted in half a palette.
    return isMode(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export async function writeThemeMode(mode: ThemeMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, mode);
  } catch {
    // Intentionally ignored — see the module comment.
  }
}
