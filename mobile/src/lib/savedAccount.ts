/**
 * The rules for saving an account, with nothing that reaches native code.
 *
 * NOTHING HERE IMPORTS expo-secure-store, OR ANYTHING FROM REACT NATIVE, and
 * that is what keeps it runnable under plain vitest — the same rule
 * lib/receiptCapture.ts follows. The keystore-backed half lives in
 * lib/savedAccountStore.ts.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It saves the EMAIL ADDRESS, so the login
 * form arrives filled in. It is not "keep me logged in": staying signed in
 * across restarts is what the session already does, on its own, and this
 * checkbox does not touch it. It is also not a saved password — a password is
 * never written anywhere by this app, whichever way the box is set.
 */

/** Keys must match SecureStore's /^[A-Za-z0-9._-]+$/. */
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
