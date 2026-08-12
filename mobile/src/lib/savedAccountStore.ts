import * as SecureStore from "expo-secure-store";
import {
  normaliseSavedEmail,
  parseSaveAccount,
  SAVE_ACCOUNT_KEY,
  SAVED_EMAIL_KEY,
} from "./savedAccount";

/**
 * The stored side of "save my email": reading and writing it on the device.
 *
 * Separate from lib/savedAccount.ts because it reaches for the keystore,
 * which drags in react-native and so cannot be loaded by the test runner.
 * Keeping the rules testable was worth the second file.
 *
 * The keystore rather than a plain file: an email address is not a secret,
 * but SecureStore is the only key-value store this app ships with, and using
 * the one that is already there beats adding AsyncStorage for one string.
 *
 * Every function here swallows its errors. A preference that cannot be saved
 * must never be the reason someone cannot sign in.
 */

/** Whether the owner asked for their address to be kept. Default true. */
export async function isSavingAccount(): Promise<boolean> {
  try {
    return parseSaveAccount(await SecureStore.getItemAsync(SAVE_ACCOUNT_KEY));
  } catch {
    return true;
  }
}

/** The address to prefill, or "" when there is none. */
export async function savedEmail(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(SAVED_EMAIL_KEY)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Records the choice and applies it to whatever is already stored.
 *
 * Unticking ERASES the saved address rather than just stopping future writes.
 * Someone turning this off on a phone that gets handed around a shop means
 * "do not keep my address", and leaving the last one behind would answer a
 * different question from the one they were asked.
 */
export async function setSavedAccount(save: boolean, email: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(SAVE_ACCOUNT_KEY, save ? "true" : "false");
    const normalised = normaliseSavedEmail(email);
    if (save && normalised) await SecureStore.setItemAsync(SAVED_EMAIL_KEY, normalised);
    else await SecureStore.deleteItemAsync(SAVED_EMAIL_KEY);
  } catch {
    // Non-fatal, as above.
  }
}
