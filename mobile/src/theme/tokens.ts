/**
 * Design tokens, mirrored from the web app.
 *
 * Deliberately a hand-kept mirror of web/tailwind.config.js and
 * web/src/lib/chartPalette.ts rather than a shared package: the two apps have
 * no build-time relationship, and introducing a workspace just to share ~80
 * lines of constants would couple their release cycles for very little.
 *
 * The tradeoff is that these must be updated in both places. Anything that can
 * drift silently and matters is called out where it appears.
 */

export const brand = {
  50: "#effcf9",
  100: "#c8f7ec",
  200: "#92eeda",
  300: "#5adcc4",
  400: "#2ec2ac",
  500: "#149e8d",
  600: "#0d7f72",
  700: "#0e655c",
  800: "#0f504b",
  900: "#0f423f",
  950: "#052624",
} as const;

/**
 * The amber accent. Same two-places-only rule as web:
 *   1. the Recovery Meter's adjusted daily target
 *   2. primary calls to action
 * Never status or progress elements — amber-as-warning is a different idea and
 * lives in `status` below.
 */
export const accent = {
  50: "#fff9ed",
  100: "#fdedcc",
  200: "#fbd894",
  300: "#f8bd55",
  400: "#f5a524",
  500: "#e08c0b",
  600: "#b96c06",
  700: "#94520b",
  800: "#7a4210",
  900: "#683810",
} as const;

/**
 * Measured on web: white text on amber fails contrast until accent-700 (which
 * reads brown). Dark ink on accent-400 is 8.08:1. So a primary CTA is an amber
 * fill with DARK ink, never white ink — the same rule, carried over.
 */
export const ACCENT = {
  fill: accent[400],
  fillStrong: accent[500],
  onFill: "#1a2022",
  text: accent[700],
  surface: accent[50],
} as const;

export const ink = {
  50: "#f6f8f8",
  100: "#eceff0",
  200: "#d5dbdd",
  300: "#b0bbbe",
  400: "#7f8f94", // decorative / placeholder only — 3.36:1, not for body text
  500: "#5d6d72",
  600: "#4a585c",
  700: "#3d4749",
  800: "#2c3436",
  900: "#1a2022",
} as const;

export const paper = {
  DEFAULT: "#ffffff",
  50: "#fbfdfc",
  100: "#f4f8f7",
  200: "#e8efed",
} as const;

/** Fills for bars and meters. Not safe to put text on — see statusText. */
export const status = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

/** Darkened steps: safe as small text, and safe under white text on a badge. */
export const statusText = {
  good: "#0a7d0a",
  warning: "#8a5a00",
  serious: "#a8442a",
  critical: "#c02f2f",
} as const;

/** Validated categorical palette — fixed order, never cycled or reassigned. */
export const categorical = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
] as const;

/**
 * The text colour to put ON each categorical fill, index-paired with
 * `categorical` — needed wherever a label sits inside a coloured bar or
 * slice rather than beside it on the page background.
 *
 * NOT a single fixed choice. `ink[900]` reads fine on six of these hues but
 * fails outright on the dark green and the purple (1.9:1 and 3.3:1); white
 * reads fine on those two but fails on the other six. Each entry here is
 * WCAG's better of {white, ink[900]} against that specific fill, computed
 * from the actual hex values, not eyeballed.
 *
 * Even the better choice does not clear 4.5:1 everywhere — blue lands at
 * 4.42:1 and red at 4.17:1, both just under normal-text AA. Both clear
 * large-text AA (3:1) with room to spare, which is the honest bar for a
 * short, bold numeral rather than body copy. This does not relax the "text
 * wears ink tokens, never the series colour" rule above — ordinary chart
 * labels still must not use this. It exists only for text placed directly on
 * top of a fill, where the alternative is no label at all.
 */
export const categoricalOnColor = [
  "#ffffff",
  ink[900],
  ink[900],
  ink[900],
  ink[900],
  "#ffffff",
  "#ffffff",
  ink[900],
] as const;

/**
 * Font families. Same three typefaces as web (Inter / Sora / IBM Plex Mono),
 * but delivered via @expo-google-fonts rather than @fontsource.
 *
 * DEVIATION, flagged: @fontsource ships only .woff/.woff2 and expo-font needs
 * .ttf/.otf, so the web font FILES cannot be reused directly. Same typefaces,
 * different packages — visually identical, different delivery mechanism. Both
 * Sora packages carry the same upstream (sora-xor/sora-font, OFL), so this is
 * the same face web renders, not a lookalike.
 *
 * `display` was IBM Plex Sans until web replaced it with Sora and mobile did
 * not follow; this closes that gap. Sora is only ever used at 18 and above —
 * see TEXT_VARIANTS in components/ui.tsx for why.
 */
export const font = {
  sans: "Inter_400Regular",
  sansMedium: "Inter_500Medium",
  sansSemibold: "Inter_600SemiBold",
  display: "Sora_600SemiBold",
  displayBold: "Sora_700Bold",
  mono: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
  monoSemibold: "IBMPlexMono_600SemiBold",
} as const;

/**
 * Type sizes. `radius` and `space` have been tokens for a long time; type size
 * was the one dimension still written as a bare number everywhere, which is how
 * the app drifted to sixteen distinct sizes including 10.5, 11.5, 12.5 and 13.5.
 *
 * These names are roles, not a geometric ramp — they were read off what the app
 * already does rather than invented. `bodySm` is the most-used size in the whole
 * codebase (33 sites): the supporting copy under a heading, one step below
 * `body`. It had no variant, which is exactly why it was always a raw 14.
 *
 * NOT in here, deliberately:
 *   - Glyph sizes (the 20 and 22 on `×` close controls, 9 on a page badge).
 *     Those size an icon, not text, and borrowing a type name for them would
 *     make the scale mean two things.
 *   - The receipt-camera overlay's fractional sizes. That text sits on live
 *     video and was tuned as a set; snapping it to this scale would trade
 *     legibility where it matters most for tidiness.
 * Both are flagged by scripts/check-type-tokens.mjs rather than silently
 * allowed — see the allowlist there.
 */
export const typeScale = {
  axis: 10, // chart axes only; below the floor for anything a user must read
  micro: 11, // badges, pills, dense chrome
  caption: 12,
  label: 13,
  bodySm: 14,
  body: 15,
  bodyLg: 16,
  title: 18,
  titleLg: 26,
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, full: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;

/**
 * Minimum touch target. React Native's hit handling is more forgiving than the
 * web's, but the guidance is the same and `hitSlop` is used where a control is
 * visually smaller than this.
 */
export const TAP = 44;
