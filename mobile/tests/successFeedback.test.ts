import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Saving something must tell the owner it saved.
 *
 * WHY: four flows used to fire a haptic and navigate away, and a fifth — the
 * sales record — did not even do that. It posted and went back, and the only
 * evidence anything had happened was a new row somewhere in the list. A
 * haptic is silent for anyone who has haptics switched off in system
 * settings, and invisible to everyone, so a save could complete with no
 * feedback the owner could actually perceive.
 *
 * The rule: if a handler writes to the API and then leaves the screen, it
 * hands forward a message. Checked here rather than in a render test because
 * this repo has no render harness — and because the failure is structural,
 * not visual, so the source is the right place to catch it.
 */

const ROOT = join(__dirname, "..");
const SCREENS_DIR = join(ROOT, "src", "screens");

/**
 * Calls that write to the server. Reads never need a confirmation.
 *
 * `delete` is spelled out. An earlier version abbreviated it to `del`, which
 * a trailing \b then refused to match against `api.delete` — so every delete
 * flow was invisible to this check, which is precisely the kind of hole that
 * makes a guard worse than none.
 */
const WRITE = /await api\.(post|patch|put|upload|delete)\b/;

/**
 * How far back from a goBack() to look for the write that caused it. Handlers
 * in this codebase put the two within a few lines of each other; 20 is slack
 * enough for a long argument object without spilling into the next function.
 */
const LOOKBACK = 20;

/**
 * Every screen file under src/screens, at any depth.
 *
 * Recursive because screens now live in per-feature subdirectories (e.g.
 * screens/records/) as well as directly in screens/ — a flat readdirSync
 * silently stopped seeing an entire feature's worth of save-and-leave sites
 * the moment its screen was moved into one.
 */
function tsxFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFilesUnder(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

function screenSources(): { name: string; lines: string[] }[] {
  return tsxFilesUnder(SCREENS_DIR).map((full) => ({
    name: full.slice(SCREENS_DIR.length + 1),
    lines: readFileSync(full, "utf8").split("\n"),
  }));
}

/** Every "wrote, then left" site, with whether it hands a message forward. */
function saveAndLeaveSites(): { where: string; announced: boolean }[] {
  const sites: { where: string; announced: boolean }[] = [];

  for (const { name, lines } of screenSources()) {
    lines.forEach((line, i) => {
      if (!line.includes("navigation.goBack()")) return;

      const window = lines.slice(Math.max(0, i - LOOKBACK), i);
      const wrote = window.some((l) => WRITE.test(l));
      if (!wrote) return; // a plain "back" button, nothing to announce

      sites.push({
        where: `${name}:${i + 1}`,
        announced: window.some((l) => l.includes("setFlash(")),
      });
    });
  }
  return sites;
}

describe("success feedback", () => {
  it("finds the save-and-leave sites at all", () => {
    // Guards the test itself: if the scan stops matching, the assertion below
    // would pass vacuously and prove nothing.
    expect(saveAndLeaveSites().length).toBeGreaterThanOrEqual(4);
  });

  it("announces every save that navigates away", () => {
    const silent = saveAndLeaveSites().filter((s) => !s.announced);
    expect(
      silent.map((s) => s.where),
      `saves that leave the screen without telling the owner: ${silent.map((s) => s.where).join(", ")}. ` +
        `Call setFlash("…") before navigation.goBack().`,
    ).toEqual([]);
  });
});
