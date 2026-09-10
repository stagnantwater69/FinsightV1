import { describe, expect, it } from "vitest";
import { parseAuthDeepLink } from "../src/lib/authLinkTokens";

/**
 * Parsing the `finsight://` links Supabase's auth emails point at.
 *
 * WHAT IS NOT HERE: password reset. Its email carries GoTrue's recovery code
 * and no button at all now, so `finsight://auth/reset-password` can no longer
 * be minted and the app finishes a reset from the typed code instead (see
 * ResetPasswordScreen). The test below pins the URL as UNRECOGNISED rather
 * than merely deleting the old one: a leftover branch would be a screen shown
 * for a link that will never arrive, and — being the one link kind that used
 * to win over a signed-in session — a stray URL claiming that path is exactly
 * the thing that must now do nothing.
 *
 * Mirrors web/src/lib/authLinkTokens.test.ts in intent, not in code: a custom
 * scheme is not a URL the same parser can read, which is why the two exist
 * separately.
 */

const CONFIRM = "finsight://auth/confirm#access_token=at-789&refresh_token=rt-012&type=signup";

describe("parseAuthDeepLink", () => {
  it("no longer recognises a password-reset link", () => {
    expect(
      parseAuthDeepLink("finsight://auth/reset-password#access_token=at-123&refresh_token=rt-456&type=recovery"),
    ).toBeNull();
    expect(parseAuthDeepLink("finsight://auth/reset-password#error_code=otp_expired")).toBeNull();
  });

  it("reads a confirmation link", () => {
    expect(parseAuthDeepLink(CONFIRM)).toMatchObject({ kind: "confirm-email" });
  });

  /**
   * An app is opened by plenty of URLs that are none of this module's business —
   * an OS launch, a share intent. A non-match has to be SILENT: returning an
   * error shape would put "that link didn't work" over the dashboard of someone
   * who simply opened the app.
   */
  it("ignores anything that is not one of ours", () => {
    expect(parseAuthDeepLink("finsight://records/expenses/12")).toBeNull();
    expect(parseAuthDeepLink("https://finsight.test/blog")).toBeNull();
    expect(parseAuthDeepLink("")).toBeNull();
  });

  it("reports an expired link with something an owner can act on", () => {
    const result = parseAuthDeepLink(
      "finsight://auth/confirm#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(result).toMatchObject({ kind: "confirm-email" });
    expect((result as { error: string }).error).toMatch(/expired/i);
    // The `+` separators Supabase URL-encodes are turned back into spaces
    // wherever the provider's own wording is used.
    expect((result as { error: string }).error).not.toContain("+");
  });

  /**
   * Supabase puts tokens in the fragment but errors in either the fragment or
   * the query, depending on what failed. Handling only the shape seen during
   * development is how the other becomes a screen that never resolves.
   */
  it("finds an error in the query string too", () => {
    expect(parseAuthDeepLink("finsight://auth/confirm?error_code=otp_expired")).toMatchObject({
      kind: "confirm-email",
    });
    expect(parseAuthDeepLink("finsight://auth/confirm?foo=bar#error_code=otp_expired")).toMatchObject({
      kind: "confirm-email",
    });
  });

  /**
   * The confirmation email points at the WEBSITE now, for every owner. A phone
   * that has claimed the App Link gets this exact URL handed to it by the OS,
   * so if the parser only recognised `finsight://` the app would open on the
   * dashboard-or-login it always shows and the confirmation would silently
   * never happen.
   */
  it("reads a confirmation link that arrives on the https origin", () => {
    expect(
      parseAuthDeepLink("https://finsight.test/auth/confirm#access_token=at-1&refresh_token=rt-2&type=signup"),
    ).toEqual({
      kind: "confirm-email",
      tokens: { accessToken: "at-1", refreshToken: "rt-2", type: "signup" },
    });
  });

  /**
   * The hand-back from the website, for the owner whose phone did not claim
   * the link. What travels is a one-time code, never a token.
   */
  it("reads a session handoff code", () => {
    expect(parseAuthDeepLink("finsight://auth/handoff?code=hc-abc123")).toEqual({
      kind: "session-handoff",
      code: "hc-abc123",
    });
  });

  /**
   * A handoff URL with no code cannot be a session, so it must not become a
   * screen. Silence, not an error state — see `parseAuthDeepLink`.
   */
  it("refuses a handoff with a missing or empty code", () => {
    expect(parseAuthDeepLink("finsight://auth/handoff")).toBeNull();
    expect(parseAuthDeepLink("finsight://auth/handoff?code=")).toBeNull();
    expect(parseAuthDeepLink("finsight://auth/handoff?state=xyz")).toBeNull();
  });

  /** Half a link is not a usable one, and must not be treated as a session. */
  it("refuses an access token with no refresh token", () => {
    const result = parseAuthDeepLink("finsight://auth/confirm#access_token=at-123&type=signup");
    expect(result).toMatchObject({ kind: "confirm-email" });
    expect(result).toHaveProperty("error");
  });
});
