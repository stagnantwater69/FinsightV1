import { createHash } from "node:crypto";

/*
 * Remembers, for a few seconds, which access tokens Supabase Auth has already
 * accepted, so `requireAuth` does not make an HTTPS round-trip to Supabase on
 * every request. That call was the largest fixed cost of every API request,
 * and a tab that loads several endpoints in sequence paid it on each hop.
 *
 * WHAT IS CACHED: only "this token belongs to auth user X", never the FinSight
 * user row. `requireAuth` still reads the user on every request, so the status
 * gate (suspension, pending deletion) and a deleted account take effect
 * immediately, exactly as before.
 *
 * WHAT CAN BE STALE, AND FOR HOW LONG: a session revoked by a different process
 * (another API replica, or Supabase directly) keeps working here for at most
 * TTL_MS. Revocations that go through this process — log out, log out
 * everywhere, password change — evict synchronously via `evictTokenOwner`, so
 * they have no window at all on a single-replica deployment.
 *
 * Keys are SHA-256 digests, so the raw bearer token is never held in the map.
 */

export const VERIFIED_TOKEN_TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

interface Entry {
  authUserId: string;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Reads a claim from the JWT payload WITHOUT verifying the signature. That is
 * safe only because nothing here grants access on the strength of it: `exp`
 * can only shorten a cache entry, and `sub` is only used to evict.
 */
function unverifiedClaim(token: string, claim: "exp" | "sub"): unknown {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>)[claim];
  } catch {
    return undefined;
  }
}

export function getVerifiedTokenOwner(token: string, now = Date.now()): string | undefined {
  const key = digest(token);
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return undefined;
  }
  return entry.authUserId;
}

export function rememberVerifiedToken(token: string, authUserId: string, now = Date.now()): void {
  // A token without a readable expiry is never cached: there would be no way
  // to stop serving it from here once Supabase stops accepting it.
  const exp = unverifiedClaim(token, "exp");
  if (typeof exp !== "number") return;
  const expiresAt = Math.min(now + VERIFIED_TOKEN_TTL_MS, exp * 1000);
  if (expiresAt <= now) return;

  if (entries.size >= MAX_ENTRIES) {
    // Map iteration is insertion order, so the first key is the oldest entry.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(digest(token), { authUserId, expiresAt });
}

export function evictAuthUser(authUserId: string): void {
  for (const [key, entry] of entries) {
    if (entry.authUserId === authUserId) entries.delete(key);
  }
}

/** Drops every cached token of whoever owns `token`, whatever the revocation scope. */
export function evictTokenOwner(token: string): void {
  const owner = entries.get(digest(token))?.authUserId ?? unverifiedClaim(token, "sub");
  if (typeof owner === "string") evictAuthUser(owner);
}

export function clearVerifiedTokenCache(): void {
  entries.clear();
}
