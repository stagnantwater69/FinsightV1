import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

/**
 * The cryptography behind the web → mobile session handoff.
 *
 * The shape of the problem: a browser has just confirmed an email address and
 * holds a live session, and the owner wants to continue in the installed app.
 * The only channel between the two is a URL, and a URL is the one place a
 * refresh token must never go — it is written to browser history, to the
 * Android system log, and to whatever else can read an intent.
 *
 * So the URL carries a `code` that is nothing but 32 random bytes. The session
 * it stands for is exchanged over an authenticated HTTPS POST, once, within two
 * minutes. This module owns the three primitives that makes safe:
 *
 *   - `newHandoffCode()` mints the code and the SHA-256 it is stored under, so
 *     a database read can never replay one.
 *   - `seal`/`open` encrypt the refresh token at rest under AES-256-GCM, so a
 *     database read cannot lift a session either.
 *
 * WHY NO NEW SECRET. The key is HKDF-derived from `SUPABASE_SERVICE_ROLE_KEY`,
 * which is already the most privileged secret this process holds and is already
 * required to boot. A separate `AUTH_HANDOFF_KEY` would add an environment
 * variable that can be forgotten in one deployment out of three, and its
 * absence would present as "the app handoff stopped working" rather than as a
 * refusal to start. Deriving means there is nothing new to rotate and nothing
 * new to leak: anyone holding the service-role key can already mint sessions
 * directly, so this adds no reachable material.
 */

/** How long a code stays exchangeable. Long enough to cross an app switch, and no longer. */
export const HANDOFF_TTL_SECONDS = 120;

const KEY_INFO = Buffer.from("finsight.auth-handoff.v1");

/*
 * Derived once per process. HKDF is deterministic, so every instance behind a
 * load balancer derives the same key and a code minted on one can be exchanged
 * on another — which is the normal case, not an edge one.
 *
 * The salt is fixed rather than random for the same reason. HKDF's salt is a
 * domain separator here, not a per-message nonce; the per-message randomness is
 * the IV below.
 */
function handoffKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(env.SUPABASE_SERVICE_ROLE_KEY), KEY_INFO, KEY_INFO, 32));
}

export interface HandoffCode {
  /** Given to the browser, put in the deep link, never stored. */
  code: string;
  /** Stored. */
  codeHash: string;
}

export function newHandoffCode(): HandoffCode {
  const code = randomBytes(32).toString("base64url");
  return { code, codeHash: hashHandoffCode(code) };
}

/**
 * Hashing, not encrypting, and no salt.
 *
 * The code is 256 bits of uniform randomness, so there is no dictionary to
 * defend against and a per-row salt would only make the lookup impossible —
 * the exchange has to FIND the row from the code, which means the hash has to
 * be deterministic.
 */
export function hashHandoffCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Constant-time compare, for the paths that hold both values already. */
export function handoffCodeMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * AES-256-GCM. The IV and the auth tag travel with the ciphertext because they
 * have to and neither is secret; GCM is chosen over CBC so a tampered row fails
 * to open rather than decrypting to garbage the caller then sends to GoTrue.
 */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", handoffKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Returns null rather than throwing: an unopenable row is a dead link, not a crash. */
export function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".");
    if (!iv || !tag || !body) return null;
    const decipher = createDecipheriv("aes-256-gcm", handoffKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
