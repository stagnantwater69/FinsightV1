// @vitest-environment jsdom
import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

const mocks = vi.hoisted(() => ({
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
    post: vi.fn(async () => ({ data: {} })),
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
      signOut: vi.fn(async () => ({})),
    },
  },
}));

function Probe() {
  const { profile: current, loading, logout } = useAuth();
  if (loading) return <p>Loading</p>;
  return (
    <div>
      <p>{current ? "Signed in" : "Signed out"}</p>
      <button type="button" onClick={() => void logout()}>Log out here</button>
    </div>
  );
}

const draftKey = "finsight.receiptReviewDraft.1.1.10";

beforeEach(() => {
  sessionStorage.clear();
  mocks.sessionExpiredHandler = null;
});

describe("AuthContext receipt review drafts", () => {
  it("clears unsaved receipt review drafts on logout", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Signed in");
    sessionStorage.setItem(draftKey, "{}");
    sessionStorage.setItem("unrelated-setting", "keep");

    await userEvent.click(screen.getByRole("button", { name: "Log out here" }));
    await waitFor(() => expect(screen.getByText("Signed out")).toBeInTheDocument());
    expect(sessionStorage.getItem(draftKey)).toBeNull();
    expect(sessionStorage.getItem("unrelated-setting")).toBe("keep");
  });

  it("clears unsaved receipt review drafts when the session expires", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Signed in");
    sessionStorage.setItem(draftKey, "{}");

    act(() => mocks.sessionExpiredHandler?.());
    await waitFor(() => expect(screen.getByText("Signed out")).toBeInTheDocument());
    expect(sessionStorage.getItem(draftKey)).toBeNull();
  });
});
