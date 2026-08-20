import { describe, expect, it } from "vitest";
import { POSE_FALLBACK, TOUR_STEPS } from "./steps";

/**
 * Invariants the tour engine relies on. These are the checks that catch a
 * hand-edited step drifting into a shape the overlay can't drive — the kind
 * of mistake that otherwise only shows up as a tour silently skipping steps.
 */
describe("tour step configuration", () => {
  it("has the full ten-step arc, welcome first and completion last", () => {
    expect(TOUR_STEPS.length).toBe(10);
    expect(TOUR_STEPS[0]!.id).toBe("welcome");
    expect(TOUR_STEPS[0]!.target).toBeUndefined();
    expect(TOUR_STEPS.at(-1)!.id).toBe("complete");
    expect(TOUR_STEPS.at(-1)!.target).toBeUndefined();
    expect(TOUR_STEPS.at(-1)!.finalActions?.length).toBeGreaterThan(0);
  });

  it("uses unique ids and data-tour selectors only", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of TOUR_STEPS) {
      if (step.target) expect(step.target).toMatch(/^\[data-tour="[a-z-]+"\]$/);
    }
  });

  it("maps every step to a mascot pose under /mascot/", () => {
    for (const step of TOUR_STEPS) {
      expect(step.mascot.pose).toMatch(/^\/mascot\/.+\.webp$/);
    }
    expect(POSE_FALLBACK).toMatch(/^\/mascot\/.+\.webp$/);
  });

  it("marks only targeted steps as needing the Quick-add menu", () => {
    for (const step of TOUR_STEPS) {
      if (step.requiresQuickAdd) expect(step.target).toBeTruthy();
    }
    const quickAddIds = TOUR_STEPS.filter((s) => s.requiresQuickAdd).map((s) => s.id);
    expect(quickAddIds).toEqual(["receipt-scanner", "csv-import"]);
  });
});
