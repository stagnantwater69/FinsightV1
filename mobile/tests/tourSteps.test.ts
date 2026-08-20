import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  eligibilityTarget,
  eligibleStepIndexes,
  QUICK_ADD_STEP_IDS,
  nextStepIndex,
  previousStepIndex,
  stepPosition,
  TOUR_STEPS,
  type TourStep,
} from "../src/components/tour/steps";

/**
 * The step list, and moving over it.
 *
 * The overlay itself cannot be rendered in this project (no render harness),
 * so everything about it that can go wrong WITHOUT a device is pushed into
 * these pure functions: which steps this owner is eligible to see, what Next
 * and Back do at the ends, how a step whose target never measures is passed
 * over, and what "N of M" says. The spotlight geometry, the gestures and the
 * camera-free permission-less parts of the modal still need a real phone.
 */

/** Nothing is on screen — the worst case a real device can hand the overlay. */
const nothingVisible = () => false;
const everythingVisible = () => true;

/** Only these target keys are on screen. */
const visible = (...keys: string[]) => (step: TourStep) => !!step.target && keys.includes(step.target);

describe("tour step configuration", () => {
  it("has the full arc, welcome first and completion last", () => {
    // Web's ten plus the two "+" menu actions the phone teaches — see the
    // divergence note in steps.ts and the parity test that records it.
    expect(TOUR_STEPS.length).toBe(12);
    expect(TOUR_STEPS[0]!.id).toBe("welcome");
    expect(TOUR_STEPS[0]!.target).toBeUndefined();
    expect(TOUR_STEPS.at(-1)!.id).toBe("complete");
    expect(TOUR_STEPS.at(-1)!.target).toBeUndefined();
  });

  it("uses unique ids and unique targets", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const targets = TOUR_STEPS.map((s) => s.target).filter(Boolean);
    expect(
      new Set(targets).size,
      "Two steps spotlighting the same element read as a tour that has got stuck",
    ).toBe(targets.length);
  });

  /**
   * Every target a step names must be one a screen actually registers.
   * Checked against the source rather than by rendering, because a key with
   * no `useTourTarget` call behind it fails the quiet way: the step is
   * skipped on a device and nothing anywhere says so.
   */
  it("names only targets that some screen claims", () => {
    /*
     * The claim is the key written down outside the tour's own folder —
     * either passed straight to `useTourTarget("…")` (Home's header, the Ask
     * button, the raised "+"), or declared as data that reaches it (App.tsx's
     * tab-name table, the CSV quick action's `tourTarget`). Both forms are
     * real registrations; only matching the direct call would fail the two
     * that are driven by data, which is why this looks for the literal.
     */
    const sources = ["App.tsx", "src/screens", "src/components"]
      .map((rel) => join(__dirname, "..", rel))
      .flatMap((path) => filesUnder(path))
      .filter((file) => !file.includes(join("components", "tour")))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    // Guards the scan itself: an empty read would make the assertion below
    // pass while proving nothing.
    expect(sources).toContain("useTourTarget");

    const orphans = TOUR_STEPS.filter((s) => s.target && !sources.includes(`"${s.target}"`)).map(
      (s) => s.id,
    );
    expect(orphans, `Steps pointing at a key no screen claims: ${orphans.join(", ")}`).toEqual([]);
  });
});

describe("eligibility", () => {
  it("always includes the steps that have no target", () => {
    const eligible = eligibleStepIndexes(TOUR_STEPS, nothingVisible);
    expect(eligible.map((i) => TOUR_STEPS[i]!.id)).toEqual(["welcome", "complete"]);
  });

  it("includes every step when the whole app is on screen", () => {
    expect(eligibleStepIndexes(TOUR_STEPS, everythingVisible).length).toBe(TOUR_STEPS.length);
  });
});

describe("moving over the steps", () => {
  it("walks forward one step at a time when everything is visible", () => {
    expect(nextStepIndex(TOUR_STEPS, 0, everythingVisible)).toBe(1);
    expect(previousStepIndex(TOUR_STEPS, 3, everythingVisible)).toBe(2);
  });

  /** null forward is what the overlay turns into "Finish". */
  it("reports the end of the road rather than wrapping", () => {
    expect(nextStepIndex(TOUR_STEPS, TOUR_STEPS.length - 1, everythingVisible)).toBeNull();
    expect(previousStepIndex(TOUR_STEPS, 0, everythingVisible)).toBeNull();
  });

  /**
   * THE RULE THAT KEEPS THE TOUR UNSTUCK. A step whose element is not on
   * screen — a feature not rendered, a view that never laid out — is passed
   * over in the direction of travel rather than left as a dimmed screen
   * describing something that is not there.
   */
  it("skips over steps whose target is not on screen", () => {
    const onlyBell = visible("notifications");
    // From welcome (0), everything between it and the bell is unmeasurable.
    const target = nextStepIndex(TOUR_STEPS, 0, onlyBell);
    expect(TOUR_STEPS[target!]!.id).toBe("notifications");
    // And back again from the completion card, the same way.
    const backwards = previousStepIndex(TOUR_STEPS, TOUR_STEPS.length - 1, onlyBell);
    expect(TOUR_STEPS[backwards!]!.id).toBe("notifications");
  });

  it("still finishes when no target at all can be measured", () => {
    // welcome -> complete -> end. A phone that registered nothing still gets a
    // tour it can walk out of the front of.
    const first = nextStepIndex(TOUR_STEPS, 0, nothingVisible);
    expect(TOUR_STEPS[first!]!.id).toBe("complete");
    expect(nextStepIndex(TOUR_STEPS, first!, nothingVisible)).toBeNull();
  });
});

describe("the step counter", () => {
  it("counts only the steps this owner will be shown", () => {
    const { position, total } = stepPosition(TOUR_STEPS, 0, nothingVisible);
    expect({ position, total }).toEqual({ position: 1, total: 2 });
  });

  it("numbers the whole arc when everything is on screen", () => {
    expect(stepPosition(TOUR_STEPS, 4, everythingVisible)).toEqual({ position: 5, total: 12 });
  });

  /**
   * The transitional case: the overlay asks for a position while standing on a
   * step that has just become ineligible. It must still produce a sane pair
   * rather than "0 of 8".
   */
  it("never reports a zeroth step", () => {
    const onlyBell = visible("notifications");
    const { position, total } = stepPosition(TOUR_STEPS, 3, onlyBell);
    expect(position).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
  });
});

/**
 * The two steps that point INSIDE the "+" menu.
 *
 * The menu only exists while one of them is the active step, because the tab
 * bar opens it in response to exactly those two ids. So eligibility has to ask
 * about the "+" BUTTON: asking about the item would have each step decide it
 * cannot be shown, skip itself, and take the menu with it — a tour that can
 * never reach the two steps that open anything.
 */
describe("the steps that open the quick-add menu", () => {
  it("points each of them at an item in the menu, not at the button", () => {
    const inMenu = TOUR_STEPS.filter((s) => s.requiresQuickAdd);
    // In the order the arc reads left to right, which is the order the eye
    // follows once the menu is open.
    expect(inMenu.map((s) => s.id)).toEqual([
      "manual-entry",
      "sales-reference",
      "receipt-scanner",
      "csv-import",
    ]);
    expect(inMenu.map((s) => s.target)).toEqual([
      "quick-add-expense",
      "quick-add-sales",
      "quick-add-scan",
      "quick-add-csv",
    ]);
  });

  /**
   * The tab bar opens the menu from this list. Restating the ids there is how
   * a new quick-add step ends up spotlighting an item inside a menu that never
   * opens — which on a device is indistinguishable from a missing target.
   */
  it("hands the tab bar exactly those ids to hold the menu open for", () => {
    expect([...QUICK_ADD_STEP_IDS]).toEqual(
      TOUR_STEPS.filter((s) => s.requiresQuickAdd).map((s) => s.id),
    );
  });

  it("asks about the button when deciding whether they can be shown", () => {
    for (const step of TOUR_STEPS.filter((s) => s.requiresQuickAdd)) {
      expect(eligibilityTarget(step)).toBe("quick-add");
    }
    // Every other step is judged on the thing it actually points at.
    const records = TOUR_STEPS.find((s) => s.id === "records")!;
    expect(eligibilityTarget(records)).toBe(records.target);
  });

  it("keeps them in the tour when only the + button is on screen", () => {
    // What a real phone reports before the menu has been opened.
    const menuClosed = (step: TourStep) => eligibilityTarget(step) === "quick-add";
    const shown = eligibleStepIndexes(TOUR_STEPS, menuClosed).map((i) => TOUR_STEPS[i]!.id);
    expect(shown).toContain("receipt-scanner");
    expect(shown).toContain("csv-import");
  });

  it("no longer teaches importing through Home's own shortcut", () => {
    const targets = TOUR_STEPS.map((s) => s.target);
    expect(targets, "the CSV step must point at the menu, which is on every screen").not.toContain(
      "quick-action-csv",
    );
  });
});

/** Every .ts/.tsx under a path, or the path itself if it is a file. */
function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}
