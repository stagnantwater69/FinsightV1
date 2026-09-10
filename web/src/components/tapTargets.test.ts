import { describe, expect, it } from "vitest";

/**
 * `.tap` must not be cancelled by the classes written next to it.
 *
 * WHY: index.css defines `.tap` as "controls that should physically be that
 * big" — `min-h-tap min-w-tap`, the 44px Fitts's-Law floor. Several controls
 * applied `.tap` and then wrote `min-h-0 min-w-0 h-10 w-10` immediately after,
 * which keeps only the `inline-flex items-center justify-center` half of the
 * utility and silently drops the floor it exists for. A browser sweep measured
 * the result: the notification bell, theme switcher, account menu, global
 * search, sidebar collapse, business switcher, the Ask FinSight drawer header
 * and the auth back button all rendered at 36-40px rather than 44px.
 *
 * Writing the floor down was never the problem. Cancelling it on the next
 * class was — and because `.tap` was still in the string, every one of those
 * call sites read as though it had opted in.
 *
 * WHAT THIS ENFORCES: a class list may still say `min-h-0`/`min-w-0` next to
 * `.tap` — that is how a control keeps a deliberate box while overriding the
 * utility's default — but only if it then states a size that is itself at
 * least the floor. `h-11`/`w-11` is 44px; anything smaller is an undercut.
 *
 * SOURCE INSPECTION, NOT RENDERING: it proves the numbers as written are right
 * across every component at once, which is the one thing a render test cannot
 * do — it can only measure what it thinks to mount. It cannot prove the
 * resulting target is comfortable in a hand, or that a hit area does not
 * overlap its neighbour. Those stay browser and device questions.
 */

/**
 * Read through Vite rather than node:fs — tsconfig.app.json compiles `src`
 * with `types: ["vite/client"]` and no node types, so a `node:fs` import here
 * would typecheck under vitest and then fail the production `tsc -b`.
 *
 * Two globs rather than one `../**`: glob keys come back relative to THIS
 * file, so components arrive as `./Modal.tsx` and pages as `../pages/x.tsx`.
 * Globbing each root separately is what lets the names below read as repo
 * paths, which is what the allowlist and the failure message both quote.
 */
function sourcesUnder(
  mods: Record<string, unknown>,
  strip: RegExp,
  prefix: string,
): { name: string; src: string }[] {
  return Object.entries(mods)
    .map(([path, src]) => ({ name: `${prefix}${path.replace(strip, "")}`, src: src as string }))
    .filter(({ name }) => !name.endsWith(".test.tsx"));
}

const SOURCES = [
  ...sourcesUnder(
    import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }),
    /^\.\//,
    "components/",
  ),
  ...sourcesUnder(
    import.meta.glob("../pages/**/*.tsx", { query: "?raw", import: "default", eager: true }),
    /^\.\.\/pages\//,
    "pages/",
  ),
];

/**
 * Dense control clusters that are still under the floor, each one a row of
 * adjacent buttons where laying every control out to 44px — or expanding its
 * hit area to 44px — would make it overlap the control beside it and turn
 * "which button did I press" into a question of stacking order. Fixing these
 * needs a spacing decision about the surrounding layout, not a bigger number
 * here, so they are recorded rather than silently passing.
 *
 * THIS LIST MAY ONLY SHRINK. A new file here means a new control was written
 * under the floor; fix the control instead.
 */
const KNOWN_DENSE_CLUSTERS = [
  "components/Modal.tsx", // close button, tucked into the header corner
  "components/Pagination.tsx", // adjacent page-number buttons
  "components/aiChat/ChatHistoryOverlay.tsx", // list row actions
  "components/aiChat/ConversationItem.tsx", // hover actions inside a list row
  "components/tour/TourOverlay.tsx", // dismiss, inset into the callout corner
  "pages/Records.tsx", // four row actions in one table cell
  "pages/ScanReceipt.tsx", // per-row remove control
  "pages/scanReceipt/PickedFileThumb.tsx", // remove badge on a thumbnail corner
];

/** Tailwind's `h-11` is 44px — the first step that reaches the floor. */
const FLOOR_STEP = 11;

/** Lines that apply `.tap` and cancel its minimum on the same class list. */
function undercuts(src: string): number[] {
  const out: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (!/\btap\b/.test(line)) return;
    if (!/min-[hw]-0/.test(line)) return;
    // Strip the `min-h-0`/`min-w-0` tokens first: their own trailing `-0`
    // would otherwise be read as a declared size of zero.
    const sized = line.replace(/min-[hw]-\d+/g, "");
    const sizes = [...sized.matchAll(/\b[hw]-(\d+)\b/g)].map((m) => Number(m[1]));
    // `w-full` and friends are not a number; a control that states no numeric
    // size at all still has the utility's own minimum unless it cancelled it,
    // which it did — so treat "no size" as an undercut too.
    if (sizes.length > 0 && sizes.every((n) => n >= FLOOR_STEP)) return;
    if (sizes.length === 0 && /\b[hw]-full\b/.test(sized)) return;
    out.push(i + 1);
  });
  return out;
}

describe("tap targets", () => {
  it("finds the utility and enough components for the rule to mean anything", () => {
    // Guards the test itself: every assertion below is a "nothing is wrong"
    // shape, which an empty scan would satisfy perfectly.
    // vitest stubs CSS imports, so the utility is proven by its use rather
    // than by reading index.css: the floor is a real class that real chrome
    // applies, and the scan can actually see the files that apply it.
    expect(SOURCES.length).toBeGreaterThan(40);
    expect(SOURCES.map((f) => f.name)).toContain("components/AppShell.tsx");
    expect(SOURCES.map((f) => f.name)).toContain("pages/Records.tsx");
    expect(SOURCES.filter((f) => /\bmin-h-tap\b/.test(f.src)).length).toBeGreaterThan(0);
  });

  it("never cancels the tap floor without restating it, outside the known dense clusters", () => {
    const offenders = SOURCES
      .filter(({ name }) => !KNOWN_DENSE_CLUSTERS.includes(name))
      .flatMap(({ name, src }) => undercuts(src).map((line) => `${name}:${line}`));

    expect(
      offenders,
      `these apply .tap and then cancel its 44px floor: ${offenders.join(", ")}. ` +
        `Drop the min-h-0/min-w-0, or state a size of at least h-11/w-11 (44px).`,
    ).toEqual([]);
  });

  it("keeps the app chrome itself off the dense-cluster list", () => {
    // The chrome is every-page furniture and has room to lay out properly;
    // it must never be excused the way a packed table row is.
    for (const chrome of [
      "components/AppShell.tsx",
      "components/NotificationBell.tsx",
      "components/ThemeSwitcher.tsx",
      "components/AccountMenu.tsx",
      "components/BusinessSwitcher.tsx",
      "components/AuthLayout.tsx",
      "components/AskFinSightDrawer.tsx",
    ]) {
      expect(KNOWN_DENSE_CLUSTERS, `${chrome} must meet the floor, not be excused from it`).not.toContain(chrome);
    }
  });
});
