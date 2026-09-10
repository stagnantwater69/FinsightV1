/**
 * Reads the credentials an auth link hands the app.
 *
 * THE SCHEME IS NO LONGER ALWAYS OURS. Confirmation emails now point at the
 * https web origin for everyone, web- and mobile-registered alike, so the OS
 * gives this URL to the app only when the App Link/Universal Link association
 * verifies (app.config.ts) and to the browser otherwise. Matching on the PATH
 * rather than on the scheme is what makes both shapes read identically here.
 *
 * PASSWORD RESET IS NOT HERE ANY MORE, and its absence is the point. The reset
 * email's button — `finsight://auth/reset-password`, with a token pair in the
 * fragment — has been taken out of the Supabase template, which now sends
 * GoTrue's recovery code and nothing else. That link can no longer be minted,
 * so a branch for it would be dead code claiming to handle a URL that will
 * never arrive; the code is typed into ResetPasswordScreen instead, and never
 * travels in a URL at all. Confirmation still has its link, and still lands
 * here.
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
  /** `signup` for a confirmation link. */
  type: string | null;
}

export type AuthLinkKind = "confirm-email" | "session-handoff";

export type AuthLinkResult =
  | { kind: "confirm-email"; tokens: AuthLinkTokens }
  /**
   * A one-time code the web app minted for this phone, NOT a session.
   *
   * The confirmation email now always lands on the https web origin, so an
   * owner whose phone did not claim the App Link finishes on the website — and
   * the website hands the session over by opening `finsight://auth/handoff`
   * with a short-lived opaque code that the backend exchanges. The code is
   * carried instead of tokens deliberately: a URL is written to the system log,
   * the recents list and the browser's history, and none of those are places an
   * access or refresh token may end up.
   */
  | { kind: "session-handoff"; code: string }
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
  const kind: AuthLinkKind | null = url.includes("auth/confirm")
    ? "confirm-email"
    : url.includes("auth/handoff")
      ? "session-handoff"
      : null;
  if (!kind) return null;

  // Supabase puts tokens in the fragment and, depending on the failure, errors
  // in either the fragment or the query — so both are read rather than assuming
  // whichever shape turned up in testing.
  const [, afterQuery = ""] = url.split("?");
  const [, afterHash = ""] = url.split("#");
  const params = new URLSearchParams(`${afterQuery.split("#")[0]}&${afterHash}`);

  const errorCode = params.get("error_code") ?? params.get("error");

  /*
   * MATCHING THE PATH IS NOT ENOUGH FOR A HANDOFF — the code has to be there.
   *
   * Handled before the error/token branches below because a handoff link is
   * not a Supabase link at all: it is minted by our own web app and carries
   * neither `error_code` nor tokens, so the reasoning those branches encode
   * does not apply to it. A `finsight://auth/handoff` with nothing usable on
   * it is treated as none of this module's business rather than as a failed
   * sign-in, because the one thing it cannot be is a session — and putting
   * "that didn't work" over the screen of someone whose app was opened by a
   * stray URL is the failure mode this module exists to avoid.
   */
  if (kind === "session-handoff") {
    const code = params.get("code");
    return code ? { kind, code } : null;
  }
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
