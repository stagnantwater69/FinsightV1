import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import Constants from "expo-constants";

/**
 * Supabase client for React Native, with the session held in the device
 * keystore rather than AsyncStorage.
 *
 * WHY THIS DIFFERS FROM WEB: the browser keeps its session in localStorage,
 * which is the only option there and is scoped by origin. On a device,
 * AsyncStorage is an unencrypted file in the app sandbox — readable on a rooted
 * or jailbroken phone, and in some backup scenarios. expo-secure-store puts it
 * in the Android Keystore / iOS Keychain instead. These are auth tokens for a
 * financial record system, so that difference is worth the small extra
 * complexity.
 *
 * SecureStore has a ~2048-byte practical limit per value and a Supabase session
 * (two JWTs plus the user object) regularly exceeds it, so values are chunked.
 */

const CHUNK_LIMIT = 1800; // headroom under SecureStore's ~2048-byte guidance

/**
 * SecureStore keys must match /^[A-Za-z0-9._-]+$/. Supabase's default key
 * (`sb-<ref>-auth-token`) already complies, but a caller-supplied one might
 * not, so it is normalised rather than trusted.
 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

const secureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const k = safeKey(key);
    const head = await SecureStore.getItemAsync(k);
    if (head === null) return null;

    // A chunked value stores "__chunks__:<n>" in the head key.
    const match = /^__chunks__:(\d+)$/.exec(head);
    if (!match) return head;

    const count = Number(match[1]);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${k}.${i}`);
      // A partially-written value is unusable; treat it as absent so the user
      // is asked to sign in again rather than handed a corrupt session.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join("");
  },

  async setItem(key: string, value: string): Promise<void> {
    const k = safeKey(key);
    await clearChunks(k);

    if (value.length <= CHUNK_LIMIT) {
      await SecureStore.setItemAsync(k, value);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_LIMIT) {
      chunks.push(value.slice(i, i + CHUNK_LIMIT));
    }
    // Chunks first, header last: if this is interrupted, the header either
    // isn't there (reads as "no session") or all chunks already are.
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(`${k}.${i}`, chunks[i]!);
    }
    await SecureStore.setItemAsync(k, `__chunks__:${chunks.length}`);
  },

  async removeItem(key: string): Promise<void> {
    const k = safeKey(key);
    await clearChunks(k);
    await SecureStore.deleteItemAsync(k);
  },
};

async function clearChunks(k: string) {
  const head = await SecureStore.getItemAsync(k);
  const match = head && /^__chunks__:(\d+)$/.exec(head);
  if (!match) return;
  const count = Number(match[1]);
  for (let i = 0; i < count; i++) {
    await SecureStore.deleteItemAsync(`${k}.${i}`);
  }
}

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

export const SUPABASE_URL = extra.supabaseUrl ?? "";
export const SUPABASE_ANON_KEY = extra.supabaseAnonKey ?? "";
export const API_BASE_URL = extra.apiBaseUrl ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !API_BASE_URL) {
  throw new Error(
    "Missing mobile configuration. Copy mobile/.env.example to mobile/.env and fill in " +
      "EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY."
  );
}

/**
 * A throwaway client for the password-reset screen, and nowhere else.
 *
 * The token in a reset deep link is a real credential — enough to change the
 * password on the account — so it must be usable for that one operation and
 * then be gone. Nothing here persists: the token never reaches the keystore, an
 * abandoned reset leaves nothing behind, and a session that was already stored
 * (someone else still signed in on a shared phone) is untouched.
 */
export function createRecoveryClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // On web (Expo's react-native-web target, used for layout verification)
    // SecureStore is unavailable — fall back to the default browser storage
    // there. Device builds always use the keystore.
    storage: Platform.OS === "web" ? undefined : secureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // No URL to parse a session out of on a device.
    detectSessionInUrl: false,
  },
});
