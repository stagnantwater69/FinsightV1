import * as SecureStore from "expo-secure-store";
import type { BusinessProfileDraft } from "./businessProfileDraft";

/**
 * Remembering a half-finished business setup between launches.
 *
 * WHY THIS IS LOCAL AND NOT A COLUMN. "Setup is incomplete" is already true
 * server-side and needs no new storage: it is exactly `the user has no business
 * profiles`. Skipping the wizard creates nothing, so the next launch finds zero
 * profiles and offers to resume — with no migration, and with every existing
 * owner automatically excluded because they already have one.
 *
 * What that derivation cannot recover is the TYPING, which is all this file
 * keeps: the draft answers, and whether the owner has dismissed the wizard so
 * it stops taking over the screen on launch.
 *
 * SecureStore rather than AsyncStorage for the reason savedAccountStore.ts
 * gives: it is the key-value store the app already ships with, and none of this
 * is worth a new dependency.
 *
 * Keyed by user id — a phone gets handed around a shop, and without that key
 * one owner's half-typed figures would surface in the next owner's setup.
 *
 * Every function swallows its errors. A draft that cannot be saved is a small,
 * recoverable annoyance; a throw out of setup is not.
 */

interface StoredOnboarding {
  draft?: Partial<BusinessProfileDraft>;
  /** Set on "Skip for now" — stops the wizard opening on launch, keeps the resume prompt. */
  dismissed?: boolean;
}

// SecureStore keys must be alphanumeric, ".", "-" or "_" — no other punctuation.
const keyFor = (userId: number) => `finsight.onboarding.${userId}`;

export async function readOnboarding(userId: number): Promise<StoredOnboarding> {
  try {
    const raw = await SecureStore.getItemAsync(keyFor(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredOnboarding) : {};
  } catch {
    return {};
  }
}

async function write(userId: number, value: StoredOnboarding) {
  try {
    await SecureStore.setItemAsync(keyFor(userId), JSON.stringify(value));
  } catch {
    // Intentionally ignored — see above.
  }
}

export async function saveOnboardingDraft(userId: number, draft: BusinessProfileDraft) {
  await write(userId, { ...(await readOnboarding(userId)), draft });
}

export async function dismissOnboarding(userId: number) {
  await write(userId, { ...(await readOnboarding(userId)), dismissed: true });
}

/**
 * Called once the business profile actually exists.
 *
 * The draft is dead at that point — it has become a row — and keeping it would
 * mean a later "add another business" opening pre-filled with the first one's
 * figures.
 */
export async function clearOnboarding(userId: number) {
  try {
    await SecureStore.deleteItemAsync(keyFor(userId));
  } catch {
    // Intentionally ignored — see above.
  }
}
