/**
 * The ink-400 guard (QA register A11Y-002).
 *
 * `--ink-400` is the muted step. It is a *placeholder* weight: in Classic and
 * Light it sits between 2.08:1 and 3.36:1 on the app's surfaces, which fails
 * WCAG 2.1 AA (1.4.3) for anything a reader actually has to read. It had drifted
 * onto 100+ pieces of informative secondary text — "(optional)" markers, created
 * dates, the product tour's step counter and its "Skip tour" control.
 *
 * Two halves to this file:
 *
 *  1. The arithmetic, computed from the real token values in `index.css`, so
 *     the rule below stays true if a theme's neutrals are ever retuned.
 *  2. A source sweep, so the distinction can't be quietly re-lost — the whole
 *     point of the register entry.
 */
/*
 * Read through `node:fs`, and named `*.node.test.ts` because of it: vitest
 * stubs CSS imports (`index.css?raw` comes back empty), and `import.meta.glob`
 * cannot reach the stylesheet either. tsconfig.app.json compiles `src` with
 * `types: ["vite/client"]` and no node types, so this one file is excluded
 * there and compiled by tsconfig.node.json instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = fs.readFileSync(path.join(SRC, "index.css"), "utf8");

type Rgb = [number, number, number];

/** Pulls one theme's block out of index.css and reads its space-separated RGB channels. */
function themeTokens(selector: string): Record<string, Rgb> {
  const at = CSS.indexOf(selector);
  expect(at, `${selector} block missing from index.css`).toBeGreaterThan(-1);
  const block = CSS.slice(at, CSS.indexOf("\n  }", at));
  const out: Record<string, Rgb> = {};
  for (const m of block.matchAll(/--((?:ink|paper|tint)[\w-]*):\s*(\d+) (\d+) (\d+);/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const THEMES = {
  classic: themeTokens('[data-theme="classic"] {'),
  light: themeTokens('[data-theme="light"] {'),
  dark: themeTokens('[data-theme="dark"] {'),
};

/** The surfaces text is set on. `paper`/`paper-50` are cards and the page. */
const FLAT_SURFACES = ["paper", "paper-50"] as const;
/** Sunken surfaces: wells, table headers, chips, and every status wash. */
const SUNKEN_SURFACES = ["paper-100", "paper-200"] as const;

const AA = 4.5;

describe("ink token contrast", () => {
  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: ink-400 is a placeholder weight, not a reading weight`, () => {
      // Documents WHY the sweep below exists rather than asserting a target:
      // ink-400 misses AA on at least one real surface in every theme.
      const worst = Math.min(
        ...[...FLAT_SURFACES, ...SUNKEN_SURFACES].map((s) => contrast(t["ink-400"], t[s])),
      );
      expect(worst).toBeLessThan(AA);
    });

    it(`${name}: ink-500 clears AA on paper and paper-50`, () => {
      for (const surface of FLAT_SURFACES) {
        expect(
          contrast(t["ink-500"], t[surface]),
          `ink-500 on ${surface} in ${name}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`${name}: ink-600 clears AA on every surface, including the tint washes`, () => {
      const surfaces = [
        ...FLAT_SURFACES,
        ...SUNKEN_SURFACES,
        "tint-brand",
        "tint-accent",
        "tint-danger",
        "tint-info",
        "tint-neutral",
      ];
      for (const surface of surfaces) {
        expect(
          contrast(t["ink-600"], t[surface]),
          `ink-600 on ${surface} in ${name}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    });
  }

  it("ink-500 is NOT enough on the sunken surfaces — which is why ink-600 exists there", () => {
    // Light's ink-500 lands at 4.34 on paper-100 and 3.86 on paper-200. If a
    // future retune fixes that, this test fails and the ink-600-on-sunken rule
    // in index.css can be relaxed. It should not be relaxed before then.
    expect(contrast(THEMES.light["ink-500"], THEMES.light["paper-100"])).toBeLessThan(AA);
  });
});

/* ------------------------------------------------------------------ */

const ALLOWED_VARIANTS = new Set([
  // Placeholder text is duplicated by the label above it.
  "placeholder:",
  // Disabled controls are explicitly exempt from WCAG 1.4.3.
  "disabled:",
  "group-disabled:",
  "peer-disabled:",
]);

/** Every non-test source file under `src`, as `{ name, source }`. */
function sourceFiles(dir: string, acc: { name: string; source: string }[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push({ name: path.relative(SRC, p), source: fs.readFileSync(p, "utf8") });
    }
  }
  return acc;
}

const SOURCES = sourceFiles(SRC);

describe("ink-400 stays a placeholder token", () => {
  it("is never used for text a reader has to read", () => {
    const violations: string[] = [];

    for (const { name, source } of SOURCES) {
      const lines = source.split("\n");

      for (const match of source.matchAll(/([a-zA-Z-]+:)?text-ink-400/g)) {
        const index = match.index ?? 0;
        const lineNo = source.slice(0, index).split("\n").length;
        const line = lines[lineNo - 1];

        // 1. A sanctioned Tailwind variant.
        if (match[1] && ALLOWED_VARIANTS.has(match[1])) continue;
        // Any *other* variant (hover:, group-hover:, …) still has to justify
        // itself — it can end up being the only styling a reader ever sees.

        // 2. A decorative glyph: `aria-hidden`, or one of the shared `<Icon*>`
        //    components, which are all `aria-hidden` internally (icons.tsx).
        const tag = source.slice(source.lastIndexOf("<", index), source.indexOf(">", index) + 1);
        if (/aria-hidden/.test(tag) || /^<Icon[A-Z]/.test(tag)) continue;

        // 3. An explicit, reasoned opt-out on the line or the one above it.
        if (/ink-400-ok:/.test(line) || /ink-400-ok:/.test(lines[lineNo - 2] ?? "")) continue;

        violations.push(`${name}:${lineNo}  ${line.trim()}`);
      }
    }

    expect(
      violations,
      [
        "ink-400 fails WCAG AA for body text in Classic and Light (2.08–3.36:1).",
        "Use text-ink-500 on paper/paper-50, or text-ink-600 on paper-100/",
        "paper-200/tint-* — see the CONTRAST note in src/index.css. If the text",
        "really is decorative, mark the element aria-hidden or annotate the line",
        "with `ink-400-ok: <reason>`.",
        "",
        ...violations,
      ].join("\n"),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The other half of the same rule.
 *
 * ink-500 is the correct informative weight on `paper`/`paper-50` and the
 * wrong one everywhere else: 4.34:1 on paper-100 and 3.86:1 on paper-200 in
 * Light, both short of AA (the arithmetic above proves it from the real
 * tokens). Moving ink-400 up to ink-500 fixed the loudest cases and left the
 * pre-existing ones sitting on sunken surfaces — GlobalSearch's keyboard
 * hints inside its `bg-paper-100` footer, ScanProgress's "done" step label
 * inside its `bg-paper-100` card, DataTable's own sticky header.
 *
 * "Which surface is this on" has to be answered from the source, so it is
 * answered the way a reader would: find the nearest enclosing element that
 * declares a background. JSX here is consistently indented, so the enclosing
 * elements are the lines above with strictly smaller indentation — and a
 * sibling's background is never reached, because a sibling is at the same
 * indent, not a smaller one.
 */

/** Sunken enough that ink-500 misses AA. Unprefixed only — see below. */
const SUNKEN_BG = /(?<![\w:-])bg-(?:paper-100|paper-200|tint-[a-z]+)\b/;
/** Flat enough that ink-500 is correct, and stops the upward walk. */
const FLAT_BG = /(?<![\w:-])bg-(?:paper|paper-50|white)(?![\w-])/;

const indentOf = (line: string) => (line.match(/^ */) ?? [""])[0].length;

function enclosingSurface(lines: string[], lineNo: number, beforeOnLine: string) {
  // Same line first: `<div className="bg-paper-100 … text-ink-500">`.
  if (SUNKEN_BG.test(beforeOnLine)) return "sunken";
  if (FLAT_BG.test(beforeOnLine)) return "flat";

  let indent = indentOf(lines[lineNo - 1]);
  for (let i = lineNo - 2; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind >= indent) continue; // a sibling or its contents, not an ancestor
    indent = ind;
    if (SUNKEN_BG.test(line)) return "sunken";
    if (FLAT_BG.test(line)) return "flat";
    if (ind === 0) break;
  }
  return null;
}

describe("ink-500 stays off the sunken surfaces", () => {
  it("is never the colour of text sitting on paper-100, paper-200 or a tint wash", () => {
    const violations: string[] = [];

    for (const { name, source } of SOURCES) {
      const lines = source.split("\n");

      for (const match of source.matchAll(/([a-zA-Z-]+:)?text-ink-500/g)) {
        // Variant-prefixed (`hover:`, `group-hover:`, `disabled:`…) is skipped
        // wholesale: those apply in a state that usually changes the surface
        // underneath them too, so the static surface here says nothing useful
        // about them.
        if (match[1]) continue;

        const index = match.index ?? 0;
        const lineNo = source.slice(0, index).split("\n").length;
        const line = lines[lineNo - 1];
        const lineStart = source.lastIndexOf("\n", index - 1) + 1;

        if (enclosingSurface(lines, lineNo, source.slice(lineStart, index)) !== "sunken") continue;

        // Same two escapes the ink-400 sweep grants, for the same reasons.
        const tag = source.slice(source.lastIndexOf("<", index), source.indexOf(">", index) + 1);
        if (/aria-hidden/.test(tag) || /^<Icon[A-Z]/.test(tag)) continue;
        if (/ink-500-ok:/.test(line) || /ink-500-ok:/.test(lines[lineNo - 2] ?? "")) continue;

        violations.push(`${name}:${lineNo}  ${line.trim()}`);
      }
    }

    expect(
      violations,
      [
        "ink-500 measures 4.34:1 on paper-100 and 3.86:1 on paper-200 in Light —",
        "both under AA. On a sunken surface (paper-100, paper-200, any tint-*",
        "wash) informative text uses text-ink-600; ink-500 is for paper/paper-50.",
        "See the CONTRAST note in src/index.css. If the text really is decorative,",
        "mark the element aria-hidden or annotate the line with",
        "`ink-500-ok: <reason>`.",
        "",
        ...violations,
      ].join("\n"),
    ).toEqual([]);
  });
});

/**
 * A fixed-colour fill must take a fixed-colour foreground.
 *
 * The `ink` scale INVERTS per theme — `ink-900` is the near-black body step in
 * Classic/Light and the near-WHITE headings step in Dark. That is correct on a
 * `paper` surface, which inverts with it. It is a bug on a fill that does not
 * invert: `brand-*` and `accent-*` are literal brand values, identical in all
 * three themes, so an `ink` foreground over one of them lands wherever the
 * theme happens to put it.
 *
 * This is how the amber primary button shipped at 1.87:1 in Dark (8.08 Classic
 * / 8.75 Light), and the same shape as the Toast `bg-ink-900` defect. Both
 * were invisible to every other test in the suite.
 */
describe("fixed brand fills take fixed foregrounds", () => {
  /** Literal brand values from tailwind.config.js — these do NOT vary by theme. */
  const FIXED_FILLS: Record<string, Rgb> = {
    "accent-400": [245, 165, 36],
    "accent-500": [224, 140, 11],
    "brand-600": [13, 127, 114],
    "brand-700": [14, 101, 92],
  };

  it("the primary button's amber fill clears AA in every theme", () => {
    const button = fs.readFileSync(path.join(SRC, "components/Button.tsx"), "utf8");
    const primary = button.match(/primary:\s*\n?\s*"([^"]+)"/)?.[1];
    expect(primary, "could not read the primary variant's classes").toBeTruthy();

    // The regression: an `ink-*` foreground on a fill that does not invert.
    expect(
      primary,
      "primary uses a theme-inverting ink token on a fixed amber fill — " +
        "in the Dark theme ink-900 is near-white, giving 1.87:1. Use a fixed " +
        "step such as accent-950.",
    ).not.toMatch(/text-ink-\d+/);

    const fg = primary!.match(/text-(accent|brand)-(\d+)/);
    expect(fg, "primary should carry a fixed accent/brand foreground").toBeTruthy();
    // accent-950 from tailwind.config.js.
    const FG: Record<string, Rgb> = { "accent-950": [60, 28, 4] };
    const fgRgb = FG[`${fg![1]}-${fg![2]}`];
    expect(fgRgb, `add ${fg![1]}-${fg![2]} to this test's literal table`).toBeTruthy();

    // One measurement covers all three themes precisely because neither
    // colour is theme-dependent — which is the property being enforced.
    expect(contrast(fgRgb, FIXED_FILLS["accent-400"])).toBeGreaterThanOrEqual(AA);
  });

  it("no source pairs an ink foreground with a fixed brand fill", () => {
    const offenders: string[] = [];
    for (const { name, source } of SOURCES) {
      source.split("\n").forEach((line, i) => {
        // Same class attribute containing both a fixed fill and an ink text
        // token — both UNPREFIXED, i.e. applied in the same state. A
        // variant-prefixed pair (`aria-pressed:bg-brand-700` with
        // `aria-pressed:text-white`) is its own self-consistent state and
        // cannot be judged by scanning one line, so those are skipped, as the
        // ink-400/ink-500 sweeps above also do.
        for (const m of line.matchAll(/class(?:Name)?="([^"]*)"/g)) {
          const cls = m[1];
          const fill = cls.match(/(?<![\w:-])bg-(?:accent|brand)-\d+/);
          const ink = cls.match(/(?<![\w:-])text-ink-\d+/);
          if (fill && ink) offenders.push(`${name}:${i + 1} — ${fill[0]} with ${ink[0]}`);
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
