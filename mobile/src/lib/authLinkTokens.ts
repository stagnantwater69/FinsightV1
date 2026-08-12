/**
 * Reads the credentials Supabase puts in a `finsight://` auth deep link.
 *
 * WHY BY HAND, AND WHY NO NEW DEPENDENCY. React Native's own `Linking` gives us
 * the URL; everything after that is string work. `expo-linking` would parse it
 * slightly more tidily and would be one more native module to install, build
 * and keep working on a device — which is not a trade worth making for
 * splitting on `#`.
 *
 * The web client's equivalent (web/src/lib/authLinkTokens.ts) exists separately
 * and deliberately: the two apps have no build-time relationship, and the URL
 * shapes differ enough — a fragment on a custom scheme rather than on an
 * https origin — that sharing would mean a package to couple their release
 * cycles for eighty lines.
 */

export interface AuthLinkTokens {
  accessToken: string;
  refreshToken: string;
  /** `recovery` for a reset link, `signup` for a confirmation link. */
  type: string | null;
}

export type AuthLinkKind = "reset-password" | "confirm-email";

export type AuthLinkResult =
  | { kind: AuthLinkKind; tokens: AuthLinkTokens }
  | { kind: AuthLinkKind; error: string }
  | null;

/**
 * Turns Supabase's `error_code` into something an owner can act on.
 *
 * The raw values are for developers — "otp_expired" is not a sentence — and
 * every branch ends with what to do next, because on these screens there is
 * exactly one useful action and the person arrived expecting it to work.
 */
function describe(code: string | null, description: string | null): string {
  switch (code) {
    case "otp_expired":
      return "That link has expired. Links only last a short while — ask for a new one.";
    case "access_denied":
      return "That link has already been used. Ask for a new one if you still need it.";
    default:
      return description?.replace(/\+/g, " ") || "That link is no longer valid. Ask for a new one.";
  }
}

/**
 * Parses a deep link, returning null for anything that is not one of ours.
 *
 * The app is opened by plenty of URLs that are none of this module's business —
 * an OS-generated launch, a share intent — so a non-match must be silent rather
 * than an error state on screen.
 */
export function parseAuthDeepLink(url: string): AuthLinkResult {
  const kind: AuthLinkKind | null = url.includes("auth/reset-password")
    ? "reset-password"
    : url.includes("auth/confirm")
      ? "confirm-email"
      : null;
  if (!kind) return null;

  // Supabase puts tokens in the fragment and, depending on the failure, errors
  // in either the fragment or the query — so both are read rather than assuming
  // whichever shape turned up in testing.
  const [, afterQuery = ""] = url.split("?");
  const [, afterHash = ""] = url.split("#");
  const params = new URLSearchParams(`${afterQuery.split("#")[0]}&${afterHash}`);

  const errorCode = params.get("error_code") ?? params.get("error");
  if (errorCode) {
    return { kind, error: describe(errorCode, params.get("error_description")) };
  }

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) {
    return { kind, error: "That link is incomplete. Ask for a new one." };
  }

  return { kind, tokens: { accessToken, refreshToken, type: params.get("type") } };
}
