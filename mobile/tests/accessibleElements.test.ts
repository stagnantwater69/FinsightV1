import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * A role nobody hears is not a role.
 *
 * React Native maps the `accessible` prop straight onto the platform's
 * `isAccessibilityElement`, and for a `View` that defaults to FALSE. So a View
 * carrying `accessibilityRole="progressbar"` and a carefully worded
 * `accessibilityValue.text` is announced as absolutely nothing — the props are
 * set on an object the platform never offers to a screen reader. `Image` has
 * the same shape for a different reason: RN only sets `accessible` on it when
 * `alt` is given, so an `accessibilityLabel` alone is silently discarded.
 *
 * THIS HAS NOW HAPPENED THREE TIMES — the Spending Impact gauge, the
 * before/after bars and RecoveryMeter's Bar, then the CSV import progress bar
 * and the crop editor's corner handles. Each looked completely correct at the
 * call site and each was read out as silence. It reads as done, which is what
 * makes it recur, so it is a rule now rather than a thing to remember.
 *
 * THE RULE: a View or an Image that states an `accessibilityRole` or an
 * `accessibilityValue` must also set `accessible` — unless it is a CONTAINER,
 * in which case `accessible` would be the bug instead (see CONTAINERS below)
 * and it has to be named here with its reason.
 *
 * Pressable, Touchable* and Text are not covered: all three are accessibility
 * elements already, Pressable and Touchable by setting `accessible` themselves
 * and Text by being text.
 *
 * SOURCE INSPECTION, deliberately. tests/render/accessibleName.test.tsx mounts
 * the specific surfaces and proves they are actually reachable through a role
 * query, which is stronger evidence — but only for what it thinks to mount.
 * This sweeps every file, which is what catches the fourth occurrence in a
 * component nobody wrote a render test for.
 *
 * WHAT NEITHER PROVES: that VoiceOver or TalkBack reads any of this in a
 * sensible ORDER, at a sensible time, or in words that help. That is a device
 * question with a person attached to it.
 */

const ROOT = join(__dirname, "..", "src");

/**
 * The elements that are only accessibility elements once told to be.
 *
 * Animated.View/Animated.Image forward their props to the same host component,
 * so they inherit the same defaults and the same defect.
 */
const NEEDS_ACCESSIBLE = ["View", "Image", "Animated\\.View", "Animated\\.Image"];

/**
 * The Views where `accessible` would be the bug.
 *
 * A grouping role exists to HAVE individually focusable children. Setting
 * `accessible` on one folds every child into a single element, which does not
 * make the container announce better — it makes its contents unreachable. Each
 * entry is a file:line-anchored reason rather than a bare exemption, because
 * "it is on the list" is how the original defect would come back wearing this
 * test as cover.
 */
const CONTAINERS: Record<string, string> = {
  "components/InsightsShared.tsx":
    "role=tablist. The tabs inside carry their own tab role and selected state; " +
    "making the list an element would collapse all of them into one.",
  "components/ConnectionNotice.tsx":
    "role=alert wrapping a retry Button. accessibilityLiveRegion does the " +
    "announcing; `accessible` would swallow the only way out of the error.",
};

function sourceFiles(dir: string, prefix = ""): { name: string; src: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, `${prefix}${entry.name}/`);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ name: `${prefix}${entry.name}`, src: readFileSync(full, "utf8") }];
  });
}

/**
 * Comments blanked out, newlines kept so line numbers still mean something.
 *
 * Necessary rather than tidy: this file's own explanations quote the props
 * being looked for, and an apostrophe in a prose comment ("Button's danger
 * variant") otherwise opens a string as far as the scanner is concerned and
 * swallows the next forty lines.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/**
 * Every opening JSX tag for the components above, taken to its closing `>`.
 *
 * Brace-depth aware, because `style={{ ... }}` contains `>` inside arrow
 * functions (`({ pressed }) => ...`) and a naive scan stops at the first one,
 * which is always before the accessibility props.
 */
function openingTags(src: string): { component: string; line: number; text: string }[] {
  const found: { component: string; line: number; text: string }[] = [];
  const re = new RegExp(`<(${NEEDS_ACCESSIBLE.join("|")})\\s`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote !== null) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push({
      component: m[1],
      line: src.slice(0, m.index).split("\n").length,
      text: src.slice(m.index, i + 1),
    });
  }
  return found;
}

const STATES_ROLE = /\baccessibilityRole=|\baccessibilityValue=/;
/** `accessible`, `accessible={x}` or `accessible />` — but not `accessibilityFoo`. */
const IS_ELEMENT = /\baccessible[\s=/>]/;

function offenders() {
  return sourceFiles(ROOT).flatMap(({ name, src }) => {
    const clean = stripComments(src);
    return openingTags(clean)
      .filter((tag) => STATES_ROLE.test(tag.text) && !IS_ELEMENT.test(tag.text))
      .map((tag) => ({ name, at: `${name}:${tag.line}`, component: tag.component }));
  });
}

describe("accessibility elements", () => {
  it("scans enough of the app for the rule to mean anything", () => {
    // Guards the test itself: every assertion below is a "nothing is wrong"
    // shape, which a scan that found no files satisfies perfectly.
    const files = sourceFiles(ROOT);
    expect(files.length).toBeGreaterThan(50);

    const withTags = files.filter(({ src }) => openingTags(stripComments(src)).length > 0);
    expect(withTags.length).toBeGreaterThan(30);

    // And that the comment stripper has not eaten the file: the reference
    // implementation must still be visible to the scanner.
    const onboarding = files.find((f) => f.name === "screens/OnboardingScreens.tsx");
    expect(onboarding).toBeDefined();
    const railTags = openingTags(stripComments(onboarding!.src)).filter((t) =>
      t.text.includes('accessibilityRole="progressbar"'),
    );
    expect(railTags.length).toBeGreaterThan(0);
    for (const tag of railTags) expect(tag.text).toMatch(IS_ELEMENT);
  });

  it("never states a role or a value on a View or Image that is not an element", () => {
    const bare = offenders().filter(({ name }) => !(name in CONTAINERS));

    expect(
      bare.map((o) => `${o.at} <${o.component}>`),
      "these set accessibilityRole/accessibilityValue on something React Native " +
        "does not surface, so the announcement is silence. Add `accessible` " +
        "(see screens/OnboardingScreens.tsx's StepRail), or — if it is a " +
        "grouping role whose children must stay focusable — add it to " +
        "CONTAINERS in this file with the reason.",
    ).toEqual([]);
  });

  it("keeps the container exemptions honest", () => {
    const found = new Set(offenders().map((o) => o.name));

    // Each exemption must still describe a real container. A stale entry is
    // worse than none: it is a pre-approved place to reintroduce the bug.
    for (const [name, reason] of Object.entries(CONTAINERS)) {
      expect(found.has(name), `${name} is exempted but no longer has a bare role — remove the exemption`).toBe(
        true,
      );
      expect(reason.length, `${name}'s exemption needs a reason, not a name`).toBeGreaterThan(40);
    }
  });

  it("does not let the exemption list grow quietly", () => {
    // Was 3. The receipt-camera's own alert container
    // (components/receipt-camera/CameraControls.tsx, wrapping a scanner
    // failure's retry/dismiss buttons) went with the rest of the custom
    // camera it belonged to — see docs/receipt-camera.md. What replaced it
    // (ScannerStatusStates.tsx) states its failure message on plain Text,
    // which needs no container exemption at all. Two remain, and each is an
    // alert. If this needs raising, the thing being added is probably a leaf
    // that wants `accessible`.
    expect(Object.keys(CONTAINERS)).toHaveLength(2);
  });
});
