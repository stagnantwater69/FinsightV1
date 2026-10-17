import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_REDIRECT_URL,
  parseGoogleCallback,
  signInWithGoogle,
  type AuthSheetResult,
  type GoogleSignInDeps,
} from "../src/lib/googleSignIn";

const session = { access_token: "access", refresh_token: "refresh" };
const profile = { id: 7 };

function harness(overrides: {
  oauth?: { data: { url: string | null }; error: { message: string } | null };
  sheet?: AuthSheetResult;
  exchange?: { data: { session: typeof session | null }; error: { message: string } | null };
  approve?: () => Promise<{ profile: typeof profile; needsOnboarding: boolean }>;
} = {}) {
  const auth = {
    signInWithOAuth: vi.fn().mockResolvedValue(overrides.oauth ?? { data: { url: "https://accounts.example/o" }, error: null }),
    exchangeCodeForSession: vi.fn().mockResolvedValue(overrides.exchange ?? { data: { session }, error: null }),
    signOut: vi.fn().mockResolvedValue({}),
  };
  const dispose = vi.fn();
  const deps: GoogleSignInDeps<typeof profile> = {
    createClient: () => ({ client: { auth }, dispose }),
    openAuthSheet: vi.fn().mockResolvedValue(overrides.sheet ?? { type: "success", url: `${GOOGLE_REDIRECT_URL}?code=abc` }),
    approve: vi.fn(overrides.approve ?? (() => Promise.resolve({ profile, needsOnboarding: true }))),
    adoptSession: vi.fn().mockResolvedValue(undefined),
    describeError: (err) => (err instanceof Error ? err.message : "Something went wrong."),
  };
  return { auth, dispose, deps };
}

describe("parseGoogleCallback", () => {
  it("reads the code off the app's own redirect", () => {
    expect(parseGoogleCallback(`${GOOGLE_REDIRECT_URL}?code=abc123`)).toEqual({ kind: "code", code: "abc123" });
  });

  it("treats a provider error in the query or fragment as a denial", () => {
    expect(parseGoogleCallback(`${GOOGLE_REDIRECT_URL}?error=access_denied`)).toEqual({ kind: "denied" });
    expect(parseGoogleCallback(`${GOOGLE_REDIRECT_URL}#error_code=otp_expired`)).toEqual({ kind: "denied" });
  });

  it("ignores any other address, even one carrying a code", () => {
    expect(parseGoogleCallback("finsight://auth/handoff?code=abc")).toEqual({ kind: "invalid" });
    expect(parseGoogleCallback(GOOGLE_REDIRECT_URL)).toEqual({ kind: "invalid" });
  });
});

describe("signInWithGoogle", () => {
  it("asks Google which account, returns to the app, and signs in only after the server approves", async () => {
    const { auth, dispose, deps } = harness();
    await expect(signInWithGoogle(deps)).resolves.toEqual({ status: "signed-in", needsOnboarding: true });
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: GOOGLE_REDIRECT_URL, skipBrowserRedirect: true, queryParams: { prompt: "select_account" } },
    });
    expect(deps.openAuthSheet).toHaveBeenCalledWith("https://accounts.example/o", GOOGLE_REDIRECT_URL);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(deps.approve).toHaveBeenCalledWith("access");
    expect(deps.adoptSession).toHaveBeenCalledWith(session, profile);
    // The approved session now belongs to the app; signing it out would undo the sign-in.
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("treats closing the sheet as a choice, and leaves nothing behind", async () => {
    const { auth, dispose, deps } = harness({ sheet: { type: "cancel" } });
    await expect(signInWithGoogle(deps)).resolves.toEqual({ status: "cancelled" });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("explains a denial on Google's side", async () => {
    const { auth, deps } = harness({ sheet: { type: "success", url: `${GOOGLE_REDIRECT_URL}?error=access_denied` } });
    const result = await signInWithGoogle(deps);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("wasn't completed") });
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("says when the code could not be exchanged", async () => {
    const { deps } = harness({ exchange: { data: { session: null }, error: { message: "bad code" } } });
    expect(await signInWithGoogle(deps)).toMatchObject({ status: "failed", message: expect.stringContaining("expired") });
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("shows the server's own reason when it refuses, and never adopts the session", async () => {
    const { auth, deps } = harness({
      approve: () => Promise.reject(new Error("This email already has a FinSight account. Sign in with its existing method.")),
    });
    expect(await signInWithGoogle(deps)).toEqual({
      status: "failed",
      message: "This email already has a FinSight account. Sign in with its existing method.",
    });
    expect(deps.adoptSession).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("does not open anything when Supabase cannot start the flow", async () => {
    const { deps } = harness({ oauth: { data: { url: null }, error: { message: "provider disabled" } } });
    expect(await signInWithGoogle(deps)).toMatchObject({ status: "failed", message: expect.stringContaining("couldn't start") });
    expect(deps.openAuthSheet).not.toHaveBeenCalled();
  });
});
