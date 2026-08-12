import { describe, expect, it } from "vitest";
import { parseAuthDeepLink } from "../src/lib/authLinkTokens";

/**
 * Parsing the `finsight://` links Supabase's auth emails point at.
 *
 * These are what makes password recovery finishable on a phone at all. Before
 * them the mobile app could ask for a reset email and had nowhere for the link
 * to land — so the screen told the owner to come back and log in with a
 * password that had not been changed and could not be.
 *
 * Mirrors web/src/lib/authLinkTokens.test.ts in intent, not in code: a custom
 * scheme is not a URL the same parser can read, which is why the two exist
 * separately.
 */

const RESET = "finsight://auth/reset-password#access_token=at-123&refresh_token=rt-456&type=recovery";
const CONFIRM = "finsight://auth/confirm#access_token=at-789&refresh_token=rt-012&type=signup";

describe("parseAuthDeepLink", () => {
  it("reads a reset link", () => {
    expect(parseAuthDeepLink(RESET)).toEqual({
      kind: "reset-password",
      tokens: { accessToken: "at-123", refreshToken: "rt-456", type: "recovery" },
    });
  });

  it("tells a confirmation link apart from a reset link", () => {
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
      "finsight://auth/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(result).toMatchObject({ kind: "reset-password" });
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

  /** Half a link is not a usable one, and must not be treated as a session. */
  it("refuses an access token with no refresh token", () => {
    const result = parseAuthDeepLink("finsight://auth/reset-password#access_token=at-123&type=recovery");
    expect(result).toMatchObject({ kind: "reset-password" });
    expect(result).toHaveProperty("error");
  });
});
