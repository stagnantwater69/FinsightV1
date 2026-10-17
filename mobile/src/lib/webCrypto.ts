import * as ExpoCrypto from "expo-crypto";

type DigestInput = Parameters<typeof ExpoCrypto.digest>[1];

/** What may or may not be on `globalThis.crypto` at runtime. */
interface LooseCrypto {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
  subtle?: { digest?: (algorithm: string | { name: string }, data: DigestInput) => Promise<ArrayBuffer> };
}

/**
 * Gives Supabase's PKCE flow the two Web Crypto calls Hermes does not have.
 *
 * Without them auth-js falls back to a `Math.random()` code verifier and the
 * weaker `plain` challenge method (see generatePKCEVerifier and
 * generatePKCEChallenge in @supabase/auth-js). Google sign-in is the one place
 * that matters: the verifier is what stops another app that intercepts the
 * `finsight://` redirect from spending the authorisation code.
 *
 * Only fills in what is missing, and only these two members, so a runtime that
 * already has Web Crypto is left exactly as it was.
 */
export function ensureWebCrypto(): void {
  const g = globalThis as unknown as { crypto?: LooseCrypto };
  g.crypto ??= {};
  const crypto = g.crypto;
  if (typeof crypto.getRandomValues !== "function") {
    crypto.getRandomValues = (array) => ExpoCrypto.getRandomValues(array);
  }
  if (typeof crypto.subtle?.digest !== "function") {
    crypto.subtle = {
      ...(crypto.subtle ?? {}),
      digest: (algorithm, data) => {
        const name = typeof algorithm === "string" ? algorithm : algorithm.name;
        if (name !== "SHA-256") return Promise.reject(new Error(`Unsupported digest: ${name}`));
        return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data);
      },
    };
  }
}
