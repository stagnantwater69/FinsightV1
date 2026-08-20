import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "../src/components/tour/steps";

/**
 * Which Fin appears on which step, and whether the art behind it exists.
 *
 * WHY A SOURCE READ RATHER THAN A RENDER: TourMascot.tsx `require`s PNGs,
 * which is a Metro capability that the plain-node test runner does not have —
 * and there is no render harness here in any case. What can still be checked
 * without a device is the part that actually breaks: a step naming a pose the
 * component cannot resolve, or a pose pointing at an asset that is not in the
 * repository. Both of those fail on a phone as a blank space where the mascot
 * should be, with nothing in any log.
 *
 * The two-stage fallback (pose → greeting → hide the image) and how the prop
 * badge sits on the art still need a real device.
 */

const MASCOT = join(__dirname, "..", "src", "components", "tour", "TourMascot.tsx");
const source = readFileSync(MASCOT, "utf8");

/** `pose: require("…/x.png")` and the shared `GREETING` constant, as paths. */
function assetPaths(): string[] {
  return [...source.matchAll(/require\("([^"]+\.png)"\)/g)].map((m) => m[1]!);
}

/** The pose names TourMascot can resolve, read off its POSE_SOURCES table. */
function resolvablePoses(): Set<string> {
  const table = source.slice(source.indexOf("const POSE_SOURCES"));
  const body = table.slice(0, table.indexOf("};"));
  return new Set([...body.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((m) => m[1]!));
}

describe("tour mascot mapping", () => {
  it("finds the pose table at all", () => {
    // Guards the parsing: a renamed table would otherwise make every
    // assertion below pass vacuously.
    expect(resolvablePoses().size).toBeGreaterThanOrEqual(5);
    expect(assetPaths().length).toBeGreaterThan(3);
  });

  it("gives every step a pose the component can resolve", () => {
    const known = resolvablePoses();
    const unknown = TOUR_STEPS.filter((s) => !known.has(s.mascot.pose)).map(
      (s) => `${s.id} → ${s.mascot.pose}`,
    );
    expect(unknown, `Steps naming a pose TourMascot cannot resolve: ${unknown.join(", ")}`).toEqual([]);
  });

  it("points every pose at an asset that is in the repository", () => {
    const missing = assetPaths().filter(
      (rel) => !existsSync(join(__dirname, "..", "src", "components", "tour", rel)),
    );
    expect(missing, `Mascot assets referenced but not present: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * The onboarding poses this tour is built from. Pinned by name because the
   * mapping is "closest existing pose plus a prop badge" — if one of these
   * files is moved or renamed, the tour silently loses its illustration and
   * falls back to the greeting Fin on every step.
   */
  it("uses the onboarding poses the mapping is based on", () => {
    for (const asset of [
      "assets/greeting.png",
      "assets/mascot/01-onboarding/businessprofilesetup.png",
      "assets/mascot/01-onboarding/tutorial.png",
      "assets/mascot/01-onboarding/emptydashboard.png",
      "assets/mascot/01-onboarding/onboardingcomplete.png",
    ]) {
      expect(existsSync(join(__dirname, "..", asset)), asset).toBe(true);
    }
  });

  /**
   * The badge is what makes a shared pose situation-specific, so the steps
   * that reuse a pose must not also share a bare version of it — that is the
   * case that reads as "the tour showed me the same picture twice".
   */
  it("never shows the same pose and badge twice", () => {
    const seen = TOUR_STEPS.map((s) => `${s.mascot.pose}+${s.mascot.prop ?? "bare"}`);
    expect(
      new Set(seen).size,
      `Two steps with an identical mascot: ${seen.join(", ")}`,
    ).toBe(seen.length);
  });

  it("keeps the centered cards (welcome, completion) free of a prop badge", () => {
    for (const step of TOUR_STEPS.filter((s) => !s.target)) {
      expect(step.mascot.prop, step.id).toBeUndefined();
    }
  });
});
