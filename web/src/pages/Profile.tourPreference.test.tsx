// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readTour, setAlwaysShowTour, writeTour } from "../lib/tourStorage";

/**
 * The rule the Profile toggle exists to create, asserted at the decision it
 * drives rather than through the DOM.
 *
 * The tour is once-per-account by design: a terminal status (completed or
 * skipped) is what stops it interrupting a real owner forever. That also made
 * it impossible to show to anyone — demonstrating it, or re-checking a change
 * to it, meant registering a new account or clearing storage by hand.
 * `alwaysShow` is the one sanctioned way past that, so it is the one piece of
 * the gate worth pinning here: TourContext must consult it before honouring a
 * terminal status, and nothing about finishing the tour may switch it off.
 */
function autoStartAllowed(userId: number): boolean {
  // Mirrors TourContext's gate, minus the parts that need a mounted app
  // (signed in, profile selected, dashboard loaded).
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
