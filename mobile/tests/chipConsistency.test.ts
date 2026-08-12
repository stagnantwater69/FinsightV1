import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Selection chips are drawn in one place.
 *
 * WHY: eleven of them had grown across the app — filters, category pickers,
 * period switchers, CSV column mapping — in five different visual treatments.
 * They were close enough to look like a mistake and far enough apart to feel
 * like different controls, and the parts that kept getting dropped were the
 * invisible ones: not one of the eleven gave any feedback on touch, and two
 * had no accessibility props at all.
 *
 * Consolidating them was the fix. This test is what keeps them consolidated:
 * the twelfth chip is the one nobody notices being hand-rolled, and by then
 * the drift has already happened.
 *
 * Reads source rather than rendering, for the same reason navigationTargets
 * does — the styles are static, so a static check catches the whole class
 * without needing a device or a render harness.
 */

const ROOT = join(__dirname, "..");

/**
 * The pill's signature: a fully-rounded shape whose BACKGROUND carries the
 * brand colour. Kept as two markers because they are written on different
 * lines and in either order.
 *
 * The background is what makes this specific. Plenty of things are pill-shaped
 * and mention brand[600] without being chips — the Ask FinSight composer is a
 * rounded input whose border turns brand on focus. An earlier version of this
 * check looked for the colour anywhere in the block and flagged that input,
 * which is how a guard starts costing more than it catches. A chip is filled;
 * an input is outlined.
 */
const CHIP_RADIUS = "radius.full";
const CHIP_FILL = /backgroundColor:[^,]*brand\[600\]/;

/**
 * Files allowed to pair those two markers.
 *
 * `ui.tsx` is where the chips now live. Nothing else is exempt — an addition
 * here should be argued for, not assumed, because each one is a control that
 * looks like a chip to the owner but does not behave like the others.
 */
const ALLOWED = new Set(["ui.tsx"]);

function sourceFiles(): { name: string; src: string }[] {
  const dirs = [join(ROOT, "src", "screens"), join(ROOT, "src", "components")];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => ({ name: f, src: readFileSync(join(dir, f), "utf8") })),
  );
}

/**
 * Style objects written inline as `style={{ ... }}`. Good enough to spot a
 * hand-rolled chip: nesting a brace-counted parse would buy accuracy this
 * check does not need, since a style object that nests deeply enough to fool
 * it is already worth a look.
 */
function inlineStyleBlocks(src: string): string[] {
  return src
    .split("style={{")
    .slice(1)
    .map((chunk) => chunk.split("}}")[0] ?? "");
}

describe("chip consistency", () => {
  it("finds the files and the chip primitives at all", () => {
    // Guards the test itself: if the scan stops finding files, or the
    // primitives get renamed, the assertions below would pass vacuously.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(10);

    const ui = readFileSync(join(ROOT, "src", "components", "ui.tsx"), "utf8");
    expect(ui).toContain("export function SelectChip");
    expect(ui).toContain("export function SegmentedControl");
  });

  it("draws every selection chip through the shared primitives", () => {
    const offenders: string[] = [];

    for (const { name, src } of sourceFiles()) {
      if (ALLOWED.has(name)) continue;
      for (const block of inlineStyleBlocks(src)) {
        if (block.includes(CHIP_RADIUS) && CHIP_FILL.test(block)) {
          offenders.push(name);
          break;
        }
      }
    }

    expect(
      offenders,
      `hand-rolled selection chips found in: ${offenders.join(", ")}. ` +
        `Use SelectChip or SegmentedControl from components/ui instead.`,
    ).toEqual([]);
  });

  it("actually uses the primitives at the call sites", () => {
    // The rule above is satisfiable by deleting every chip in the app, which
    // would be a regression the offender check cannot see. Floor of 3, not a
    // specific file list: Home's Today/Week/Month selector was removed by
    // design (the dashboard redesign dropped period switching in favour of a
    // fixed monthly view), which is what took this from 4 down to 3 — the
    // remaining call sites are InsightsScreens, DateField and RecordsScreens.
    const usage = sourceFiles().filter(
      ({ name, src }) => !ALLOWED.has(name) && /<(SelectChip|SegmentedControl)\b/.test(src),
    );
    expect(usage.length).toBeGreaterThanOrEqual(3);
  });
});
