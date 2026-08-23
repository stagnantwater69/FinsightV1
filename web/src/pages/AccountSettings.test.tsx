// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import { ToastProvider } from "../components/Toast";
import { AccountSettings } from "./AccountSettings";
import type { UserPreferences } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS.
 *
 * Every control on this page writes the moment it is touched — there is no
 * Save button to make the write visible — so the only thing standing between
 * an owner and a preference that silently did not stick is the rollback path.
 * Three things have to hold and all three are asserted here:
 *
 *   1. a switch sends a PARTIAL patch (a whole-object write from this page
 *      would restart an interrupted tour, which is why the API takes partials);
 *   2. a failed write puts the switch BACK, rather than leaving the screen
 *      claiming a setting the account does not have;
 *   3. the failure is said out loud, not swallowed.
 *
 * The AuthProvider here is the real one: the optimistic-then-rollback logic
 * lives in it, and a mocked context would assert nothing about it.
 */

const ME = {
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

let serverPreferences: UserPreferences;
let patchFails = false;
const patched: { url: string; body: unknown }[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/auth/me") return { data: { ...ME, preferences: serverPreferences } };
      throw new Error(`unmocked GET ${url}`);
    },
    patch: async (url: string, body: unknown) => {
      patched.push({ url, body });
      if (patchFails) throw new Error("Network is unreachable");
      serverPreferences = { ...serverPreferences, ...(body as Partial<UserPreferences>) };
      return { data: serverPreferences };
    },
  },
  setSessionExpiredHandler: () => {},
}));

vi.mock("../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "t" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({}),
    },
  },
}));

/*
 * The tour itself is a stub, because what this page owes the tour is only that
 * it calls the right two things. TourContext's own behaviour — the migrate-up,
 * the rollback of `alwaysShow` — is asserted in context/TourContext.test.tsx
 * against the real provider.
 */
const tour = {
  alwaysShow: false,
  setAlwaysShow: vi.fn(async (_value: boolean) => {}),
  restart: vi.fn(),
};

vi.mock("../context/TourContext", () => ({
  useTourOptional: () => tour,
}));

function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/account-settings"]}>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route path="/account-settings" element={<AccountSettings />} />
              <Route path="/dashboard" element={<p>Dashboard</p>} />
            </Routes>
            <LocationProbe />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const mascotSwitch = () => screen.getByRole("switch", { name: /Show the daily message on my Dashboard/ });

beforeEach(() => {
  patched.length = 0;
  patchFails = false;
  tour.alwaysShow = false;
  tour.setAlwaysShow.mockClear();
  tour.restart.mockClear();
  serverPreferences = {
    showDashboardMascotMessage: true,
    tourStatus: "completed",
    tourStep: 9,
    tourAlwaysShow: false,
  };
});

describe("Account settings", () => {
  it("gathers the three preference sections on one page", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Account Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Guided Tour" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Daily Mascot Message" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    // The theme control is the existing switcher, not a second copy of the
    // choice — three themes, one component.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Theme —/ })).toBeInTheDocument());
  });

  it("reflects the preference the account came back with", async () => {
    serverPreferences = { ...serverPreferences, showDashboardMascotMessage: false };
    renderPage();
    await waitFor(() => expect(mascotSwitch()).not.toBeChecked());
  });

  describe("the daily mascot message switch", () => {
    it("saves immediately, as a partial patch, with no Save button to press", async () => {
      renderPage();
      await waitFor(() => expect(mascotSwitch()).toBeChecked());

      await userEvent.click(mascotSwitch());

      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]).toEqual({
        url: "/auth/me/preferences",
        // Only the field that changed: the tour's own three must not be
        // rewritten by a settings screen that knows nothing about them.
        body: { showDashboardMascotMessage: false },
      });
      expect(mascotSwitch()).not.toBeChecked();
      expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    });

    it("puts itself back and says so when the account refuses the change", async () => {
      patchFails = true;
      renderPage();
      await waitFor(() => expect(mascotSwitch()).toBeChecked());

      await userEvent.click(mascotSwitch());

      // Rolled back — a switch left showing "off" would be claiming a setting
      // the account does not have.
      await waitFor(() => expect(mascotSwitch()).toBeChecked());
      expect(await screen.findByText("Network is unreachable")).toBeInTheDocument();
    });
  });

  describe("the guided tour panel", () => {
    it("writes the always-show preference through the tour", async () => {
      renderPage();
      const alwaysShow = screen.getByRole("switch", { name: /Always show the tour when I sign in/ });
      expect(alwaysShow).not.toBeChecked();

      await userEvent.click(alwaysShow);
      expect(tour.setAlwaysShow).toHaveBeenCalledWith(true);
    });

    it("reports a failed always-show write instead of swallowing it", async () => {
      tour.setAlwaysShow.mockRejectedValueOnce(new Error("Could not save that"));
      renderPage();

      await userEvent.click(screen.getByRole("switch", { name: /Always show the tour when I sign in/ }));
      expect(await screen.findByText("Could not save that")).toBeInTheDocument();
    });

    it("starts the tour and lands on the dashboard, where its targets are", async () => {
      renderPage();
      await userEvent.click(screen.getByRole("button", { name: "Start Guided Tour" }));

      // Rewind first, then navigate — the tour resumes there once the
      // dashboard's data has loaded.
      expect(tour.restart).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/dashboard"));
    });

    it("uses mascot art that already exists rather than new illustration", () => {
      const { container } = renderPage();
      const poses = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(poses).toContain("/mascot/01-onboarding/tutorial.webp");
      expect(poses).toContain("/mascot/greeting.webp");
    });
  });
});
