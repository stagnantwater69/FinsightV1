import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What Root does with each kind of auth link — read as source, because App.tsx
 * cannot be mounted off-device.
 *
 * THE BUG THIS PINS. One `finish` callback served all three link kinds and it
 * ended with `if (profile) void logout()`. That is right for a password reset
 * (the backend has revoked every session by then, and the local one is a
 * corpse) and exactly wrong for the other two: confirming an email and
 * exchanging a handoff code have just ESTABLISHED the session, so the shared
 * callback signed the owner out of the account they had finished setting up
 * one tap earlier and put them on the log-in form — the whole complaint the
 * confirmation flow exists to answer.
 *
 * A regex over source is a blunt instrument and it is the honest one here:
 * there is no harness that can drive a deep link through the navigator, and
 * the alternative was a comment nobody would be told about when it stopped
 * being true.
 */
const APP = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
const AUTH_SCREENS = readFileSync(join(__dirname, "..", "src", "screens", "AuthScreens.tsx"), "utf8");

/**
 * The source between two markers — one branch of Root's link handling, with
 * the neighbouring branches left out. Cut by marker rather than by a fixed
 * window of characters, because a window wide enough to hold a branch is wide
 * enough to catch the `logout()` in the one below it and pass a test that
 * proves nothing.
 */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  expect(start, `source no longer contains: ${from}`).toBeGreaterThan(-1);
  expect(end, `source no longer contains: ${to}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const CONFIRM_BRANCH = () => between(APP, 'if (link.kind === "confirm-email")', 'if (link.kind === "session-handoff")');
const HANDOFF_BRANCH = () => between(APP, 'if (link.kind === "session-handoff")', "return profile ?");
/** From "tell the backend the reset is done" to the end of that submit. */
const RESET_COMPLETION = () => between(AUTH_SCREENS, '"/auth/reset-password/complete"', "setDone(true)");

describe("auth deep-link routing", () => {
  it("renders a screen for every link kind the parser can return", () => {
    for (const screen of ["ConfirmEmailScreen", "SessionHandoffScreen"]) {
      expect(APP).toContain(`<${screen}`);
    }
    expect(APP).toContain('link.kind === "session-handoff"');
  });

  /**
   * The reset email has no button any more, so a branch for its link would be
   * a screen shown for a URL that can never arrive — and the one screen that
   * used to win over a signed-in session at that.
   */
  it("routes no deep link to the password reset", () => {
    expect(APP).not.toContain('"reset-password"');
    expect(APP).not.toContain("finishReset");
  });

  /** Typed, not linked — so it is an ordinary screen on the auth stack. */
  it("registers the reset screen on the auth stack instead", () => {
    expect(APP).toMatch(/<Stack\.Screen\s+name="ResetPassword"/);
    expect(APP).toContain("<ResetPasswordScreen");
  });

  /**
   * The sign-out moved with the flow. Completing a reset revokes every session
   * globally, so whatever this phone still holds is a corpse — leaving it would
   * keep the owner inside the app on credentials the server has thrown away.
   */
  it("keeps the sign-out on the password reset, where the session is already dead", () => {
    expect(RESET_COMPLETION()).toMatch(/logout\(\)/);
  });

  /** Signing in is the point. Ending the session here would undo it. */
  it("does not sign the owner out after a confirmation or a handoff", () => {
    expect(CONFIRM_BRANCH()).toContain("<ConfirmEmailScreen");
    expect(CONFIRM_BRANCH()).not.toMatch(/logout\(\)/);
    expect(HANDOFF_BRANCH()).toContain("<SessionHandoffScreen");
    expect(HANDOFF_BRANCH()).not.toMatch(/logout\(\)/);
  });

  /**
   * No parallel route into the setup wizard. An owner who has just confirmed
   * and has no business yet is sent there by MainOrOnboarding, on the same
   * `profiles.length === 0` test every other entry uses — a second one keyed
   * off the backend's `needsOnboarding` would be two sources of truth that
   * disagree the moment a profile is created on another device.
   */
  it("leaves onboarding entry to MainOrOnboarding", () => {
    expect(APP).not.toContain("needsOnboarding");
  });
});
