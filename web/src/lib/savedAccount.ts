/**
 * Saving the account so it does not have to be typed again.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It saves the EMAIL ADDRESS, so the login
 * form arrives filled in. It is not "keep me logged in": staying signed in
 * across restarts is what the session already does, on its own, and this
 * checkbox does not touch it. It is also not a saved password — a password is
 * never written anywhere by this app, whichever way the box is set. The
 * browser's own password manager is the right place for that, and the
 * `autoComplete` attributes on the login form are what let it offer.
 *
 * An email address is not a secret, but it is personal, so the choice is the
 * owner's and unticking the box erases what was already stored rather than
 * merely stopping new writes.
 */

/** The saved address. */
export const SAVED_EMAIL_KEY = "finsight.saved-email";

/**
 * Whether to keep saving it.
 *
 * Stored separately from the address itself so the preference survives a
 * login attempt that failed before anything was worth saving — otherwise
 * "is anything stored?" would have to stand in for "did they ask for this?",
 * and a first-time owner would find the box unticked by default.
 */
export const SAVE_ACCOUNT_KEY = "finsight.save-account";

/**
 * Trimmed, because an address with a stray space is the same account and
 * prefilling one that fails to log in would be worse than prefilling nothing.
 * An empty result means there is nothing worth saving.
 */
export function normaliseSavedEmail(raw: string): string {
  return raw.trim();
}

/** Default true: the whole point is not having to type it. */
export function parseSaveAccount(raw: string | null): boolean {
  return raw !== "false";
}

export function isSavingAccount(): boolean {
  try {
    return parseSaveAccount(window.localStorage.getItem(SAVE_ACCOUNT_KEY));
  } catch {
    // Storage throws in some private modes and under some cookie policies.
    // A preference that cannot be read must not stop anyone signing in.
    return true;
  }
}

/** The address to prefill, or "" when there is none. */
export function savedEmail(): string {
  try {
    return window.localStorage.getItem(SAVED_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Records the choice and applies it to whatever is already stored.
 *
 * Unticking ERASES the saved address rather than just stopping future writes.
 * Someone turning this off on a shared machine means "do not keep my
 * address", and leaving the last one behind would answer a different
 * question from the one they were asked.
 */
export function setSavedAccount(save: boolean, email: string): void {
  try {
    window.localStorage.setItem(SAVE_ACCOUNT_KEY, save ? "true" : "false");
    const normalised = normaliseSavedEmail(email);
    if (save && normalised) window.localStorage.setItem(SAVED_EMAIL_KEY, normalised);
    else window.localStorage.removeItem(SAVED_EMAIL_KEY);
  } catch {
    // Non-fatal, as above.
  }
}
