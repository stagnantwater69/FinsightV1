// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TourProvider, useTourOptional } from "./TourContext";
import { writeTour } from "../lib/tourStorage";
import type { UserPreferences } from "../lib/types";

/**
 * DISMISSING THE TOUR HAS TO STICK — INCLUDING WITH "ALWAYS SHOW" ON.
 *
 * The auto-start effect depends on `active`, and its early return for a
 * completed/skipped tour is deliberately bypassed when the `alwaysShow`
 * preference is set. `stop()` only set `active` to false, so the effect
 * immediately re-ran, found the override, and restarted the tour: an owner
 * who had turned the preference on could not close the tour at all, and the
 * dashboard underneath it was unusable.
 *
 * The fix is a latch scoped to this mount, NOT a change to what `alwaysShow`
 * means. So both halves are asserted: a dismissal holds for the rest of this
 * visit, and a fresh visit is still offered the tour.
 */

const updatePreferences = vi.fn(async (_patch: Partial<UserPreferences>) => {});
let preferences: UserPreferences;

vi.mock("./AuthContext", () => ({
  useAuth: () => ({
    profile: { id: 1, firstName: "Ken" },
    preferences,
    preferencesLoaded: true,
    updatePreferences,
  }),
}));

vi.mock("./BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1 }, loading: false, error: null }),
}));

// The provider's own auto-start logic is what is under test; the overlay is
// a portal full of geometry that would only add noise to it.
vi.mock("../components/tour/TourOverlay", () => ({
  TourOverlay: () => <div data-testid="overlay" />,
}));

function Probe() {
  const tour = useTourOptional();
  return (
    <div>
      {/* The dashboard-loaded marker the auto-start poll waits for. */}
      <div data-tour="dashboard-loaded" />
      <span data-testid="active">{String(tour?.active)}</span>
      <button type="button" onClick={() => tour?.stop("skipped")}>
        dismiss
      </button>
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

/** Lets the 400ms auto-start poll run a few times. */
function runPoll() {
  act(() => {
    vi.advanceTimersByTime(2000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  updatePreferences.mockClear();
  preferences = {
    showDashboardMascotMessage: true,
    tourStatus: "completed",
    tourStep: 0,
    tourAlwaysShow: true,
  };
  // "Always show the tour" is on, over a tour this account already finished.
  writeTour(1, { status: "completed", step: 0, alwaysShow: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dismissing the tour with 'always show' on", () => {
  it("offers the tour on arrival, as the preference promises", () => {
    mount();
    runPoll();
    expect(screen.getByTestId("active")).toHaveTextContent("true");
  });

  it("stays dismissed for the rest of the visit", () => {
    mount();
    runPoll();

    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");

    // The restart loop was here: the effect re-ran on the state change and
    // put the tour straight back up.
    runPoll();
    expect(screen.getByTestId("active")).toHaveTextContent("false");
  });

  it("is offered again on a later visit — the preference still means what it said", () => {
    const first = mount();
    runPoll();
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    runPoll();
    first.unmount();

    mount();
    runPoll();
    expect(screen.getByTestId("active")).toHaveTextContent("true");
  });

  it("comes back immediately when the owner asks for it from the account menu", () => {
    mount();
    runPoll();
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");

    fireEvent.click(screen.getByRole("button", { name: "restart" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
  });
});
