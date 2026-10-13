// @vitest-environment jsdom
import { act, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  signOut: vi.fn(),
  sessionExpiredHandler: null as (() => void) | null,
}));

const profile = {
  id: 1,
  firstName: "Ken",
  middleName: null,
  lastName: "Dela Paz",
  email: "ken@example.com",
  phoneNumber: null,
  status: "ACTIVE",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ data: profile })),
    post: (...args: unknown[]) => mocks.post(...args),
  },
  setSessionExpiredHandler: (handler: (() => void) | null) => {
    mocks.sessionExpiredHandler = handler;
  },
}));

vi.mock("../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: (...args: unknown[]) => mocks.signOut(...args),
    },
  },
}));

function Probe() {
  const { profile: current, loading, logout, logoutEverywhere } = useAuth();
  const [result, setResult] = useState("idle");

  if (loading) return <p>Loading</p>;
  return (
    <div>
      <p>{current ? `Signed in as ${current.email}` : "Signed out"}</p>
      <p>{result}</p>
      <button
        type="button"
        onClick={() => {
          void logoutEverywhere().then(() => setResult("success"), () => setResult("failed"));
        }}
      >
        Revoke sessions
      </button>
      <button
        type="button"
        onClick={() => {
          void logout().then(() => setResult("success"), () => setResult("failed"));
        }}
      >
        Log out here
      </button>
    </div>
  );
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.signOut.mockReset();
  mocks.signOut.mockResolvedValue({});
  mocks.sessionExpiredHandler = null;
});

describe("AuthContext global logout", () => {
  it("keeps this browser signed in when the server cannot confirm remote revocation", async () => {
    mocks.post.mockRejectedValue(new Error("Network unavailable"));
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText(`Signed in as ${profile.email}`);
    await userEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText(`Signed in as ${profile.email}`)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith("/auth/logout-all");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("clears the local identity after the server confirms global revocation", async () => {
    mocks.post.mockResolvedValue({ data: {} });
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText(`Signed in as ${profile.email}`);
    await userEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));

    await waitFor(() => expect(screen.getByText("Signed out")).toBeInTheDocument());
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps ordinary logout local to this browser", async () => {
    mocks.post.mockResolvedValue({ data: {} });
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText(`Signed in as ${profile.email}`);
    await userEvent.click(screen.getByRole("button", { name: "Log out here" }));

    await waitFor(() => expect(screen.getByText("Signed out")).toBeInTheDocument());
    expect(mocks.post).toHaveBeenCalledWith("/auth/logout");
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("cleans up an expired browser session without revoking other devices", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText(`Signed in as ${profile.email}`);
    act(() => mocks.sessionExpiredHandler?.());

    await waitFor(() => expect(screen.getByText("Signed out")).toBeInTheDocument());
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
