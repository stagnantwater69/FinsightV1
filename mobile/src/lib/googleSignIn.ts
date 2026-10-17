/**
 * Google sign-in on the phone, as one testable sequence.
 *
 * The same steps as web (web/src/components/GoogleSignInButton.tsx and
 * pages/GoogleCallback.tsx), with the system auth sheet in place of a page
 * redirect:
 *
 *   1. A throwaway PKCE client asks Supabase for Google's sign-in URL.
 *   2. The system sheet (Custom Tabs / ASWebAuthenticationSession) opens it and
 *      closes itself when Google sends the owner to GOOGLE_REDIRECT_URL.
 *   3. The code on that URL is exchanged for a session by the same client,
 *      which holds the verifier, so a code taken by another app is worthless.
 *   4. POST /auth/google checks the Google identity and loads or creates the
 *      FinSight account. Only then does the session become the app's.
 *
 * Any failure before step 4 completes signs the throwaway session out, so a
 * half-finished attempt leaves no credential behind.
 */

/**
 * Must be on Supabase → Authentication → URL Configuration → Redirect URLs.
 * Without it Supabase sends the owner to the Site URL instead and the sheet
 * never closes on a code. See docs/AUTH-CONFIGURATION.md.
 */
export const GOOGLE_REDIRECT_URL = "finsight://auth/google/callback";

export type GoogleCallback =
  | { kind: "code"; code: string }
  | { kind: "denied" }
  | { kind: "invalid" };

/** Reads the redirect Google's round trip ends on. Errors can arrive in the query or the fragment. */
export function parseGoogleCallback(url: string): GoogleCallback {
  if (!url.startsWith(GOOGLE_REDIRECT_URL)) return { kind: "invalid" };
  const [, afterQuery = ""] = url.split("?");
  const [, afterHash = ""] = url.split("#");
  const params = new URLSearchParams(`${afterQuery.split("#")[0]}&${afterHash}`);
  if (params.has("error") || params.has("error_code")) return { kind: "denied" };
  const code = params.get("code");
  return code ? { kind: "code", code } : { kind: "invalid" };
}

export interface GoogleSession {
  access_token: string;
  refresh_token: string;
}

interface AuthError {
  message?: string;
}

/** The slice of a Supabase client this flow uses. */
export interface GoogleAuthClient {
  auth: {
    signInWithOAuth(input: {
      provider: "google";
      options: { redirectTo: string; skipBrowserRedirect: boolean; queryParams?: Record<string, string> };
    }): Promise<{ data: { url: string | null }; error: AuthError | null }>;
    exchangeCodeForSession(code: string): Promise<{ data: { session: GoogleSession | null }; error: AuthError | null }>;
    signOut(options: { scope: "local" }): Promise<unknown>;
  };
}

export type AuthSheetResult = { type: "success"; url: string } | { type: string };

export interface GoogleSignInDeps<Profile> {
  createClient(): { client: GoogleAuthClient; dispose(): void };
  /** Opens the system auth sheet and resolves when it closes. */
  openAuthSheet(url: string, redirectUrl: string): Promise<AuthSheetResult>;
  /** POST /auth/google with the Google session's access token. */
  approve(accessToken: string): Promise<{ profile: Profile; needsOnboarding: boolean }>;
  adoptSession(session: GoogleSession, profile: Profile): Promise<void>;
  /** The server's own sentence for a refusal (409 existing account, 403 unverified email). */
  describeError(error: unknown): string;
}

export type GoogleSignInResult =
  | { status: "signed-in"; needsOnboarding: boolean }
  /** The owner closed the sheet. Not an error, so nothing is shown. */
  | { status: "cancelled" }
  | { status: "failed"; message: string };

const START_FAILED = "Google sign-in couldn't start. Try again, or use your email and password.";
const NOT_COMPLETED = "Google sign-in wasn't completed. Try again, or use your email and password.";
const EXPIRED = "This Google sign-in has expired or couldn't be verified. Please try again.";

export async function signInWithGoogle<Profile>(deps: GoogleSignInDeps<Profile>): Promise<GoogleSignInResult> {
  const { client, dispose } = deps.createClient();
  let approved = false;
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: GOOGLE_REDIRECT_URL,
        skipBrowserRedirect: true,
        // Always ask which account, so a phone signed in to a personal Google
        // account does not silently become the business's login.
        queryParams: { prompt: "select_account" },
      },
    });
    if (error || !data.url) return { status: "failed", message: START_FAILED };

    const sheet = await deps.openAuthSheet(data.url, GOOGLE_REDIRECT_URL);
    if (sheet.type !== "success" || !("url" in sheet)) return { status: "cancelled" };

    const callback = parseGoogleCallback(sheet.url);
    if (callback.kind !== "code") return { status: "failed", message: NOT_COMPLETED };

    const exchanged = await client.auth.exchangeCodeForSession(callback.code);
    const session = exchanged.data.session;
    if (exchanged.error || !session) return { status: "failed", message: EXPIRED };

    try {
      const result = await deps.approve(session.access_token);
      await deps.adoptSession(session, result.profile);
      approved = true;
      return { status: "signed-in", needsOnboarding: result.needsOnboarding };
    } catch (err) {
      return { status: "failed", message: deps.describeError(err) };
    }
  } catch {
    return { status: "failed", message: START_FAILED };
  } finally {
    if (!approved) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
    dispose();
  }
}
