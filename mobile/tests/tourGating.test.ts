import { describe, expect, it } from "vitest";
import { resumeStepIndex, shouldStartTour, type TourGateInput } from "../src/lib/tourGating";
import type { TourStatus } from "../src/lib/tourStorage";

/**
 * When the product tour is allowed to take over the screen.
 *
 * WHY THIS IS THE PART UNDER TEST: there is no render harness in this project,
 * so TourProvider itself cannot be mounted. The decision it makes, though, is
 * the whole risk — a gate that is one condition too loose throws a ten-step
 * tour over the dashboard of an owner who finished it weeks ago, and one
 * condition too tight means a first-time owner never sees it at all. Both fail
 * silently on a device. So the rule lives in a pure function and the provider
 * only supplies its inputs.
 */

const READY: TourGateInput = {
  status: "not_started",
  reconciled: true,
  alwaysShow: false,
  hasProfile: true,
  dashboardLoaded: true,
  onHomeTab: true,
};

describe("shouldStartTour", () => {
  it("opens for a signed-in owner who has not seen it, on a loaded Home", () => {
    expect(shouldStartTour(READY)).toBe(true);
  });

  /**
   * The account's own answer has not arrived yet.
   *
   * This is the condition that carries the migration risk: tour state now
   * lives on the user row and the keystore is only a cache. On a phone that
   * has never run the tour, that cache says "not_started" whether the owner is
   * new or finished the whole thing on a laptop last month — so until
   * /auth/me has been reconciled, nothing here is safe to act on.
   */
  it("refuses to decide before the account's tour state has been reconciled", () => {
    expect(shouldStartTour({ ...READY, reconciled: false })).toBe(false);
    // Not even for the override: "always show on login" loosens WHICH
    // statuses may start, not whether the status is known at all.
    expect(shouldStartTour({ ...READY, reconciled: false, alwaysShow: true })).toBe(false);
  });

  it("resumes a run that was interrupted", () => {
    expect(shouldStartTour({ ...READY, status: "in_progress" })).toBe(true);
  });

  /**
   * completed and skipped both mean "I have dealt with this". Re-offering the
   * tour to someone who pressed Skip is the single most annoying thing this
   * feature could do.
   */
  it("stays shut once the owner has finished or skipped it", () => {
    for (const status of ["completed", "skipped"] as TourStatus[]) {
      expect(shouldStartTour({ ...READY, status }), status).toBe(false);
    }
  });

  /**
   * THE REASON THE PREFERENCE EXISTS. Showing the first-run experience to a
   * new helper, or in a demo, without creating a throwaway account to get a
   * fresh `not_started` back.
   */
  it("overrides a terminal status when 'always show on login' is on", () => {
    for (const status of ["completed", "skipped", "not_started", "in_progress"] as TourStatus[]) {
      expect(shouldStartTour({ ...READY, status, alwaysShow: true }), status).toBe(true);
    }
  });

  /**
   * The three conditions `alwaysShow` must NOT override, because they are not
   * preferences — they are whether there is anything to point at. A business
   * that does not exist yet renders an app whose header, quick actions and
   * figures are all empty, and every target after the welcome card lives on
   * Home or in the tab bar.
   */
  it("cannot be forced open without a business, off Home, or before the figures land", () => {
    for (const alwaysShow of [false, true]) {
      expect(shouldStartTour({ ...READY, alwaysShow, hasProfile: false }), "no business").toBe(false);
      expect(shouldStartTour({ ...READY, alwaysShow, onHomeTab: false }), "another tab").toBe(false);
      expect(shouldStartTour({ ...READY, alwaysShow, dashboardLoaded: false }), "still loading").toBe(false);
    }
  });
});

describe("resumeStepIndex", () => {
  it("picks up where an interrupted run left off", () => {
    expect(resumeStepIndex("in_progress", 4, 10)).toBe(4);
  });

  /** Anything that is not a live run starts at the welcome card. */
  it("starts from the beginning for every other status", () => {
    for (const status of ["not_started", "completed", "skipped"] as TourStatus[]) {
      expect(resumeStepIndex(status, 6, 10), status).toBe(0);
    }
  });

  /**
   * A stored index from a longer list — a step removed since — would otherwise
   * resume past the end and open the tour on nothing.
   */
  it("clamps a stored step that no longer exists", () => {
    expect(resumeStepIndex("in_progress", 99, 10)).toBe(9);
    expect(resumeStepIndex("in_progress", 3, 0)).toBe(0);
  });

  it("treats a missing or nonsensical step as the beginning", () => {
    expect(resumeStepIndex("in_progress", undefined, 10)).toBe(0);
    expect(resumeStepIndex("in_progress", -2, 10)).toBe(0);
    expect(resumeStepIndex("in_progress", Number.NaN, 10)).toBe(0);
  });
});
