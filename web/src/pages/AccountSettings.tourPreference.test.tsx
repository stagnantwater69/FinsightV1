// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readTour, setAlwaysShowTour, writeTour } from "../lib/tourStorage";
import { ToastProvider } from "../components/Toast";
import { ConfirmProvider } from "../components/ConfirmDialog";
import { ThemeProvider } from "../context/ThemeContext";
import { AccountSettings } from "./AccountSettings";
import { Profile } from "./Profile";
import type { UserPreferences } from "../lib/types";

/**
 * The always-show tour preference — the rule it creates, and where it now
 * lives.
 *
 * WHY THE RULE MATTERS. The tour is once-per-account by design: a terminal
 * status (completed or skipped) is what stops it interrupting a real owner
 * forever. That also made it impossible to show to anyone — demonstrating it,
 * or re-checking a change to it, meant registering a new account or clearing
 * storage by hand. `alwaysShow` is the one sanctioned way past that, so it is
 * the one piece of the gate worth pinning here: TourContext must consult it
 * before honouring a terminal status, and nothing about finishing the tour may
 * switch it off.
 *
 * WHY THE FILE IS NAMED FOR A DIFFERENT PAGE THAN IT USED TO BE. The panel was
 * on /profile, next to the password form, the device sign-out and the delete
 * button. It is a preference, not identity or security, and it moved WHOLE to
 * /account-settings. The DOM assertions at the bottom are that move: they fail
 * if the panel is left behind, and they fail if it was copied rather than
 * moved.
 */

const preferences: UserPreferences = {
  showDashboardMascotMessage: true,
  tourStatus: "completed",
  tourStep: 9,
  tourAlwaysShow: false,
};

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    profile: {
      id: 1,
      firstName: "Ken",
      middleName: null,
      lastName: "Dela Paz",
      email: "ken@example.com",
      phoneNumber: null,
      status: "ACTIVE",
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    preferences,
    updateProfile: vi.fn(async () => {}),
    uploadAvatar: vi.fn(async () => {}),
    updatePreferences: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    logoutEverywhere: vi.fn(async () => {}),
  }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ profiles: [{ id: 1, name: "Sari-sari" }], selected: { id: 1 } }),
}));

vi.mock("../context/TourContext", () => ({
  useTourOptional: () => ({ alwaysShow: false, setAlwaysShow: vi.fn(async () => {}), restart: vi.fn() }),
}));

vi.mock("../lib/api", () => ({ api: { get: async () => ({ data: {} }), patch: async () => ({ data: {} }) } }));

function renderPage(page: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <ConfirmProvider>{page}</ConfirmProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const ALWAYS_SHOW = /Always show the tour when I sign in/;

/** Mirrors TourContext's gate, minus the parts that need a mounted app. */
function autoStartAllowed(userId: number): boolean {
  const stored = readTour(userId);
  return !(!stored.alwaysShow && (stored.status === "completed" || stored.status === "skipped"));
}

describe("always-show tour preference", () => {
  it("lets a completed tour start again once the toggle is on", () => {
    window.localStorage.clear();
    writeTour(1, { status: "completed", step: 9 });
    expect(autoStartAllowed(1)).toBe(false);

    setAlwaysShowTour(1, true);
    expect(autoStartAllowed(1)).toBe(true);
  });

  it("does the same for a tour the owner skipped", () => {
    window.localStorage.clear();
    writeTour(1, { status: "skipped", step: 2 });
    expect(autoStartAllowed(1)).toBe(false);

    setAlwaysShowTour(1, true);
    expect(autoStartAllowed(1)).toBe(true);
  });

  it("goes back to appearing once when the toggle is turned off", () => {
    window.localStorage.clear();
    writeTour(1, { status: "completed", step: 9, alwaysShow: true });
    expect(autoStartAllowed(1)).toBe(true);

    setAlwaysShowTour(1, false);
    expect(autoStartAllowed(1)).toBe(false);
  });

  it("keeps starting for a brand-new owner whether or not the toggle is set", () => {
    window.localStorage.clear();
    expect(autoStartAllowed(42)).toBe(true);
    setAlwaysShowTour(42, true);
    expect(autoStartAllowed(42)).toBe(true);
  });

  it("is one owner's setting, not the machine's", () => {
    window.localStorage.clear();
    writeTour(1, { status: "completed" });
    writeTour(2, { status: "completed" });
    setAlwaysShowTour(1, true);

    expect(autoStartAllowed(1)).toBe(true);
    // A shared shop computer must not carry the demo setting between owners.
    expect(autoStartAllowed(2)).toBe(false);
  });

  it("survives the tour being completed again, so a demo stays armed", () => {
    window.localStorage.clear();
    setAlwaysShowTour(1, true);
    // What TourContext.stop persists — it carries alwaysShow through.
    writeTour(1, { status: "completed", step: 9, alwaysShow: readTour(1).alwaysShow });
    expect(autoStartAllowed(1)).toBe(true);
  });
});

describe("where the guided tour panel lives", () => {
  it("is gone from My Profile, which keeps identity, security and deletion", () => {
    renderPage(<Profile />);

    expect(screen.queryByText(ALWAYS_SHOW)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Guided Tour" })).not.toBeInTheDocument();
    // The page still owns everything it should.
    expect(screen.getByRole("heading", { name: "Personal Details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Devices" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delete account" })).toBeInTheDocument();
    // And it points at where the preference went, because someone who learned
    // it here will come back here looking for it.
    expect(screen.getByRole("link", { name: "Account settings" })).toHaveAttribute("href", "/account-settings");
  });

  it("is on Account settings, whole", () => {
    renderPage(<AccountSettings />);

    expect(screen.getByRole("heading", { name: "Guided Tour" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: ALWAYS_SHOW })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Guided Tour" })).toBeInTheDocument();
  });
});
