/**
 * Reads the credentials Supabase puts in the URL of a confirmation or
 * password-reset link.
 *
 * WHY THIS IS DONE BY HAND rather than by supabase-js. The library will do it
 * automatically — `detectSessionInUrl`, which defaults to true in a browser —
 * and that default is exactly what made the password-reset email a working
 * passwordless login: any auth token in the fragment became the app's stored
 * session, on whatever page happened to load first, with no password involved.
 * That option is now off (see supabaseClient.ts), and the tokens are read here,
 * on the two screens that have a legitimate use for them, and nowhere else.
 *
 * The fragment is also CLEARED from the address bar as soon as it is read. A
 * live credential in a URL survives in browser history, in a screenshot, and in
 * the `Referer` header of any subsequent request — and the person most likely
 * to reopen that history is not always the account's owner.
 */

export interface AuthLinkTokens {
  accessToken: string;
  refreshToken: string;
  /** `recovery` for a reset link, `signup` for a confirmation link. */
  type: string | null;
}

export interface AuthLinkError {
  code: string | null;
  description: string;
}

export type AuthLinkResult =
  | { kind: "tokens"; tokens: AuthLinkTokens }
  | { kind: "error"; error: AuthLinkError }
  | { kind: "none" };

/**
 * Turns Supabase's `error_code` into something an owner can act on.
 *
 * The raw values are for developers: "otp_expired" is not a sentence, and the
 * `error_description` Supabase supplies is URL-encoded prose that reads as an
 * apology rather than an instruction. Every branch here ends with what to do
 * next, because on this screen there is exactly one useful action and the
 * person arrived expecting it to work.
 */
export function describeAuthLinkError(error: AuthLinkError): string {
  switch (error.code) {
    case "otp_expired":
      return "That link has expired. Links are only good for a short while — request a new one below.";
    case "access_denied":
      return "That link has already been used. If you still need to get in, request a new one below.";
    default:
      return error.description || "That link is no longer valid. Request a new one below.";
  }
}

/**
 * Reads and consumes the auth parameters in the current URL.
 *
 * Supabase uses the fragment for tokens and, depending on the failure, either
 * the fragment or the query string for errors — so both are checked rather than
 * assuming the shape that happened to appear in testing.
 */
export function consumeAuthLink(location: Location = window.location, history: History = window.history): AuthLinkResult {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  const read = (key: string) => hash.get(key) ?? query.get(key);

  const errorCode = read("error_code") ?? read("error");
  const accessToken = read("access_token");
  const refreshToken = read("refresh_token");

  if (!errorCode && !accessToken) return { kind: "none" };

  // Strip it before doing anything else, so an early return cannot leave a
  // token in the address bar.
  history.replaceState(null, "", location.pathname);

  if (errorCode) {
    return {
      kind: "error",
      error: { code: errorCode, description: read("error_description")?.replace(/\+/g, " ") ?? "" },
    };
  }

  if (!accessToken || !refreshToken) {
    return { kind: "error", error: { code: null, description: "That link is incomplete." } };
  }

  return { kind: "tokens", tokens: { accessToken, refreshToken, type: read("type") } };
}
