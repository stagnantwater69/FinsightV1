import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Nothing tappable is smaller than a finger.
 *
 * WHY: `TAP = 44` has existed in theme/tokens.ts since the beginning, and the
 * shared chip was written as `TAP - 10` (34) and the shared segment as
 * `TAP - 8` (36) — both of them a deliberate-looking undercut of the one
 * constant that exists to stop exactly that, in the two controls used most
 * across the app. Writing the floor down was never the problem; subtracting
 * from it at the point of use was.
 *
 * WHAT THIS ENFORCES, in three parts:
 *
 *   1. The floor is real and platform-correct — 44 is Apple's number, 48 is
 *      Android's, and the phones this app is for are Android.
 *   2. No style value is written as `TAP - something`. That expression is the
 *      whole failure mode, and it reads as intentional every time.
 *   3. Every hand-written Pressable in the shared primitives and the camera
 *      chrome either measures the floor or carries a hitSlop that makes up the
 *      difference.
 *
 * SOURCE INSPECTION, NOT RENDERING, like navigationTargets, chipConsistency
 * and pressableRoles beside it. It proves the NUMBERS as written are right,
 * across every file at once — which is the one thing a render test cannot do,
 * since it can only measure what it thinks to mount.
 *
 * Its counterpart is tests/render/touchTargets.test.tsx, which mounts the
 * shared primitives and measures the flattened style off the host element,
 * catching the undercuts that only appear once a style has been composed from
 * a variant table and a caller override. Neither can prove the resulting
 * layout is comfortable, that a target is reachable one-handed, or that camera
 * chrome over live video behaves — those are physical-device questions and
 * stay that way.
 */

const ROOT = join(__dirname, "..");

/**
 * The files this rule is enforced over in full: the shared primitives every
 * screen is built from, and the receipt camera's own chrome, which is the one
 * place that draws its own controls rather than using the primitives.
 *
 * The screens are covered by the weaker rule further down instead. That is a
 * scope decision, not an exemption — see the note there.
 */
const OWNED = ["components/ui.tsx", "components/touchTarget.ts", "components/receipt-camera"];

/** Where the platform floor is defined. */
const FLOOR_MODULE = join(ROOT, "src", "components", "touchTarget.ts");

/** How a style value announces that it undercuts the floor. */
const UNDERCUT = /(minHeight|minWidth|height|width):\s*TAP\s*-/;

function tsxFilesUnder(dir: string, prefix = ""): { name: string; full: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFilesUnder(full, `${prefix}${entry.name}/`);
    return /\.tsx?$/.test(entry.name) ? [{ name: `${prefix}${entry.name}`, full }] : [];
  });
}

function sourceFiles(): { name: string; src: string }[] {
  const dirs = [join(ROOT, "src", "screens"), join(ROOT, "src", "components")];
  return dirs.flatMap((dir) =>
    tsxFilesUnder(dir, dir.endsWith("screens") ? "screens/" : "components/").map(({ name, full }) => ({
      name,
      src: readFileSync(full, "utf8"),
    })),
  );
}

const isOwned = (name: string) => OWNED.some((o) => name === o || name.startsWith(`${o}/`));

/**
 * One Pressable and its opening tag, taken as far as the element goes.
 *
 * Bounded by the next `<Pressable` or `</Pressable>` rather than by a fixed
 * line count, because the opening tags in ui.tsx run to forty lines once an
 * accessibility label is computed inline — pressableRoles' fourteen-line window
 * is enough to find `accessibilityRole`, which is written first, and not enough
 * to find a `style` prop written last.
 */
function pressableElements(src: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf("<Pressable", from);
    if (start === -1) break;
    const nextOpen = src.indexOf("<Pressable", start + 1);
    const close = src.indexOf("</Pressable>", start + 1);
    const ends = [nextOpen, close].filter((i) => i !== -1);
    const end = ends.length > 0 ? Math.min(...ends) : src.length;
    found.push({
      line: src.slice(0, start).split("\n").length,
      text: src.slice(start, end),
    });
    from = start + 1;
  }
  return found;
}

/**
 * Whether an element states a target at least the floor.
 *
 * `hitSlop` counts, and it has to: the plan allows it where laying a control
 * out to the floor would make a dense row ambiguous — the section strip's
 * reorder arrows and the camera's guide toggle are both that case. What it
 * cannot do is tell you the slop is BIG ENOUGH, or that it does not overlap the
 * control beside it. Those live in comments at the call sites and, ultimately,
 * on a device.
 */
function statesATarget(text: string): boolean {
  if (text.includes("hitSlop")) return true;
  if (text.includes("TAP_FLOOR")) return true;
  if (/styles\.(button|chip|segment)/.test(text)) return true;
  // Fills its parent, so it is as big as whatever contains it — the modal
  // backdrops, and the crop editor's step buttons.
  if (/flex: 1/.test(text)) return true;
  // A laid-out size already past the floor, written as a plain number: the
  // shutter (72) and the section thumbnails (52 × 66).
  for (const m of text.matchAll(/(?:minHeight|height|width):\s*(\d+)\b/g)) {
    if (Number(m[1]) >= 48) return true;
  }
  return false;
}

describe("touch targets", () => {
  it("finds the files and the floor at all", () => {
    // Guards the test itself. Every assertion below is a "nothing is wrong"
    // shape, which an empty scan satisfies perfectly.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    // Was 7. The receipt-camera folder shrank from eight hand-rolled screens
    // (manual shutter, guide, permission state, crop editor, preview…) to two
    // small files once ML Kit Document Scanner replaced the custom camera —
    // see docs/receipt-camera.md. `components/receipt-camera/index.ts` is one
    // of the five counted here and, being a type-only barrel, contributes no
    // Pressables at all; the count below is adjusted the same way.
    expect(files.filter((f) => isOwned(f.name)).length).toBeGreaterThanOrEqual(5);

    const tokens = readFileSync(join(ROOT, "src", "theme", "tokens.ts"), "utf8");
    expect(tokens).toMatch(/export const TAP = 44/);

    expect(readFileSync(FLOOR_MODULE, "utf8")).toContain("export const TAP_FLOOR");
  });

  it("keeps the floor out of tokens.ts, and tokens.ts free of React Native", () => {
    /*
     * The floor cannot move into the theme layer, and this is what stops it.
     *
     * tokens.ts is imported by src/lib/confidenceBands.ts, authValidation.ts
     * and conversationGroups.ts — the modules tests/webParity.test.ts holds to
     * a shared contract with the web app. A `react-native` import there would
     * put a native dependency behind logic whose entire point is being
     * shareable. TAP_FLOOR needs `Platform`, so TAP_FLOOR stays in its own
     * module and tokens.ts stays a pure value table.
     *
     * Also the reason there must be exactly ONE floor: a second
     * `Platform.select` minimum somewhere else is how 44 and 48 end up both
     * being "the number" in different files.
     */
    const tokens = readFileSync(join(ROOT, "src", "theme", "tokens.ts"), "utf8");
    expect(
      tokens,
      "theme/tokens.ts must not import react-native — see components/touchTarget.ts for why",
    ).not.toMatch(/from\s+["']react-native/);
    expect(tokens, "TAP_FLOOR belongs in components/touchTarget.ts, not the token table").not.toContain(
      "TAP_FLOOR",
    );
  });

  it("resolves the floor per platform: 48 on Android, TAP on iOS", () => {
    const floor = readFileSync(FLOOR_MODULE, "utf8");
    const line = floor.split("\n").find((l) => l.includes("export const TAP_FLOOR")) ?? "";
    // Android's Material floor is 48dp and most FinSight owners are on Android,
    // so a shared control built to 44 is built to the wrong number on the
    // device it will actually be used on.
    expect(line, "TAP_FLOOR must be at least 48 on Android").toMatch(/android:\s*48/);
    expect(line, "TAP_FLOOR must fall back to the TAP token elsewhere").toMatch(/default:\s*TAP/);
  });

  it("never writes a style value as TAP minus something", () => {
    const offenders = sourceFiles()
      .filter(({ name }) => isOwned(name))
      .flatMap(({ name, src }) =>
        src
          .split("\n")
          .map((line, i) => ({ line, at: `${name}:${i + 1}` }))
          .filter(({ line }) => UNDERCUT.test(line))
          .map(({ at }) => at),
      );

    expect(
      offenders,
      `these subtract from the tap floor: ${offenders.join(", ")}. ` +
        `Use TAP_FLOOR from components/touchTarget, or keep the visual size and add a hitSlop that reaches the floor.`,
    ).toEqual([]);
  });

  it("gives the shared chip and segment the full floor", () => {
    // Named specifically because these two are the reason this file exists,
    // and because hitSlop is NOT an option for either: chip rows wrap with a
    // 4-point gap and segments sit flush inside their track, so slop on either
    // would overlap its neighbour and make which control you hit a question of
    // stacking order.
    const ui = readFileSync(join(ROOT, "src", "components", "ui.tsx"), "utf8");
    const block = (name: string) => {
      const at = ui.indexOf(`\n  ${name}: {`);
      expect(at, `the ${name} style block moved or was renamed`).toBeGreaterThan(-1);
      return ui.slice(at, ui.indexOf("},", at));
    };
    expect(block("chip")).toContain("minHeight: TAP_FLOOR");
    expect(block("segment")).toContain("minHeight: TAP_FLOOR");
    expect(block("button")).toContain("minHeight: TAP_FLOOR");
  });

  it("states a target on every Pressable in the shared primitives and camera chrome", () => {
    const bare: string[] = [];
    for (const { name, src } of sourceFiles()) {
      if (!isOwned(name)) continue;
      for (const el of pressableElements(src)) {
        if (!statesATarget(el.text)) bare.push(`${name}:${el.line}`);
      }
    }

    expect(
      bare,
      `Pressables with no stated touch target: ${bare.join(", ")}. ` +
        `Lay it out to TAP_FLOOR (components/touchTarget), or add a hitSlop that makes up the difference and say why at the call site.`,
    ).toEqual([]);
  });

  it("finds enough Pressables in the owned files for the rule above to mean anything", () => {
    const count = sourceFiles()
      .filter(({ name }) => isOwned(name))
      .reduce((n, { src }) => n + pressableElements(src).length, 0);
    // Was 15. All of the receipt-camera's hand-rolled Pressables (shutter,
    // gallery button, torch, guide toggle, section-strip controls, crop
    // handles…) went with the custom camera they belonged to. What remains in
    // that folder now composes the shared `Button` from components/ui.tsx
    // rather than writing its own Pressable, so ui.tsx's own dozen carry this
    // count on their own.
    expect(count).toBeGreaterThanOrEqual(12);
  });

  /**
   * The screens WERE a sweep with an allowlist. The allowlist is now empty.
   *
   * It existed because several of these files were owned by other people and
   * being edited concurrently, so the rule could only stop the list growing
   * rather than fail anyone into a fix. Every file on it has since been swept
   * — DateField, TourOverlay, ExpenseBehaviorScreen, DashboardScreen,
   * SpendingImpactScreen, BusinessScreens and ScanReceiptScreen — so the
   * exemption is gone and the rule is the same everywhere: no file in
   * src/screens or src/components writes a target as the tap token minus
   * something.
   *
   * Deliberately left with NO allowlist parameter to add a file back to. The
   * two legitimate escapes are already expressible in the code itself: lay the
   * control out to TAP_FLOOR, or keep the visual size as a named constant and
   * derive the hitSlop from TAP_FLOOR (BusinessScreens' HIDE_LINK_SLOP and
   * TourOverlay's SKIP_SLOP are both that shape). A subtraction from the token
   * is not one of them.
   *
   * WHAT IT STILL DOES NOT PROVE: that a control with slop does not overlap
   * its neighbour, and that any of this is comfortable in a hand. Those are
   * device questions and stay that way.
   */
  it("lets no file in screens or components undercut the floor", () => {
    const offenders = sourceFiles()
      .filter(({ src }) => src.split("\n").some((l) => UNDERCUT.test(l)))
      .map(({ name }) => name);

    expect(
      offenders,
      `files subtracting from the tap floor: ${offenders.join(", ")}. ` +
        `Import TAP_FLOOR from components/touchTarget rather than writing TAP minus a few points.`,
    ).toEqual([]);
  });
});
