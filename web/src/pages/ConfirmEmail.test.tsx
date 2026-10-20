// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

/**
 * The confirmation link is now a sign-in, so this file guards the two things
 * that makes load-bearing:
 *
 *   1. the owner never sees the login screen again — a good link installs the
 *      session and lands them on the right first screen, a second click on the
 *      same mail (no fragment, session already stored) is treated as "you're
 *      already in" rather than as a failure;
 *   2. a link that the BACKEND rejects signs nobody in — the recovery screen
 *      appears and `setSession` is never reached.
 *
 * The real AuthProvider is used rather than a stubbed `useAuth`, because
 * `adoptSession` is the thing under test: asserting on the mocked Supabase
 * client's `setSession` is what proves the link's tokens actually became the
 * browser's session, which a hand-stubbed context could only pretend.
 */

const { getSession, setSession, signOut, onAuthStateChange, verifyOtp, recoverySignOut, disposeIsolatedAuthClient } = vi.hoisted(() => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(),
  verifyOtp: vi.fn(),
  recoverySignOut: vi.fn(),
  disposeIsolatedAuthClient: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));

vi.mock("../lib/supabaseClient", () => ({
  supabase: { auth: { getSession, setSession, signOut, onAuthStateChange } },
  disposeIsolatedAuthClient,
  createRecoveryClient: () => ({ auth: { verifyOtp, signOut: recoverySignOut } }),
}));

const { apiGet, apiPost, apiPatch } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch },
  setSessionExpiredHandler: vi.fn(),
}));

const { AuthProvider } = await import("../context/AuthContext");
const { ConfirmEmail } = await import("./ConfirmEmail");

const PROFILE = {
  id: 7,
  firstName: "Ada",
  middleName: null,
  lastName: "Reyes",
  email: "ada@example.com",
  phoneNumber: null,
  status: "ACTIVE",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ACCESS_TOKEN = "link-access-token";
const REFRESH_TOKEN = "link-refresh-token";

const realLocation = window.location;
const realUserAgent = window.navigator.userAgent;
/** Every `window.location.href = …` the page performed, in order. */
let navigations: string[] = [];

/**
 * jsdom's own `location` cannot be assigned a `finsight://` URL (it aborts the
 * navigation and logs), and the page reads `hash` back off it, so the whole
 * object is swapped for one that records instead of navigating.
 */
function setLinkUrl(hash: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/auth/confirm",
      search: "",
      hash,
      get href() {
        return navigations[navigations.length - 1] ?? "";
      },
      set href(value: string) {
        navigations.push(value);
      },
    },
  });
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: ua });
}

function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderConfirm(state?: { email?: string; codeSent?: boolean }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/auth/confirm", state }]}>
      <AuthProvider>
        <Routes>
          <Route path="/auth/confirm" element={<ConfirmEmail />} />
          <Route path="/dashboard" element={<p>Dashboard</p>} />
          <Route path="/onboarding" element={<p>Onboarding</p>} />
          <Route path="/login" element={<p>Log in</p>} />
        </Routes>
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const atPath = (path: string) => waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(path), { timeout: 3000 });

beforeEach(() => {
  vi.clearAllMocks();
  navigations = [];
  // No stored session by default: the visitor arrives from their inbox.
  getSession.mockResolvedValue({ data: { session: null } });
  setSession.mockResolvedValue({ data: {}, error: null });
  verifyOtp.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN } }, error: null });
  recoverySignOut.mockResolvedValue({ error: null });
  apiGet.mockResolvedValue({ data: PROFILE });
  setLinkUrl(`#access_token=${ACCESS_TOKEN}&refresh_token=${REFRESH_TOKEN}&type=signup`);
  setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36");
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: realUserAgent });
});

describe("ConfirmEmail", () => {
  it.each([
    ["08 2450", "082450"],
    ["7532-4744", "75324744"],
    ["01234 56789", "0123456789"],
  ])("verifies signup code %s before backend approval and session installation", async (raw, token) => {
    setLinkUrl("");
    apiPost.mockResolvedValue({ data: { message: "Your email is confirmed.", profile: PROFILE, needsOnboarding: true } });
    const user = userEvent.setup();
    renderConfirm({ email: ` ${PROFILE.email} `, codeSent: true });
    expect(await screen.findByText(PROFILE.email)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^email/i)).toBeNull();
    expect(screen.getByRole("button", { name: /resend code in/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/confirmation code/i), raw);
    expect(verifyOtp).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm email" }));
    await waitFor(() => expect(setSession).toHaveBeenCalled());
    expect(verifyOtp).toHaveBeenCalledWith({ email: PROFILE.email, token, type: "email" });
    expect(apiPost).toHaveBeenCalledWith("/auth/confirm-email", null, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    expect(apiPost.mock.invocationCallOrder[0]).toBeLessThan(setSession.mock.invocationCallOrder[0]);
    await waitFor(() => expect(disposeIsolatedAuthClient).toHaveBeenCalled());
    await atPath("/onboarding");
    expect(recoverySignOut).not.toHaveBeenCalled();
  });

  it.each([
    { data: { session: null }, error: { message: "Email not found" } },
    { data: { session: null }, error: { message: "Expired or already used" } },
    { data: { session: null }, error: null },
  ])("keeps signup verification failures generic and installs no session", async result => {
    setLinkUrl("");
    verifyOtp.mockResolvedValue(result);
    const user = userEvent.setup();
    renderConfirm({ email: PROFILE.email });
    await user.type(await screen.findByLabelText(/confirmation code/i), "75324744");
    await user.click(screen.getByRole("button", { name: "Confirm email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/code couldn't be verified/i);
    expect(apiPost).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/Email not found/i)).not.toBeInTheDocument();
    await waitFor(() => expect(disposeIsolatedAuthClient).toHaveBeenCalled());
  });

  it("does not adopt signup tokens when the backend rejects the verified session", async () => {
    setLinkUrl("");
    apiPost.mockRejectedValue(new Error("Account suspended"));
    const user = userEvent.setup();
    renderConfirm({ email: PROFILE.email });
    await user.type(await screen.findByLabelText(/confirmation code/i), "75324744");
    await user.click(screen.getByRole("button", { name: "Confirm email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't finish confirming/i);
    expect(setSession).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/confirmation code/i)).toBeInTheDocument();
    await waitFor(() => expect(disposeIsolatedAuthClient).toHaveBeenCalled());
    expect(recoverySignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("adopts the link's session and opens onboarding when there is no business yet", async () => {
    apiPost.mockResolvedValue({ data: { message: "Your email is confirmed.", profile: PROFILE, needsOnboarding: true } });

    renderConfirm();

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/auth/confirm-email", null, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }),
    );
    await waitFor(() =>
      expect(setSession).toHaveBeenCalledWith({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }),
    );
    // The success beat is shown, not skipped past.
    expect(await screen.findByText("Your email is confirmed.")).toBeInTheDocument();
    await atPath("/onboarding");
  });

  it("sends an owner who already has a business straight to the dashboard", async () => {
    apiPost.mockResolvedValue({ data: { message: "Your email is confirmed.", profile: PROFILE, needsOnboarding: false } });

    renderConfirm();

    await atPath("/dashboard");
    expect(setSession).toHaveBeenCalledWith({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN });
  });

  it("offers the recovery screen and installs no session when the link is expired", async () => {
    setLinkUrl("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");

    renderConfirm();

    expect(await screen.findByRole("button", { name: "Send a new code" })).toBeInTheDocument();
    expect(screen.getByText(/That link has expired/)).toBeInTheDocument();
    expect(setSession).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByTestId("path")).toHaveTextContent("/auth/confirm");
  });

  it("opens the code form after resending from an expired legacy link", async () => {
    setLinkUrl("#error=access_denied&error_code=otp_expired");
    apiPost.mockResolvedValue({ data: { message: "If eligible, a code is on its way." } });
    const user = userEvent.setup();
    renderConfirm();
    await user.type(await screen.findByLabelText(/^email/i), PROFILE.email);
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByLabelText(/confirmation code/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend code in/i })).toBeDisabled();
    expect(apiPost).toHaveBeenCalledWith("/auth/resend-verification", { email: PROFILE.email, platform: "web" });
    expect(setSession).not.toHaveBeenCalled();
  });

  it("keeps the recovery screen when the backend refuses an already-used link", async () => {
    apiPost.mockRejectedValue(new Error("That link has expired or has already been used."));

    renderConfirm();

    expect(await screen.findByRole("button", { name: "Send a new code" })).toBeInTheDocument();
    expect(setSession).not.toHaveBeenCalled();
  });

  /*
   * The repeat click: the mail app reopens the same message, the fragment is
   * long gone (consumed on the first visit), and the session is already
   * stored. Telling that person their link didn't work would be both wrong and
   * alarming.
   */
  it("routes an already signed-in visitor with no link params to the dashboard", async () => {
    setLinkUrl("");
    getSession.mockResolvedValue({ data: { session: { access_token: "stored" } } });

    renderConfirm();

    await atPath("/dashboard");
    expect(screen.queryByRole("button", { name: "Send a new code" })).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each([undefined, { email: "not-an-email" }])("collects email separately when there is no usable recipient: %j", async (state) => {
    setLinkUrl("");

    renderConfirm(state);

    expect(await screen.findByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/confirmation code/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Send confirmation code" })).toBeInTheDocument();
    expect(setSession).not.toHaveBeenCalled();
  });

  it("enters the PIN step only after a successful email delivery request", async () => {
    setLinkUrl("");
    apiPost.mockResolvedValue({ data: { message: "If eligible, a code is on its way." } });
    const user = userEvent.setup();
    renderConfirm();
    await user.type(await screen.findByLabelText(/^email/i), PROFILE.email);
    await user.click(screen.getByRole("button", { name: "Send confirmation code" }));
    expect(await screen.findByLabelText(/confirmation code/i)).toHaveValue("");
    expect(screen.queryByLabelText(/^email/i)).toBeNull();
    expect(screen.getByText(PROFILE.email)).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith("/auth/resend-verification", { email: PROFILE.email, platform: "web" });
    expect(screen.getByRole("button", { name: /resend code in/i })).toBeDisabled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("keeps failed email delivery on the editable email step", async () => {
    setLinkUrl("");
    apiPost.mockRejectedValue(new Error("Try again later."));
    const user = userEvent.setup();
    renderConfirm();
    await user.type(await screen.findByLabelText(/^email/i), PROFILE.email);
    await user.click(screen.getByRole("button", { name: "Send confirmation code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again later.");
    expect(screen.getByLabelText(/^email/i)).toHaveValue(PROFILE.email);
    expect(screen.queryByLabelText(/confirmation code/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Send confirmation code" })).toBeEnabled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("changes the recipient separately and never reuses the previous code", async () => {
    setLinkUrl("");
    apiPost.mockResolvedValue({ data: { message: "If eligible, a code is on its way." } });
    const user = userEvent.setup();
    renderConfirm({ email: PROFILE.email });
    await user.type(await screen.findByLabelText(/confirmation code/i), "082450");
    await user.click(screen.getByRole("button", { name: "Change email" }));
    const email = await screen.findByLabelText(/^email/i);
    expect(email).toHaveValue(PROFILE.email);
    expect(screen.queryByLabelText(/confirmation code/i)).toBeNull();
    await user.clear(email);
    await user.type(email, "next@shop.ph");
    await user.click(screen.getByRole("button", { name: "Send confirmation code" }));
    expect(await screen.findByLabelText(/confirmation code/i)).toHaveValue("");
    expect(screen.getByText("next@shop.ph")).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith("/auth/resend-verification", { email: "next@shop.ph", platform: "web" });
    expect(verifyOtp).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Change email" }));
    expect(screen.getByRole("button", { name: /resend code in/i })).toBeDisabled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByLabelText(/confirmation code/i)).toBeNull();
  });

  it("hands off to the app with an opaque code, never the refresh token", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
    apiPost.mockImplementation(async (url: string) => {
      if (url === "/auth/confirm-email") {
        return { data: { message: "Your email is confirmed.", profile: PROFILE, needsOnboarding: false } };
      }
      return { data: { code: "one-time code/7", expiresInSeconds: 120 } };
    });

    renderConfirm();

    await userEvent.click(await screen.findByRole("button", { name: "Open in the FinSight app" }));

    expect(apiPost).toHaveBeenCalledWith(
      "/auth/handoff",
      { refreshToken: REFRESH_TOKEN },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    );
    await waitFor(() => expect(navigations).toHaveLength(1));
    expect(navigations[0]).toBe("finsight://auth/handoff?code=one-time%20code%2F7");
    expect(navigations[0]).not.toContain(REFRESH_TOKEN);
    expect(navigations[0]).not.toContain(ACCESS_TOKEN);
  });

  it("stays on the web, signed in, when the handoff request fails", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
    apiPost.mockImplementation(async (url: string) => {
      if (url === "/auth/confirm-email") {
        return { data: { message: "Your email is confirmed.", profile: PROFILE, needsOnboarding: false } };
      }
      throw new Error("handoff unavailable");
    });

    renderConfirm();

    await userEvent.click(await screen.findByRole("button", { name: "Open in the FinSight app" }));

    expect(await screen.findByText(/carry on here instead/)).toBeInTheDocument();
    expect(navigations).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Continue on the web" }));
    await atPath("/dashboard");
  });
});
