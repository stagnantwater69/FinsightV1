import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * An accessibility prop set on something the platform never surfaces.
 *
 * WHY THIS FILE EXISTS. React Native maps `accessible` straight onto
 * isAccessibilityElement, and it is false unless set. A `View` that carries a
 * role, a label or a value but not `accessible` is invisible to VoiceOver and
 * TalkBack, so everything written on it is read to nobody. An `<Image>` has
 * the same shape from the other direction: Image.ios.js and Image.android.js
 * both decide `accessible` from `alt`, so an `accessibilityLabel` alone leaves
 * the picture unnamed.
 *
 * This has now been found six separate times in this codebase — the Spending
 * Impact gauge, RecoveryMeter's bar, the CSV import progress bar, six of the
 * seven chart summaries, the mascot on Home, and the receipt photograph on a
 * saved record. Every one of them looked correct in review, because the prop
 * IS there and IS spelled right. That is what makes it worth a guard: the
 * rendered tests in tests/render/ prove the fixed cases stay fixed, and this
 * catches the NEXT one, in a file nobody thought to mount.
 *
 * WHAT IS DELIBERATELY ALLOWED, and why each one is not the same defect:
 *
 *   - `accessibilityLiveRegion` on a plain container. That is an Android
 *     attribute about content CHANGING inside the subtree, and it works on a
 *     container precisely because the container is not an element. Setting
 *     `accessible` on these would swallow the retry and dismiss buttons they
 *     wrap, trading the announcement for the only way out of the error state.
 *   - `accessibilityViewIsModal` on the tour overlay, which is about focus
 *     containment rather than about being read.
 *   - Anything already opted out with `accessibilityElementsHidden` or
 *     `importantForAccessibility`, which is a decision, not an oversight.
 *
 * WHAT THIS DOES NOT PROVE. That a surfaced element is announced usefully, in
 * the right order, or at the right moment. Only a device with a screen reader
 * running can say that.
 */

const SRC = join(__dirname, "..", "src");

/** Props that only mean something on an element the platform surfaces. */
const NEEDS_ELEMENT = /accessibility(Role|Label|Value|State|Hint)=/;

/** Props that are about a subtree or focus, not about being read. */
const NOT_ABOUT_BEING_READ = /accessibilityLiveRegion|accessibilityViewIsModal/;

/** Already an element, or already deliberately hidden. */
const SETTLED = /\baccessible\b|\balt=|accessibilityElementsHidden|importantForAccessibility/;

/** Host components that are not accessibility elements until told to be. */
const HOSTS = /<(View|Animated\.View|ScrollView|SafeAreaView|ImageBackground|Image)\b/g;

function tsxFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFilesUnder(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * The text of one JSX opening tag, from `<Name` to its closing `>`.
 *
 * Written by hand rather than with a regex because an opening tag routinely
 * contains `>` inside a brace expression (`sections.indexOf(x) > 0`) and
 * inside strings, and a lazy `[^>]*>` stops at the first of those — which
 * silently truncates the tag and hides whatever prop came after it. Quotes,
 * template literals and brace depth are tracked so the scan ends at the right
 * `>`.
 */
function openingTagAt(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = from;

  for (; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) break;
  }

  return source.slice(from, i + 1);
}

/** Every host element whose accessibility props land on nothing. */
function unsurfacedElements(): string[] {
  const found: string[] = [];

  for (const file of tsxFilesUnder(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(HOSTS)) {
      const start = match.index!;
      const tag = openingTagAt(source, start + match[0].length);
      if (!NEEDS_ELEMENT.test(tag)) continue;
      if (NOT_ABOUT_BEING_READ.test(tag)) continue;
      if (SETTLED.test(tag)) continue;

      const line = source.slice(0, start).split("\n").length;
      found.push(`${file.slice(SRC.length + 1)}:${line} <${match[1]}>`);
    }
  }

  return found;
}

describe("Accessibility props land on elements the platform surfaces", () => {
  it("has no View or Image carrying a role, label, value or state it cannot speak", () => {
    expect(unsurfacedElements()).toEqual([]);
  });

  it("recognises the defect when it is put back", () => {
    // The guard is only worth having if it fails on the shape it exists for,
    // so the matcher set is exercised directly rather than trusted.
    const broken = `<View accessibilityRole="progressbar" accessibilityLabel="Import progress" />`;
    expect(NEEDS_ELEMENT.test(broken)).toBe(true);
    expect(SETTLED.test(broken)).toBe(false);

    const fixed = `<View accessible accessibilityRole="progressbar" />`;
    expect(SETTLED.test(fixed)).toBe(true);
  });

  it("reads past a comparison inside a brace expression", () => {
    // The truncation bug this scanner would otherwise have: `>` inside `{}`.
    const source = `<Image source={x} label={n > 0 ? a : b} accessible />`;
    expect(openingTagAt(source, "<Image".length)).toContain("accessible");
  });
});
