import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Every screen the app navigates to must actually be registered.
 *
 * WHY: `navigate("EditRecord")` sat on every card in the records list while
 * no screen by that name existed. React Navigation does not fail loudly for
 * this — the tap simply did nothing — so a saved record could not be
 * corrected on mobile at all, and nothing anywhere said why.
 *
 * This reads the source rather than rendering the app: the navigator is
 * declared statically, so a static check catches the whole class of typo
 * without needing a device or a render harness.
 */

const ROOT = join(__dirname, "..");
const SCREENS_DIR = join(ROOT, "src", "screens");

function sourceFiles(): string[] {
  return readdirSync(SCREENS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(join(SCREENS_DIR, f), "utf8"));
}

/** Names passed to navigation.navigate("X") anywhere in the screens. */
function navigationTargets(): Set<string> {
  const targets = new Set<string>();
  for (const src of sourceFiles()) {
    for (const m of src.matchAll(/navigate\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
      targets.add(m[1]!);
    }
  }
  return targets;
}

/** Names registered as a Stack.Screen or Tab.Screen in App.tsx. */
function registeredScreens(): Set<string> {
  const app = readFileSync(join(ROOT, "App.tsx"), "utf8");
  const names = new Set<string>();
  for (const m of app.matchAll(/<(?:Stack|Tab)\.Screen\s+name=["']([A-Za-z0-9_]+)["']/g)) {
    names.add(m[1]!);
  }
  return names;
}

describe("navigation targets", () => {
  it("finds the navigator and the call sites at all", () => {
    // Guards the test itself: if the regexes stop matching, the assertion
    // below would pass vacuously and prove nothing.
    expect(registeredScreens().size).toBeGreaterThan(5);
    expect(navigationTargets().size).toBeGreaterThan(3);
  });

  it("registers every screen the app navigates to", () => {
    const registered = registeredScreens();
    const missing = [...navigationTargets()].filter((t) => !registered.has(t));
    expect(missing, `navigate() targets with no registered screen: ${missing.join(", ")}`).toEqual([]);
  });
});
