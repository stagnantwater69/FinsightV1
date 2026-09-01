import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Every mascot state points at art that is actually in the repository.
 *
 * WHY A SOURCE READ. `src/components/MascotState.tsx` resolves its art with
 * Metro's `require("…png")`, which plain node cannot execute, and this project
 * has no render harness — so neither importing the module nor rendering the
 * component is possible here. What can be checked is the thing that actually
 * breaks on a device: a state whose filename is wrong. Metro resolves those
 * paths at build time, so a typo is a red screen, and the folder's filenames
 * are exactly the kind that get typed wrong — `singupstart`,
 * `passwordresetsuccesss` (three esses), and one with a space in it.
 *
 * WHAT THIS CANNOT COVER, and nothing else does either: how the art looks at
 * its rendered size, whether the fallback chain actually fires, whether the
 * image is announced by TalkBack/VoiceOver, and memory on a low-end phone.
 * All of those need a device.
 */

const ROOT = join(__dirname, "..");
const COMPONENT = join(ROOT, "src", "components", "MascotState.tsx");
const source = readFileSync(COMPONENT, "utf8");

/** The table body, so a `require` in a comment or the fallback cannot smuggle in. */
function tableBody(): string {
  const start = source.indexOf("const SOURCES: Record<MascotState, Thunk> = {");
  expect(start, "the SOURCES table has been renamed — this test parses it by name").toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n};", start));
}

/** `state: () => require("…")` pairs, as [state, relative path]. */
function mapping(): [string, string][] {
  return [...tableBody().matchAll(/^\s{2}(\w+):\s*\(\)\s*=>\s*require\("([^"]+\.png)"\)/gm)].map(
    (m) => [m[1]!, m[2]!] as [string, string],
  );
}

/** The union members, read off the exported type. */
function declaredStates(): string[] {
  const block = source.slice(source.indexOf("export type MascotState ="));
  const body = block.slice(0, block.indexOf(";"));
  return [...body.matchAll(/\|\s*"(\w+)"/g)].map((m) => m[1]!);
}

describe("the mascot state map", () => {
  it("parses at all", () => {
    // Guards every assertion below from passing vacuously after a rename.
    expect(mapping().length).toBeGreaterThanOrEqual(20);
    expect(declaredStates().length).toBeGreaterThanOrEqual(20);
  });

  it("points every state at a file that exists on disk", () => {
    const componentDir = join(ROOT, "src", "components");
    const missing = mapping()
      .filter(([, rel]) => !existsSync(join(componentDir, rel)))
      .map(([state, rel]) => `${state} → ${rel}`);
    expect(missing, `Mascot art referenced but not in the repository: ${missing.join(", ")}`).toEqual([]);
  });

  it("maps every declared state exactly once, and maps nothing it did not declare", () => {
    const mapped = mapping().map(([state]) => state);
    expect([...mapped].sort()).toEqual([...declaredStates()].sort());
    expect(new Set(mapped).size, "a state is listed twice in SOURCES").toBe(mapped.length);
  });

  it("gives no two states the same art", () => {
    // Not a correctness bug on its own, but the plan's whole point is that a
    // pose means a moment. Two moments sharing one pose is a mapping that was
    // filled in rather than chosen, and it should be an explicit decision.
    const byPath = new Map<string, string[]>();
    for (const [state, rel] of mapping()) byPath.set(rel, [...(byPath.get(rel) ?? []), state]);
    const shared = [...byPath.entries()].filter(([, states]) => states.length > 1);
    expect(shared.map(([rel, states]) => `${rel}: ${states.join(", ")}`)).toEqual([]);
  });

  /**
   * The approved set from the plan's §2 table, pinned by name. Adding a state
   * is a product decision — the plan says "do not place Fin on every screen"
   * — so a new key fails here and has to be argued for in the same commit.
   */
  it("carries the approved first-use set and no free-form additions", () => {
    expect([...declaredStates()].sort()).toEqual(
      [
        "aiAnalyzing",
        "appLaunch",
        "brandMark",
        "budgetAlmostExceeded",
        "businessSetup",
        "cameraPermission",
        "emptyDashboard",
        "forgotPassword",
        "importErrors",
        "login",
        "logoutConfirmation",
        "lowAvailableFunds",
        "noExpenseRecords",
        "noNotifications",
        "noSalesRecords",
        "noSearchResults",
        "noTransactions",
        "offline",
        "onboardingComplete",
        "passwordResetSuccess",
        "possibleDuplicate",
        "receiptScanning",
        "signUpStart",
        "unusualExpense",
        "uploadingFile",
      ].sort(),
    );
  });
});

describe("how the mapper renders", () => {
  it("contains the art rather than cropping it", () => {
    expect(source).toContain('resizeMode="contain"');
    expect(source).not.toContain('resizeMode="cover"');
  });

  it("is decorative unless a label is passed", () => {
    expect(source).toContain("const decorative = label === undefined");
    expect(source).toContain("accessibilityElementsHidden={decorative}");
    expect(source).toContain('importantForAccessibility={decorative ? "no-hide-descendants" : "yes"}');
  });

  it("has a fallback, and gives up rather than showing a broken image", () => {
    expect(source).toContain("const FALLBACK");
    expect(source).toContain("setGaveUp(true)");
    expect(source).toMatch(/if \(gaveUp\) return null/);
  });

  /**
   * The art is opaque RGB on a near-white plate, so it needs a frame of the
   * same colour or Dark mode gets a white rectangle. Pinned from BOTH ends:
   * the component must ask for the plate, and the plate must be the palette's
   * fixed `mascotPlate` rather than a literal that can drift from the art.
   */
  it("frames the art on the fixed mascot plate", () => {
    expect(source).toContain("t.mascotPlate");
    expect(source).toContain("plate = true");
    const palette = readFileSync(join(ROOT, "src", "theme", "palette.ts"), "utf8");
    expect(palette).toContain('const MASCOT_PLATE = "#fdfdfd"');
  });

  it("does not animate", () => {
    // Static art is the default per the plan; a loop belongs to the screen
    // that owns the work, with its own Reduce Motion gate.
    expect(source).not.toContain("Animated");
  });

  it("resolves art lazily, so the whole collection is never held at once", () => {
    expect(source).toContain("type Thunk = () => ImageSourcePropType");
    // No bare `state: require(...)` rows — every row is behind a thunk.
    expect(tableBody()).not.toMatch(/^\s{2}\w+:\s*require\(/m);
  });
});

/**
 * The tour keeps its own pose table on purpose (a pose vocabulary, not a set
 * of moments). This guards the other direction: no OTHER screen may go around
 * the mapper and `require` mascot art itself, which is the scattering the
 * mapper exists to end.
 */
describe("nothing else reaches for mascot art directly", () => {
  it("keeps mascot requires inside the mapper and the tour", () => {
    const { readdirSync } = require("fs") as typeof import("fs");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(join(ROOT, "src"));

    const offenders = files
      .filter((f) => /require\("[^"]*assets\/mascot\//.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(join(ROOT, "src").length + 1).replace(/\\/g, "/"))
      .sort();

    expect(offenders).toEqual([
      "components/MascotState.tsx",
      // Composites a prop badge over a pose; see the note in MascotState.tsx.
      "components/tour/TourMascot.tsx",
    ]);
  });
});
