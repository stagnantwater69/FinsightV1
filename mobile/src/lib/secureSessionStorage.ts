import * as SecureStore from "expo-secure-store";

/**
 * Supabase session storage in the device keystore (see lib/supabase.ts for why
 * the keystore rather than AsyncStorage).
 *
 * SecureStore has a ~2048-byte practical limit per value and a Supabase session
 * (two JWTs plus the user object) regularly exceeds it, so values are chunked.
 * The limit is in BYTES, and a name like "Peña" in the user object is wider in
 * UTF-8 than it is in JavaScript characters, so chunks are cut by encoded size.
 */

const CHUNK_BYTES = 1800; // headroom under SecureStore's ~2048-byte guidance

/** Split on code points, keeping each piece at or below `maxBytes` of UTF-8. */
export function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character;
    bytes += width;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * SecureStore keys must match /^[A-Za-z0-9._-]+$/. Supabase's default key
 * (`sb-<ref>-auth-token`) already complies, but a caller-supplied one might
 * not, so it is normalised rather than trusted.
 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export const secureStoreAdapter = {
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

    const chunks = splitUtf8(value, CHUNK_BYTES);
    if (chunks.length <= 1) {
      await SecureStore.setItemAsync(k, value);
      return;
    }

    // Chunks first, header last: if this is interrupted, the header either
    // isn't there (reads as "no session") or all chunks already are. The old
    // header goes first, or it would count the new chunks written so far and
    // hand back a truncated session.
    await SecureStore.deleteItemAsync(k);
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
