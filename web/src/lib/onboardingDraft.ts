/**
 * Remembering a half-finished business setup between visits.
 *
 * WHY THIS IS LOCAL AND NOT A COLUMN. "Setup is incomplete" is already true
 * server-side and needs no new storage: it is exactly `the user has no business
 * profiles`. Skipping the wizard creates nothing, so the next sign-in finds
 * zero profiles and offers to resume — on any device, with no migration, and
 * with every existing owner automatically excluded because they already have
 * one.
 *
 * What that derivation cannot recover is the TYPING. Someone who filled in two
 * fields and got interrupted should not lose them, and that is all this file
 * stores: the draft answers, and whether they have dismissed the wizard so it
 * stops taking over the screen on arrival.
 *
 * Everything is keyed by user id, because a shared computer is the normal case
 * for this app, not an edge case. Without that key, one owner's half-typed
 * figures would appear in the next owner's setup form.
 */
import type { BusinessProfileDraft } from "./businessProfileDraft";

interface StoredOnboarding {
  draft?: Partial<BusinessProfileDraft>;
  /** Set when the owner chose "Skip for now" — stops the auto-redirect, keeps the resume banner. */
  dismissed?: boolean;
}

const KEY_PREFIX = "finsight.onboarding.";

function keyFor(userId: number) {
  return `${KEY_PREFIX}${userId}`;
}

/*
 * Every access is wrapped: Safari in private mode throws on setItem once the
 * quota is zero, and a storage failure must never be the thing that stops
 * someone from setting up their business. Losing the draft is a small,
 * recoverable annoyance; a thrown exception out of a render is not.
 */
export function readOnboarding(userId: number): StoredOnboarding {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredOnboarding) : {};
  } catch {
    return {};
  }
}

function write(userId: number, value: StoredOnboarding) {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(value));
  } catch {
    // Intentionally ignored — see above.
  }
}

export function saveOnboardingDraft(userId: number, draft: BusinessProfileDraft) {
  write(userId, { ...readOnboarding(userId), draft });
}

export function dismissOnboarding(userId: number) {
  write(userId, { ...readOnboarding(userId), dismissed: true });
}

/**
 * Called once the business profile actually exists.
 *
 * The draft is dead at that point — it has become a row — and keeping it would
 * mean a later "add another business" opened pre-filled with the first one's
 * figures.
 */
export function clearOnboarding(userId: number) {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Intentionally ignored — see above.
  }
}
