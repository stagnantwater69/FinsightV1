// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TourProvider, useTourOptional } from "./TourContext";
import { readTour, writeTour } from "../lib/tourStorage";
import type { UserPreferences } from "../lib/types";

/**
 * A NEW ACCOUNT IS ASKED, NOT TOURED.
 *
 * The tour used to open over the dashboard the moment a fresh account reached
 * it, straight after the setup wizard. Now the same gate raises an offer, and
 * only an explicit yes opens the overlay. Everything that already means yes
 * (a tour in progress, "always show") still opens it directly; the dismiss and
 * migration tests cover those.
 */

const updatePreferences = vi.fn(async (_patch: Partial<UserPreferences>) => {});

vi.mock("./AuthContext", () => ({
  useAuth: () => ({
    profile: { id: 1, firstName: "Ken" },
    preferences: { showDashboardMascotMessage: true, tourStatus: "not_started", tourStep: 0, tourAlwaysShow: false },
    preferencesLoaded: true,
    updatePreferences,
  }),
}));

vi.mock("./BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1 }, loading: false, error: null }),
}));

vi.mock("../components/tour/TourOverlay", () => ({
  TourOverlay: () => <div data-testid="overlay" />,
}));

function Probe() {
  const tour = useTourOptional();
  return (
    <div>
      <div data-tour="dashboard-loaded" />
      <span data-testid="active">{String(tour?.active)}</span>
      <span data-testid="offered">{String(tour?.offered)}</span>
      <button type="button" onClick={() => tour?.accept()}>
        accept
      </button>
      <button type="button" onClick={() => tour?.decline()}>
        decline
      </button>
    </div>
  );
}

function mount(entry = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TourProvider>
        <Probe />
      </TourProvider>
    </MemoryRouter>,
  );
}

function runPoll() {
  act(() => {
    vi.advanceTimersByTime(2000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  updatePreferences.mockClear();
  writeTour(1, { status: "not_started", alwaysShow: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the tour offer for an account that has never toured", () => {
  it("offers the tour instead of opening it", () => {
    mount();
    runPoll();
    expect(screen.getByTestId("offered")).toHaveTextContent("true");
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
  });

  it("opens the tour at the first step when accepted", () => {
    mount();
    runPoll();
    fireEvent.click(screen.getByRole("button", { name: "accept" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(readTour(1)).toMatchObject({ status: "in_progress", step: 0 });
  });

  it("records a decline as skipped and does not ask again this visit", () => {
    mount();
    runPoll();
    fireEvent.click(screen.getByRole("button", { name: "decline" }));
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(readTour(1).status).toBe("skipped");
    expect(updatePreferences).toHaveBeenCalledWith(expect.objectContaining({ tourStatus: "skipped" }));

    runPoll();
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("false");
  });

  it("starts the tour directly from the Tutorials link, without an offer first", () => {
    mount("/dashboard?tour=start");
    runPoll();
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(readTour(1)).toMatchObject({ status: "in_progress", step: 0 });
  });
});
