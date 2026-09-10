// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

/**
 * Resetting a password, which is now done by CODE and by nothing else.
 *
 * The emailed link is gone: it had to survive an in-app mail viewer, a desktop
 * client with no browser handoff, a phone reading someone else's inbox and a
 * redirect allow-list in a dashboard this repository cannot see, and it failed
 * all four as a dead end rather than as an error. So the promises worth holding
 * still here are:
 *
 *   - the screen is usable with no URL fragment of any kind, because that is
 *     now the ONLY way anyone arrives;
 *   - a good code reaches the password form, and finishing there makes the same
 *     `updateUser` + `/auth/reset-password/complete` calls it always did — the
 *     reset itself was never rewritten, only its way in;
 *   - a failure keeps the owner on the form to retype a digit;
 *   - and no failure message ever says whether the ADDRESS exists.
 *
 * That last one is not a detail. `/auth/recover-password` answers identically
 * for a registered and an unregistered address precisely so nobody can
 * enumerate customers, and it is worth nothing if the next screen confirms the
 * address for free.
 */

const { verifyOtp, setSession, updateUser, signOut, createRecoveryClient } = vi.hoisted(() => {
  const verifyOtp = vi.fn();
  const setSession = vi.fn();
  const updateUser = vi.fn();
  const signOut = vi.fn();
  return {
    verifyOtp,
    setSession,
    updateUser,
    signOut,
    createRecoveryClient: vi.fn(() => ({ auth: { verifyOtp, setSession, updateUser, signOut } })),
  };
});

vi.mock("../lib/supabaseClient", () => ({
  createRecoveryClient,
  supabase: { auth: {} },
}));

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { post: apiPost }, setSessionExpiredHandler: vi.fn() }));

const { ResetPassword } = await import("./ResetPassword");

const EMAIL = "owner@example.com";
const NEW_PASSWORD = "a-long-enough-password";

function renderPage(state?: { email?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/auth/reset-password", state }]}>
      <ResetPassword />
    </MemoryRouter>
  );
}

/** A session shaped like the one `verifyOtp` returns for a good code. */
function sessionResult() {
  return { data: { session: { access_token: "otp-access-token", refresh_token: "otp-refresh-token" } }, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  setSession.mockResolvedValue({ error: null });
  updateUser.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({ error: null });
  apiPost.mockResolvedValue({ data: null });
});

afterEach(() => {
  window.location.hash = "";
});

describe("arriving with nothing in the URL", () => {
  /*
   * This used to read "Open this page from the link in your password-reset
   * email." and stop. With no link in the email at all, that would now be a
   * dead end for every single person who reaches this screen.
   */
  it("is simply the code form", async () => {
    renderPage();
    expect(await screen.findByLabelText(/recovery code/i)).toBeTruthy();
    expect(screen.getByLabelText(/^email/i)).toBeTruthy();
  });

  it("verifies the code and lands on the password form", async () => {
    verifyOtp.mockResolvedValue(sessionResult());
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/^email/i), EMAIL);
    await user.type(screen.getByLabelText(/recovery code/i), "75324744");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByLabelText(/^new password/i)).toBeTruthy();
    expect(verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: "75324744", type: "recovery" });
    // The verification client is spent on every path, exactly like the link one.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  /** People paste the code as it is grouped in the email. */
  it("strips spaces and dashes before sending", async () => {
    verifyOtp.mockResolvedValue(sessionResult());
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/^email/i), EMAIL);
    await user.type(screen.getByLabelText(/recovery code/i), "7532-4744");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(verifyOtp).toHaveBeenCalled());
    expect(verifyOtp.mock.calls[0][0].token).toBe("75324744");
  });

  /**
   * A wrong digit is the likeliest cause, and retyping it is the fix. Note the
   * message: it must not say which of the address or the code was wrong, or
   * this form becomes the account oracle that /auth/recover-password refuses
   * to be.
   */
  it("keeps the owner on the form after a bad code, with no session", async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: { message: "Token has expired or is invalid" } });
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/^email/i), EMAIL);
    await user.type(screen.getByLabelText(/recovery code/i), "75324744");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByText(/that didn't work/i)).toBeTruthy();
    // Still on the code form, with the fields to correct.
    expect(screen.getByLabelText(/recovery code/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^new password/i)).toBeNull();
    expect(setSession).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    // Nothing about the failure names the email address.
    expect(screen.queryByText(new RegExp(EMAIL, "i"))).toBeNull();
  });

  /**
   * The whole point of feeding the OTP's tokens into the link path's `tokens`
   * state: one implementation of "change the password, then end every other
   * session", reached identically either way.
   */
  it("reaches the same updateUser + completion call the link path does", async () => {
    verifyOtp.mockResolvedValue(sessionResult());
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/^email/i), EMAIL);
    await user.type(screen.getByLabelText(/recovery code/i), "75324744");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await user.type(await screen.findByLabelText(/^new password/i), NEW_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: /save new password/i }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: NEW_PASSWORD }));
    expect(setSession).toHaveBeenCalledWith({
      access_token: "otp-access-token",
      refresh_token: "otp-refresh-token",
    });
    expect(apiPost).toHaveBeenCalledWith("/auth/reset-password/complete", null, {
      headers: { Authorization: "Bearer otp-access-token" },
    });
    expect(await screen.findByText(/password changed/i)).toBeTruthy();
  });
});

describe("the handover from the request screen", () => {
  /**
   * `/recover-password` asked for the address seconds ago. Asking again is
   * friction for nothing — and it is carried in router STATE rather than the
   * query string, because an address in a URL ends up in history and in the
   * `Referer` of the next request.
   */
  it("prefills the address it was handed, without putting it in the URL", async () => {
    renderPage({ email: EMAIL });

    expect(await screen.findByLabelText(/^email/i)).toHaveValue(EMAIL);
    expect(window.location.search).toBe("");
  });

  it("still works when reached directly, with nothing handed over", async () => {
    renderPage();
    expect(await screen.findByLabelText(/^email/i)).toHaveValue("");
  });
});

describe("a code that dies between the two steps", () => {
  /**
   * The verified session can expire while the owner is choosing a password —
   * these codes are short-lived by design. Leaving the dead pair in state would
   * strand them on a form that can no longer save anything, so the code form
   * comes back with an explanation and they can enter a fresh one.
   */
  it("puts the code form back rather than stranding them on a dead password form", async () => {
    verifyOtp.mockResolvedValue(sessionResult());
    setSession.mockResolvedValue({ error: { message: "session expired" } });
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/^email/i), EMAIL);
    await user.type(screen.getByLabelText(/recovery code/i), "75324744");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await user.type(await screen.findByLabelText(/^new password/i), NEW_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: /save new password/i }));

    expect(await screen.findByText(/that code has expired/i)).toBeTruthy();
    expect(screen.getByLabelText(/recovery code/i)).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe("what is no longer here", () => {
  /**
   * A guard, not a behaviour: the link path is gone, and a URL fragment left
   * over from an old email must not resurrect any part of it. The screen owes
   * that visitor the code form, the same as everyone else.
   *
   * `consumeAuthLink` still exists and is still used — by email CONFIRMATION,
   * which keeps its link. This asserts only that RESET no longer touches it.
   */
  it("ignores an auth fragment entirely", async () => {
    window.location.hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid";
    renderPage();

    expect(await screen.findByLabelText(/recovery code/i)).toBeTruthy();
    expect(screen.queryByText(/that link didn't work/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /send a new reset link/i })).toBeNull();
  });
});
