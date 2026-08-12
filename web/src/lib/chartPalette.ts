// Validated categorical palette (dataviz skill reference instance) — fixed
// order, never cycled or reassigned per-render. Passes CVD/contrast checks
// as a set; slots 3/4/5 (aqua/yellow/magenta) fall below 3:1 against a
// white surface, so anywhere they're used needs a visible direct label,
// not color alone.
export const CATEGORICAL_PALETTE = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
];

// ============================================================
// The dark-surface categorical palette
// ============================================================
// SELECTED, not flipped. A palette validated against white is not valid
// against a near-black card: measured on the dark theme's #151d1e surface,
// four of the eight slots above fall outside the OKLCH lightness band that
// keeps marks distinguishable there — yellow, orange and magenta sit too
// light, violet too dark.
//
// So those four are re-stepped: same hue angle, same chroma, lightness moved
// into the dark band. The other four measured inside the band already and are
// byte-identical, which is what keeps a category recognisably "the blue one"
// across a theme switch.
//
// Both palettes are verified with the dataviz validator against their own
// surface — lightness band, chroma floor, CVD separation, normal-vision floor
// and contrast. Each carries one sub-3:1 contrast WARN, which is relieved the
// way the validator requires: every chart using them ships direct labels and a
// table view, so nothing is ever identified by colour alone.
//
//   slot        light      dark       what moved
//   1 blue      #2a78d6    #2a78d6    unchanged
//   2 orange    #eb6834    #e5632e    L 0.671 -> 0.654
//   3 aqua      #1baf7a    #1baf7a    unchanged
//   4 yellow    #eda100    #c38400    L 0.764 -> 0.661
//   5 magenta   #e87ba4    #d36891    L 0.716 -> 0.655
//   6 green     #008300    #008300    unchanged
//   7 violet    #4a3aa7    #6055c4    L 0.433 -> 0.520
//   8 red       #e34948    #e34948    unchanged
export const CATEGORICAL_PALETTE_DARK = [
  "#2a78d6", // 1 blue
  "#e5632e", // 2 orange
  "#1baf7a", // 3 aqua
  "#c38400", // 4 yellow
  "#d36891", // 5 magenta
  "#008300", // 6 green
  "#6055c4", // 7 violet
  "#e34948", // 8 red
];

/** The neutral used for a folded "Other" slice. Outside the palette on
 *  purpose, so it never reads as just another category. Mid-grey, so it holds
 *  up on both surfaces. */
export const OTHER_COLOR = "#8b9a9e";

// Fill colors — bars, meters, pill backgrounds. Tuned to read as a set
// against a white surface, not to carry text.
export const STATUS_COLORS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

// Darkened variants for two jobs the fills above can't do:
//   1. Status carried by small text on a white surface.
//   2. Solid pill/badge backgrounds with white text on them.
//
// The fills are too light for either. Measured against #ffffff they come
// out at good 3.35, warning 1.83, serious 2.64 — only critical clears 4.5,
// at 4.80. These steps all clear 5:1 against white in both directions
// (good 5.32, warning 5.93, serious 5.96, critical 5.69), so white ink on
// them is safe too.
//
// Status is never carried by color alone anywhere these are used — each
// site pairs them with an icon and a written label.
//
// The complete set of surfaces that paint one of these as a SOLID with white
// ink, so the "is this measured?" question has one answer:
//
//   Alert.tsx        the severity bar, the glyph disc, and AlertBadge
//   RecoveryMeter    the month-coverage solid
//   RecoveryInsight  the per-day status pill
//
// Spending Impact's impact-band chip used to be a fourth. It painted
// STATUS_TEXT_COLORS through an inline style with white text on it, which was
// measured, but it was also the only status chip in the app that did not go
// through the themed tint/tone/edge tokens — so it kept a white-on-saturated
// look on a dark card where every neighbouring chip had inverted. It now uses
// <Pill>, whose tones clear 4.5:1 on their own tints in all three themes by
// construction (see index.css). Nothing needs re-measuring here; the surface
// that needed it stopped being a solid.
export const STATUS_TEXT_COLORS = {
  good: "#0a7d0a",
  warning: "#8a5a00",
  serious: "#a8442a",
  critical: "#c02f2f",
};

// ============================================================
// STATUS_INK — the same four statuses, as TEXT, in any theme
// ============================================================
// STATUS_TEXT_COLORS above does two jobs at once: small text on white, and
// solid badge fills carrying white ink. Those two requirements point in
// opposite directions as soon as the surface goes dark — a colour dark enough
// to read on white is invisible on a near-black card, and a colour light
// enough to read there cannot carry white text.
//
// So they are split. STATUS_TEXT_COLORS keeps the SOLID job (badge and disc
// fills with white on them), unchanged and theme-independent. STATUS_INK is
// the TEXT job, resolved per theme through the same --sev-* variables the
// Alert family uses — so a "behind pace" label and a "needs review" alert are
// the same red in the same theme.
//
// These are `rgb(var(...))` strings, so they only work where CSS is
// evaluated: a `style` prop, or a CSS property. They will NOT work as a bare
// SVG presentation attribute — use `currentColor` there instead.
export const STATUS_INK = {
  good: "rgb(var(--sev-good-ink))",
  warning: "rgb(var(--sev-warning-ink))",
  serious: "rgb(var(--sev-serious-ink))",
  critical: "rgb(var(--sev-critical-ink))",
};

// ============================================================
// The amber accent — measured contrast, and the rule it forces
// ============================================================
//
// Amber is an intrinsically light hue, and that has a consequence worth
// stating rather than discovering later. Measured against white:
//
//   accent-400 #f5a524   2.04    accent-600 #b96c06   4.03
//   accent-500 #e08c0b   2.65    accent-700 #94520b   6.05
//
// So WHITE TEXT ON AMBER DOES NOT PASS until accent-700 — by which point the
// colour reads brown and stops feeling like a warm gold at all. Dark ink on
// amber, however, is excellent: ink-900 on accent-400 is 8.08.
//
// Hence the rule: a primary CTA is an amber fill with DARK ink on it, never
// white ink. This is the honest consequence of choosing amber as the accent,
// not a styling preference.
export const ACCENT = {
  /** Button/meter fill. Pair only with ACCENT.onFill. 8.08 with ink-900. */
  fill: "#f5a524",
  /** Hover/active state for a filled CTA. 6.22 with ink-900. */
  fillStrong: "#e08c0b",
  /** Ink to place ON an amber fill. Never white. */
  onFill: "#1a2022",
  /** Amber as small text on a white surface. 6.05. */
  text: "#94520b",
  /** Tinted surface for amber-accented panels. */
  surface: "#fff9ed",
};
