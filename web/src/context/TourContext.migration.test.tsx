// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TourProvider, useTourOptional } from "./TourContext";
import { readTour, writeTour } from "../lib/tourStorage";
import type { UserPreferences } from "../lib/types";

/**
 * THE MIGRATE-UP, WHICH IS THE RISKY HALF OF MOVING THE TOUR TO THE SERVER.
 *
 * Tour progress used to live only in localStorage. Every existing account
 * therefore has a user row whose `tourStatus` is NULL while their browser
 * knows perfectly well they finished the tour months ago. If a null read as
 * "not_started", every one of those owners would be offered the tour again on
 * their next sign-in — and the first thing the tour wrote would bury the
 * completed state permanently.
 *
 * So the rule is: a null status ADOPTS the cache and sends it up, exactly
 * once; any real status comes DOWN and wins, because it is the account's
 * answer and this machine's may be from another era or another device.
 *
 * Asserted against the real provider rather than the pure helper alone,
 * because the bug this prevents is a wiring bug — the helper agreeing with
 * itself in isolation would prove nothing about what actually gets sent.
 */

const updatePreferences = vi.fn(async (_patch: Partial<UserPreferences>) => {});
let preferences: UserPreferences;
let preferencesLoaded: boolean;
let userId: number | null;

vi.mock("./AuthContext", () => ({
  useAuth: () => ({
    profile: userId == null ? null : { id: userId, firstName: "Ken" },
    preferences,
    preferencesLoaded,
    updatePreferences,
  }),
}));

vi.mock("./BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1 }, loading: false }),
}));

/** Reads the value back out of the provider, since the gate is not visible. */
function Probe() {
  const tour = useTourOptional();
  return <span data-testid="always-show">{String(tour?.alwaysShow)}</span>;
}

function mount() {
  return render(
    // Not /dashboard: the auto-start poll has nothing to do with the
    // reconciliation being tested, and would only add a timer to it.
    <MemoryRouter initialEntries={["/records"]}>
      <TourProvider>
        <Probe />
      </TourProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  updatePreferences.mockClear();
  userId = 1;
  preferencesLoaded = true;
  preferences = {
    showDashboardMascotMessage: true,
    tourStatus: null,
    tourStep: null,
    tourAlwaysShow: false,
  };
});

describe("reconciling the tour with the account", () => {
  it("pushes locally stored progress up when the server has never been told", async () => {
    writeTour(1, { status: "completed", step: 9, alwaysShow: true });

    mount();

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(1));
    expect(updatePreferences).toHaveBeenCalledWith({
      tourStatus: "completed",
      tourStep: 9,
      tourAlwaysShow: true,
    });
    // And the local answer survives the migration untouched.
    expect(readTour(1)).toEqual({ status: "completed", step: 9, alwaysShow: true });
    expect(screen.getByTestId("always-show")).toHaveTextContent("true");
  });

  it("still tells the server about an owner who has never toured", async () => {
    mount();

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(1));
    expect(updatePreferences).toHaveBeenCalledWith({
      tourStatus: "not_started",
      tourStep: 0,
      tourAlwaysShow: false,
    });
  });

  it("does NOT overwrite a status the server already has", async () => {
    // The new-laptop case: this browser has never seen the tour, the account
    // finished it. Nothing may go up, and the cache must learn the truth.
    preferences = { ...preferences, tourStatus: "completed", tourStep: 9 };

    mount();

    await waitFor(() => expect(readTour(1).status).toBe("completed"));
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(readTour(1)).toEqual({ status: "completed", step: 9, alwaysShow: false });
  });

  it("lets the account win over local progress, not the other way round", async () => {
    writeTour(1, { status: "in_progress", step: 3 });
    preferences = { ...preferences, tourStatus: "skipped", tourStep: 5 };

    mount();

    await waitFor(() => expect(readTour(1).status).toBe("skipped"));
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it("adopts the account's always-show preference across devices", async () => {
    preferences = { ...preferences, tourStatus: "completed", tourStep: 9, tourAlwaysShow: true };

    mount();

    await waitFor(() => expect(screen.getByTestId("always-show")).toHaveTextContent("true"));
    expect(readTour(1).alwaysShow).toBe(true);
  });

  it("migrates once, not on every render of the provider", async () => {
    writeTour(1, { status: "completed", step: 9 });
    const { rerender } = mount();

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(1));
    rerender(
      <MemoryRouter initialEntries={["/records"]}>
        <TourProvider>
          <Probe />
        </TourProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(1));
  });

  it("sends nothing while /auth/me is still in flight", async () => {
    // The cache still answers the gate; what must not happen is a push based
    // on preferences nobody has read yet.
    preferencesLoaded = false;
    writeTour(1, { status: "completed", step: 9, alwaysShow: true });

    mount();

    await waitFor(() => expect(screen.getByTestId("always-show")).toHaveTextContent("true"));
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(readTour(1)).toEqual({ status: "completed", step: 9, alwaysShow: true });
  });

  it("does nothing at all when nobody is signed in", async () => {
    userId = null;
    mount();
    await waitFor(() => expect(screen.getByTestId("always-show")).toHaveTextContent("false"));
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});
