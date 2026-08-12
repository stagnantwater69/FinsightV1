import { describe, expect, it, vi } from "vitest";
import { consumeAuthLink, describeAuthLinkError } from "./authLinkTokens";

/**
 * Reading — and, just as importantly, ERASING — the credentials Supabase puts
 * in a confirmation or reset link.
 *
 * WHY THIS CODE EXISTS AT ALL. supabase-js will do the reading itself:
 * `detectSessionInUrl` defaults to true in a browser, and it turns any auth
 * token in the fragment into the app's stored session on whatever page happens
 * to load. A password-reset email carries exactly such a fragment — so with the
 * default, clicking "reset my password" silently signed the recipient in, with
 * no password typed and nothing reset. That option is now off and the tokens
 * are read here, on the two screens entitled to them.
 */

function fakeLocation(url: string): Location {
  const parsed = new URL(url);
  return { hash: parsed.hash, search: parsed.search, pathname: parsed.pathname } as Location;
}

function fakeHistory() {
  return { replaceState: vi.fn() } as unknown as History & { replaceState: ReturnType<typeof vi.fn> };
}

const RESET_LINK =
  "https://app.finsight.test/auth/reset-password#access_token=at-123&refresh_token=rt-456&expires_in=3600&token_type=bearer&type=recovery";

describe("consumeAuthLink", () => {
  it("reads the tokens out of the fragment", () => {
    const result = consumeAuthLink(fakeLocation(RESET_LINK), fakeHistory());

    expect(result).toEqual({
      kind: "tokens",
      tokens: { accessToken: "at-123", refreshToken: "rt-456", type: "recovery" },
    });
  });

  /**
   * THE ERASURE IS PART OF THE CONTRACT, not tidiness. A live credential left
   * in the address bar survives in browser history, in a screenshot, and in the
   * `Referer` header of every subsequent request — and the person who later
   * reopens that history is not always the account's owner.
   */
  it("strips the credential from the address bar as it reads it", () => {
    const history = fakeHistory();
    consumeAuthLink(fakeLocation(RESET_LINK), history);

    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/auth/reset-password");
  });

  it("erases the URL even when the link turns out to be an error", () => {
    const history = fakeHistory();
    consumeAuthLink(
      fakeLocation("https://app.finsight.test/auth/reset-password#error=access_denied&error_code=otp_expired"),
      history,
    );

    expect(history.replaceState).toHaveBeenCalled();
  });

  it("reports an expired link rather than a set of tokens", () => {
    const result = consumeAuthLink(
      fakeLocation(
        "https://app.finsight.test/auth/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      ),
      fakeHistory(),
    );

    expect(result).toMatchObject({ kind: "error", error: { code: "otp_expired" } });
  });

  /**
   * Supabase puts tokens in the fragment but, depending on which thing failed,
   * errors in either the fragment or the query string. Reading only the one
   * that turned up during development is how the other becomes a blank screen.
   */
  it("finds an error in the query string as well as the fragment", () => {
    const result = consumeAuthLink(
      fakeLocation("https://app.finsight.test/auth/confirm?error=access_denied&error_code=otp_expired"),
      fakeHistory(),
    );

    expect(result).toMatchObject({ kind: "error" });
  });

  it("says 'none' for an ordinary visit, so the page can explain itself", () => {
    const history = fakeHistory();
    const result = consumeAuthLink(fakeLocation("https://app.finsight.test/auth/reset-password"), history);

    expect(result).toEqual({ kind: "none" });
    // Nothing to erase, so the address bar is left exactly as it was.
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  /** Half a link is not a usable one, and must not be treated as a session. */
  it("refuses an access token with no refresh token", () => {
    const result = consumeAuthLink(
      fakeLocation("https://app.finsight.test/auth/reset-password#access_token=at-123&type=recovery"),
      fakeHistory(),
    );

    expect(result).toMatchObject({ kind: "error" });
  });

  /**
   * Consuming is destructive, and the screens call it once on mount for exactly
   * that reason — a second read finds nothing. This pins the behaviour so the
   * `useRef` guard in those components is not removed as redundant.
   */
  it("is single-use against a real URL that has already been consumed", () => {
    const location = fakeLocation(RESET_LINK);
    expect(consumeAuthLink(location, fakeHistory()).kind).toBe("tokens");

    // What the second read sees, after replaceState has cleared the fragment.
    const cleared = fakeLocation("https://app.finsight.test/auth/reset-password");
    expect(consumeAuthLink(cleared, fakeHistory()).kind).toBe("none");
  });
});

describe("describeAuthLinkError", () => {
  /**
   * The raw values are for developers: "otp_expired" is not a sentence, and
   * Supabase's own `error_description` reads as an apology rather than an
   * instruction. Every message here ends with what to do next, because on these
   * screens there is exactly one useful action.
   */
  it("turns provider codes into an instruction", () => {
    expect(describeAuthLinkError({ code: "otp_expired", description: "" })).toMatch(/request a new one/i);
    expect(describeAuthLinkError({ code: "access_denied", description: "" })).toMatch(/already been used/i);
  });

  it("falls back to the provider's own words, then to something usable", () => {
    expect(describeAuthLinkError({ code: "something_new", description: "Provider said this" })).toBe(
      "Provider said this",
    );
    expect(describeAuthLinkError({ code: null, description: "" })).toMatch(/no longer valid/i);
  });
});
