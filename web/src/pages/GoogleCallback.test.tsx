// @vitest-environment jsdom
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { GoogleCallback } from "./GoogleCallback";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(), signOut: vi.fn(), adoptSession: vi.fn(), post: vi.fn(),
  createClient: vi.fn(), dispose: vi.fn(),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ adoptSession: mocks.adoptSession, loading: false }) }));
vi.mock("../lib/api", () => ({ api: { post: mocks.post } }));
vi.mock("../lib/supabaseClient", () => ({
  disposeIsolatedAuthClient: mocks.dispose,
  createGoogleAuthClient: () => {
    mocks.createClient();
    return { auth: { exchangeCodeForSession: mocks.exchange, signOut: mocks.signOut } };
  },
}));

function renderCallback() {
  return render(<StrictMode><MemoryRouter initialEntries={["/auth/google/callback"]}>
    <Routes>
      <Route path="/auth/google/callback" element={<GoogleCallback />} />
      <Route path="/onboarding" element={<p>Set up your business</p>} />
      <Route path="/business-profiles" element={<p>Your businesses</p>} />
    </Routes>
  </MemoryRouter></StrictMode>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/auth/google/callback?code=one-time-code");
  mocks.exchange.mockResolvedValue({ data: { session: { access_token: "google-access", refresh_token: "google-refresh" } }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.adoptSession.mockResolvedValue(undefined);
  mocks.post.mockResolvedValue({ data: { profile: { id: 7 }, needsOnboarding: false } });
});

describe("Google callback", () => {
  it("approves the exchanged credential on the backend before installing it", async () => {
    renderCallback();
    expect(await screen.findByText("Your businesses")).toBeInTheDocument();
    expect(mocks.exchange).toHaveBeenCalledOnce();
    expect(mocks.exchange).toHaveBeenCalledWith("one-time-code");
    expect(mocks.post).toHaveBeenCalledWith("/auth/google", null, { headers: { Authorization: "Bearer google-access" } });
    expect(mocks.post.mock.invocationCallOrder[0]).toBeLessThan(mocks.adoptSession.mock.invocationCallOrder[0]);
    expect(mocks.adoptSession).toHaveBeenCalledWith({ accessToken: "google-access", refreshToken: "google-refresh", profile: { id: 7 } });
    await waitFor(() => expect(mocks.dispose).toHaveBeenCalled());
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("routes a new verified owner to onboarding", async () => {
    mocks.post.mockResolvedValue({ data: { profile: { id: 7 }, needsOnboarding: true } });
    renderCallback();
    expect(await screen.findByText("Set up your business")).toBeInTheDocument();
  });

  it("installs no session when the backend refuses the Google identity", async () => {
    mocks.post.mockRejectedValue(new Error("This account has been suspended."));
    renderCallback();
    expect(await screen.findByRole("alert")).toHaveTextContent("This account has been suspended.");
    expect(mocks.adoptSession).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" }));
    expect(screen.getByRole("link", { name: "Back to log in" })).toHaveAttribute("href", "/login");
  });

  it.each([
    { data: { session: null }, error: { message: "invalid verifier" } },
    { data: { session: null }, error: null },
  ])("refuses an unverified exchange without contacting the application backend", async result => {
    mocks.exchange.mockResolvedValue(result);
    renderCallback();
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or couldn't be verified/i);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.adoptSession).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
  });

  it.each(["", "?error=access_denied&error_description=private-provider-text"]) (
    "handles a missing or denied callback without starting an exchange (%s)", async query => {
      window.history.replaceState(null, "", `/auth/google/callback${query}`);
      renderCallback();
      expect(await screen.findByRole("alert")).toHaveTextContent(/wasn't completed/i);
      expect(mocks.exchange).not.toHaveBeenCalled();
      expect(mocks.dispose).toHaveBeenCalled();
      expect(mocks.adoptSession).not.toHaveBeenCalled();
      expect(screen.queryByText(/private-provider-text/i)).not.toBeInTheDocument();
      expect(window.location.search).toBe("");
    },
  );
});
