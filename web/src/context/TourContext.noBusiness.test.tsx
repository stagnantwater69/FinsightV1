// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TourProvider, useTourOptional } from "./TourContext";
import { writeTour } from "../lib/tourStorage";
import type { UserPreferences } from "../lib/types";

/**
 * THE TOUR MUST NOT RUN BEFORE THERE IS A BUSINESS TO TOUR.
 *
 * Six of the ten steps point at chrome that only exists once an owner has a
 * business: the business switcher, the dashboard summary, Quick add (which
 * owns both the receipt-scanner and CSV steps), and Ask FinSight. The overlay
 * skips a step whose target is not on screen rather than stranding the tour —
 * correct on its own terms — so the two behaviours together turned a ten-step
 * walkthrough into four disconnected cards that teach nothing.
 *
 * The auto-start effect has always refused to run without `selected`. `restart`
 * did not, and that disagreement is the bug: "Restart product tour" in the
 * account menu walked straight past the gate the auto-start honours.
 *
 * It stayed invisible for as long as the dashboard rendered the setup card
 * instead of its `dashboard-loaded` marker, because `restart` then fell through
 * to its "not on the dashboard yet" branch and quietly did nothing. Once the
 * read-only pages became enterable the marker was there, and the stub tour
 * appeared. So the gate is asserted here rather than left to depend on which
 * markers a page happens to render.
 */

const updatePreferences = vi.fn(async (_patch: Partial<UserPreferences>) => {});

const PREFERENCES: UserPreferences = {
  showDashboardMascotMessage: true,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
};

/** Flipped per test — this is the whole variable under examination. */
let selected: { id: number } | null = null;

vi.mock("./AuthContext", () => ({
  useAuth: () => ({
    profile: { id: 1, firstName: "Ken" },
    preferences: PREFERENCES,
    preferencesLoaded: true,
    updatePreferences,
  }),
}));

vi.mock("./BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected, loading: false, error: null }),
}));

vi.mock("../components/tour/TourOverlay", () => ({
  TourOverlay: () => <div data-testid="overlay" />,
}));

function Probe() {
  const tour = useTourOptional();
  return (
    <div>
      {/* The marker the auto-start poll waits for. Present in both cases: an
          owner with no business now reaches a dashboard that settles empty,
          which is exactly the situation that made this reachable. */}
      <div data-tour="dashboard-loaded" />
      <span data-testid="active">{String(tour?.active)}</span>
      <span data-testid="available">{String(tour?.available)}</span>
      <button type="button" onClick={() => tour?.restart()}>
        restart
      </button>
    </div>
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <TourProvider>
        <Probe />
      </TourProvider>
    </MemoryRouter>,
  );
}

describe("the tour, before a business exists", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // A previously completed tour, so "Restart" is the realistic entry point:
    // this is the account menu's button, not a first-run auto-start.
    writeTour(1, { status: "completed", step: 9 });
  });

  it("refuses to restart, so nobody is shown a stub of the walkthrough", () => {
    selected = null;
    mount();

    expect(screen.getByTestId("available")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "restart" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");
  });

  it("restarts normally once there is a business", () => {
    selected = { id: 1 };
    mount();

    expect(screen.getByTestId("available")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "restart" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
  });
});
