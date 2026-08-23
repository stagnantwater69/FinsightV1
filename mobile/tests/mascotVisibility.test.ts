import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * "Show Fin's daily message" turns off ONE thing.
 *
 * WHY THIS IS A SOURCE READ AND NOT A RENDER TEST: this project has no render
 * harness for the app, so what a screen actually draws cannot be asserted
 * here. What can be asserted is the wiring, and the wiring is where this
 * particular preference goes wrong — the mascot appears on five surfaces, and
 * a toggle wired one component too widely would take the tour's guide, the Ask
 * FinSight button or the camera's permission illustration with it. An owner
 * who turned off a daily greeting would find the help character gone from the
 * app, and nothing would have failed.
 *
 * The panel's appearance and its animation are NOT covered — by this or
 * anything else. They need a device.
 */

const ROOT = join(__dirname, "..");
const DASHBOARD = join(ROOT, "src", "screens", "DashboardScreen.tsx");

const dashboard = () => readFileSync(DASHBOARD, "utf8");

describe("the daily mascot message", () => {
  it("is gated on the preference where Home renders it", () => {
    const src = dashboard();
    // The guard and the component on the same side of the same condition —
    // not merely both present somewhere in a 700-line screen.
    expect(src).toMatch(
      /preferences\.showDashboardMascotMessage \? \(\s*<GreetingHero/,
    );
  });

  it("reads the preference from the account rather than a screen-local copy", () => {
    expect(dashboard()).toContain('useAuth');
  });

  /**
   * Home's own empty state has a mascot illustration on it. That one is not a
   * daily message — it is the picture on "you have not recorded anything yet",
   * which is the screen's only content at that moment. Hiding it would leave
   * an empty dashboard emptier still.
   */
  it("leaves Home's empty-state illustration alone", () => {
    const src = dashboard();
    const gated = src.split("preferences.showDashboardMascotMessage")[1] ?? "";
    // Only GreetingHero sits inside the gate.
    expect(gated.slice(0, 400)).toContain("<GreetingHero");
    expect(src).toContain("EmptyState");
  });

  /**
   * The other four surfaces, named individually so that wiring the toggle into
   * one of them fails here with a message that says which.
   */
  it("does not touch the tour mascot, the Ask FinSight button or the camera permission art", () => {
    const others = [
      join(ROOT, "src", "components", "tour", "TourMascot.tsx"),
      join(ROOT, "src", "components", "AskFinSightFab.tsx"),
      join(ROOT, "src", "components", "receipt-camera", "CameraPermissionState.tsx"),
    ];
    for (const file of others) {
      expect(
        readFileSync(file, "utf8"),
        `${file} must not consult showDashboardMascotMessage — it is not the daily message`,
      ).not.toContain("showDashboardMascotMessage");
    }
  });

  /**
   * And nowhere else at all: exactly two files in src/ may mention the
   * preference — the screen that hides the panel, and the Settings screen that
   * offers the switch. (lib/preferences.ts declares the default, so it is
   * counted too.)
   */
  it("is consulted in exactly the places that should consult it", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(join(ROOT, "src"));

    const mentions = files
      .filter((f) => readFileSync(f, "utf8").includes("showDashboardMascotMessage"))
      .map((f) => f.slice(join(ROOT, "src").length + 1).replace(/\\/g, "/"))
      .sort();

    expect(mentions).toEqual([
      "lib/preferences.ts",
      "lib/types.ts",
      "screens/DashboardScreen.tsx",
      "screens/SettingsScreen.tsx",
    ]);
  });
});
