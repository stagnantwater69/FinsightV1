import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * A drift guard for the UNRUN Maestro smoke path.
 *
 * READ THIS BEFORE COUNTING IT AS EVIDENCE. `mobile/e2e/flows/smoke.yaml` has
 * never been executed — there is no device, emulator or Maestro binary in this
 * environment (see mobile/e2e/README.md). This test does NOT run the flow and
 * does not show that the journey works.
 *
 * What it does show is the one thing that can be checked without a device:
 * every piece of copy the flow taps on or asserts still exists somewhere in
 * `mobile/src`. An unrun flow whose selectors quietly stop matching the app is
 * worse than no flow at all, because the first person to pick it up spends
 * their device time debugging stale strings instead of the app. This keeps the
 * flow honest until someone can actually run it.
 *
 * It deliberately does not check WHERE a string lives, only that it exists.
 * Anything stronger would be pretending to know how the app renders, which is
 * the exact overclaim this file is here to avoid.
 */

const ROOT = join(__dirname, "..");
const FLOW = join(ROOT, "e2e", "flows", "smoke.yaml");

/** Selectors that are Maestro/platform vocabulary rather than app copy. */
const NOT_APP_COPY = new Set<string>([
  // Empty for now. Tab bar labels come from the navigator options in App.tsx,
  // which is read below alongside src/, so they do not need an exemption.
]);

/** Strings matched by regex on purpose — the flow uses a partial matcher. */
const REGEX_SELECTORS = new Map<string, RegExp>([
  ["A what-if check.*", /A what-if check/],
]);

function sourceText(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(join(ROOT, "src"));
  files.push(join(ROOT, "App.tsx"));
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

/**
 * Pulls every literal selector out of the flow.
 *
 * Handles the three shapes the flow uses: `- tapOn: "Text"`, the `id:`/`text:`
 * long form, and `element:` under `scrollUntilVisible`.
 */
function selectorsInFlow(): string[] {
  const yaml = readFileSync(FLOW, "utf8");
  const found: string[] = [];

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;

    const short = line.match(
      /^-\s*(?:tapOn|assertVisible|assertNotVisible):\s*"([^"]+)"\s*$/,
    );
    if (short) {
      found.push(short[1]);
      continue;
    }

    const long = line.match(/^(?:-\s*)?(?:id|text|element):\s*"([^"]+)"\s*$/);
    if (long) found.push(long[1]);
  }

  return [...new Set(found)];
}

describe("Maestro smoke path selectors", () => {
  const flow = readFileSync(FLOW, "utf8");

  it("is labelled as never having been executed", () => {
    // The header is the whole reason this file is safe to keep in the repo.
    expect(flow).toMatch(/THIS FLOW HAS NEVER BEEN RUN/);
    const readme = readFileSync(join(ROOT, "e2e", "README.md"), "utf8");
    expect(readme).toMatch(/AUTHORED, NEVER EXECUTED/);
    expect(readme).toMatch(/never run/);
  });

  it("finds at least the journey the plan names", () => {
    // splash -> login -> onboarding -> tabs -> Spending Impact -> logout
    expect(flow).toMatch(/launchApp/);
    expect(flow).toContain("Log in");
    expect(flow).toContain("Your business");
    expect(flow).toContain("Insights");
    expect(flow).toContain("Spending impact");
    expect(flow).toContain("Sign out of FinSight?");
  });

  it("uses only copy that still exists in the app", () => {
    const src = sourceText();
    const missing = selectorsInFlow().filter((selector) => {
      if (NOT_APP_COPY.has(selector)) return false;
      if (selector.startsWith("${")) return false;
      const pattern = REGEX_SELECTORS.get(selector);
      if (pattern) return !pattern.test(src);
      return !src.includes(selector);
    });

    expect(missing).toEqual([]);
  });
});
