import { supabaseAdmin } from "../config/supabase";
import { prisma } from "../config/prisma";

export interface AccessTokenVerdict {
  authUserId?: string;
  error: { message: string; name?: string; status?: number } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The JWT header, read WITHOUT verifying anything; it only picks the path. */
function unverifiedHeader(token: string): { alg?: unknown; kid?: unknown } | undefined {
  const header = token.split(".")[0];
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
  } catch {
    return undefined;
  }
}

/*
 * Confirms an access token and says whose it is.
 *
 * A token signed with the project's asymmetric key (ES256/RS256) is checked
 * here: the signature against Supabase's published public keys, which
 * supabase-js caches, so no request reaches Supabase Auth. Anything else —
 * the legacy shared-secret tokens, or something that is not a JWT at all —
 * goes to `getUser`, which asks Supabase as before. Either path refuses a
 * forged token; the header only decides which one does the refusing.
 *
 * A valid signature alone is not enough. It stays valid until the token
 * expires (an hour by default), while Supabase deletes the session on log out,
 * "log out everywhere" and a password reset. `getUser` checks that the session
 * still exists, so the local path must too, or a signed-out token would keep
 * working for the rest of its hour.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenVerdict> {
  const header = unverifiedHeader(token);
  const asymmetric =
    typeof header?.alg === "string" && !header.alg.startsWith("HS") && typeof header.kid === "string";
  if (!asymmetric) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    return error || !data.user ? { error: error ?? { message: "No user for this token" } } : { authUserId: data.user.id, error: null };
  }

  const { data, error } = await supabaseAdmin.auth.getClaims(token);
  if (error || !data) return { error: error ?? { message: "Invalid token" } };

  // Only a signed-in user's token carries both; API keys and service tokens do not.
  const { sub, session_id: sessionId } = data.claims;
  if (typeof sub !== "string" || typeof sessionId !== "string" || !UUID.test(sub) || !UUID.test(sessionId)) {
    return { error: { message: "Not a user session token" } };
  }

  const live = await prisma.$queryRaw<unknown[]>`
    SELECT 1 FROM auth.sessions
    WHERE id = ${sessionId}::uuid AND user_id = ${sub}::uuid AND (not_after IS NULL OR not_after > now())
    LIMIT 1`;
  if (live.length === 0) return { error: { message: "Session from session_id claim in JWT does not exist" } };

  return { authUserId: sub, error: null };
}
