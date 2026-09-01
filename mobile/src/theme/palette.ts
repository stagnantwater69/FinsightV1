/**
 * The two palettes — Light and Dark — and the semantic names every screen
 * paints with.
 *
 * ===================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM tokens.ts
 * ===================================================================
 * `tokens.ts` still holds everything that does NOT change with a theme: the
 * type scale, the font families, radius, space and the tap target. Those are
 * geometry and typography, and a theme switch has no opinion about them.
 *
 * Colour is the part that does change, so it moved here — behind a resolved
 * `Palette` object rather than as static exports. Nothing outside this file
 * imports a colour constant any more; screens read the resolved palette from
 * `useTheme()`. That is enforced structurally: the colour names that used to
 * live in `tokens.ts` are gone from it, so an unmigrated import is a
 * typecheck failure rather than a component that silently stays light.
 *
 * ===================================================================
 * TWO LAYERS, ON PURPOSE
 * ===================================================================
 * 1. SEMANTIC NAMES — `surface`, `textPrimary`, `border`, `brandFill`,
 *    `statusSurface.warning`, `scrim`, `cameraSurface`. These say what a
 *    colour MEANS. They are the names to reach for in new code, and they are
 *    the only honest answer wherever a ramp step means two different things
 *    at once (see "the split roles" below).
 *
 * 2. THEME-RESOLVED RAMPS — `ink`, `paper`, `brand`, `accent`, `status`.
 *    Same shape and same step numbers as before, but their VALUES move with
 *    the theme, exactly the way web's `--ink-*` / `--paper-*` custom
 *    properties do (see web/src/index.css, which this mirrors step for step).
 *    In Dark the `ink` ramp INVERTS: `ink[900]` is the near-white headings
 *    step and `ink[50]` is nearly black. That is what lets a component say
 *    `ink[900]` once and be correct in both themes.
 *
 * Keeping the ramps is a deliberate choice rather than a shortcut. Web —
 * the sister client, built by the same team against the same design system —
 * solved dark mode this way and documents the inverting ink scale as "the
 * whole reason a component can say text-ink-900 once and be correct in every
 * theme". Mobile deviating from that would mean the two apps no longer
 * describe the same colour with the same word, which is the drift every
 * comment in tokens.ts is written to prevent.
 *
 * ===================================================================
 * THE SPLIT ROLES — where a ramp step genuinely could not be re-pointed
 * ===================================================================
 * Four cases where one light-mode value was doing two jobs that pull in
 * opposite directions the moment the surface goes dark. Each is now two
 * names:
 *
 *   brand[600]  was both "the interactive teal" (text, icons, focus rings)
 *               and "the filled-control background under white text". In Dark
 *               the first must lighten and the second must not. Split into
 *               the ramp step (lightens) and `brandFill` (fixed).
 *
 *   brand[700]/[800]  was both "brand text on a light surface" and "the
 *               fixed dark-teal chrome plane" — the raised + button, the Ask
 *               FinSight header, the avatar disc. Split into the ramp step
 *               (lightens) and `brandSolid`/`brandSolidPressed` (fixed, the
 *               same argument web's sidebar makes for staying dark teal in
 *               every theme).
 *
 *   statusText  was both "status as small text" and "a solid badge fill with
 *               white ink on it". A colour dark enough to read on white is
 *               invisible on a near-black card, and one light enough to read
 *               there cannot carry white text. Split into `statusText` (the
 *               text job, theme-resolved) and `statusSolid` (the fill job,
 *               fixed) — the same split web made in chartPalette.ts.
 *
 *   ink[900]    was both "the darkest text" and "the camera viewfinder's
 *               background". Inverting it would turn the viewfinder white.
 *               The viewfinder is `cameraSurface`, fixed in both themes,
 *               because it is a lens, not a page.
 *
 * ===================================================================
 * CONTRAST
 * ===================================================================
 * In both palettes: `ink[500]` and darker/lighter clear 4.5:1 on `paper`,
 * every `statusText` clears 4.5:1 on its own `statusSurface`, and every
 * `*Fill`/`*Solid` clears 4.5:1 against the ink named as its `on*` partner.
 * `ink[400]` is the muted step in both and is decorative/placeholder only.
 * `tests/theme.test.ts` pins the light values to the constants that shipped
 * before this file existed, so Light is provably unchanged.
 */

export type ThemeMode = "light" | "dark";

/**
 * What the OWNER chose, which is not the same thing as what is PAINTED.
 *
 * `ThemeMode` is a resolved answer — there is a Light palette and a Dark one
 * and nothing else, so every component that reads a colour keeps taking a
 * `ThemeMode`. `ThemePreference` adds the one thing a person can pick that is
 * not a palette: "whatever this phone is doing". That resolves to a
 * `ThemeMode` at read time (see context/ThemeContext.tsx) and re-resolves when
 * the phone changes its mind at sunset.
 *
 * KEPT AS TWO TYPES rather than widening `ThemeMode` to three values: widening
 * it would put `"system"` into `palettes[...]`, which has no entry for it, and
 * into every component that switches on the mode. The split is what makes
 * "there is no system palette" a typecheck failure instead of a runtime hole.
 */
export type ThemePreference = ThemeMode | "system";

/**
 * The preference, against what the device is currently doing, as the palette
 * to paint.
 *
 * LIVES HERE rather than in context/ThemeContext.tsx — which is where it is
 * used — because that file imports React Native's `Appearance`, and the test
 * runner has no React Native. This module is plain data, so the one branch
 * worth pinning ("system" defers, an explicit choice does not) can be pinned.
 */
export function resolveThemeMode(preference: ThemePreference, deviceScheme: ThemeMode): ThemeMode {
  return preference === "system" ? deviceScheme : preference;
}

export type StatusKey = "good" | "warning" | "serious" | "critical";
export type StatusFamily = Record<StatusKey, string>;

type InkStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
type BrandStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;
type AccentStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export type InkRamp = Record<InkStep, string>;
export type PaperRamp = { DEFAULT: string; 50: string; 100: string; 200: string };
export type BrandRamp = Record<BrandStep, string>;
export type AccentRamp = Record<AccentStep, string>;

export interface Palette {
  mode: ThemeMode;

  // ---------------------------------------------------------------- ramps
  ink: InkRamp;
  paper: PaperRamp;
  brand: BrandRamp;
  accent: AccentRamp;

  /**
   * The amber accent's fixed roles. Same two-places-only rule as web:
   *   1. the Recovery Meter's adjusted daily target
   *   2. primary calls to action
   * Never status or progress elements — amber-as-warning is a different idea
   * and lives in `status`/`statusText`.
   *
   * Measured on web: white text on amber fails contrast until accent-700
   * (which reads brown). Dark ink on accent-400 is 8.08:1. So a primary CTA
   * is an amber fill with DARK ink, never white ink — in BOTH themes. That is
   * why `fill`, `fillStrong` and `onFill` do not move; only `text` and
   * `surface`, which are the two that sit against the page, do.
   */
  ACCENT: { fill: string; fillStrong: string; onFill: string; text: string; surface: string };

  // ---------------------------------------------------------------- surfaces
  /** A card, a sheet, an input — the reading plane content sits on. */
  surface: string;
  /** Above the card plane: bottom sheets and menus that overlay the page. */
  surfaceRaised: string;
  /** The page behind the cards. */
  surfaceSunken: string;
  /** A subtle neutral fill — segmented-control track, pressed row. */
  surfaceMuted: string;
  /** A stronger neutral fill — dividers, grabbers, inactive tracks. */
  surfaceStrong: string;

  // ---------------------------------------------------------------- text
  /** Headings and figures. */
  textPrimary: string;
  /** Body copy. */
  textSecondary: string;
  /** Captions, labels, secondary detail. */
  textMuted: string;
  /** Decorative or duplicated text and placeholders only — below 4.5:1. */
  textFaint: string;
  /** Text/icons placed ON a saturated fill. White in both themes. */
  textOnFill: string;

  // ---------------------------------------------------------------- edges
  /** The hairline that separates a card from the page. */
  border: string;
  /** A border meant to be seen — inputs, outlined controls. */
  borderStrong: string;

  // ---------------------------------------------------------------- brand
  /** Brand-tinted wash behind an informational panel. */
  brandSurface: string;
  /** The hairline on that wash. */
  brandBorder: string;
  /** Brand colour as text or an icon on `surface`. */
  brandText: string;
  /** A heading carrying the brand's teal cast. */
  brandHeading: string;
  /** A filled interactive control — chip, checkbox, primary brand button. */
  brandFill: string;
  brandFillPressed: string;
  onBrandFill: string;
  /**
   * The fixed dark-teal chrome plane: the raised + button, the Ask FinSight
   * header, the profile disc. Dark teal in BOTH themes, for the reason web's
   * sidebar stays dark teal in Classic and Dark — a brand surface that
   * changes colour with a theme toggle stops reading as the brand.
   */
  brandSolid: string;
  brandSolidPressed: string;
  onBrandSolid: string;
  /** Secondary text on `brandSolid` — web's `--sidebar-muted`. Fixed. */
  onBrandSolidMuted: string;

  // ---------------------------------------------------------------- status
  /** Saturated fills for bars and meters. Not safe to put text on. */
  status: StatusFamily;
  /** Status as TEXT on `surface`. Resolves per theme. */
  statusText: StatusFamily;
  /** Status as a SOLID under white ink — badge, disc, severity bar. Fixed. */
  statusSolid: StatusFamily;
  /** The wash behind a status panel. */
  statusSurface: StatusFamily;
  /** The hairline on that wash. */
  statusBorder: StatusFamily;

  // ---------------------------------------------------------------- charts
  categorical: readonly string[];
  categoricalOnColor: readonly string[];
  /** The neutral for a folded "Other" slice — never just another category. */
  chartOther: string;

  // ---------------------------------------------------------------- chrome
  /** Behind a modal or sheet. */
  scrim: string;
  /** Behind something that must dominate — the radial menu, the tour. */
  scrimStrong: string;
  /** The camera viewfinder's own plane. A lens, not a page: fixed. */
  cameraSurface: string;
  /** Text and icons on the viewfinder. */
  onCamera: string;

  /**
   * The plate a mascot illustration is framed on. FIXED in both themes, for
   * the same reason `cameraSurface` is: it is not a page, it is a property of
   * the artwork. The mascot PNGs are opaque with a near-white background baked
   * in, so the frame has to be that colour or there is a seam — a themed value
   * here would be a dark plate around a white picture. See
   * components/MascotState.tsx, which is the only thing that reads it, and
   * which explains what replacing the art would let us delete.
   */
  mascotPlate: string;

  /**
   * Card/button shadow. Near-black tinted toward the ink in Light; pure black
   * and much heavier in Dark, where a 4%-opacity shadow is simply invisible.
   * Call sites multiply their own opacity by `shadowStrength`.
   */
  shadow: string;
  shadowStrength: number;

  /** What `expo-status-bar` should draw — dark glyphs on Light, light on Dark. */
  statusBarStyle: "dark" | "light";
}

/* ==================================================================
   LIGHT
   ==================================================================
   Every value below is the constant that shipped in tokens.ts before this
   file existed. Light is a refactor, not a redesign.
   ------------------------------------------------------------------ */

const LIGHT_INK: InkRamp = {
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
};

const LIGHT_PAPER: PaperRamp = {
  DEFAULT: "#ffffff",
  50: "#fbfdfc",
  100: "#f4f8f7",
  200: "#e8efed",
};

const LIGHT_BRAND: BrandRamp = {
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
};

const LIGHT_ACCENT: AccentRamp = {
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
};

/* ==================================================================
   DARK
   ==================================================================
   Mirrored from web's [data-theme="dark"] block in web/src/index.css, so the
   same account looks like the same product on a laptop and on a phone.

   Surfaces are LIFTED rather than pure black: #0e1415 page, #151d1e cards.
   Pure black plus a bright card is a harsher edge than the OLED saving is
   worth, and the near-black keeps the shadow from disappearing entirely.
   ------------------------------------------------------------------ */

const DARK_INK: InkRamp = {
  50: "#0e1415",
  100: "#1d2729",
  200: "#2b3739",
  300: "#46585b",
  400: "#7c9095", // decorative / placeholder only, same as Light's 400
  500: "#9cafb3",
  600: "#b6c5c8",
  700: "#ccd8da",
  800: "#e2eaeb",
  900: "#f1f6f6",
};

const DARK_PAPER: PaperRamp = {
  DEFAULT: "#151d1e",
  50: "#0e1415",
  100: "#1d2729",
  200: "#2b3739",
};

/**
 * The brand ramp in Dark.
 *
 * NOT a straight inversion. The teal's identity steps — 400/500/600, the ones
 * used as fills and as brand-on-dark accents — either stay put or move by one
 * step, because those are the colour people recognise as FinSight. What
 * inverts is the two ENDS: the washes (50–200), which have to become deep
 * teals to sit under light text, and the text steps (700–950), which have to
 * become light teals to sit on a dark card.
 *
 * 400 is unchanged at #2ec2ac and that is not an accident: it was already the
 * app's "brand on a dark surface" step — the receipt camera's guide, the crop
 * handles, the tour spotlight all use it against black today.
 */
const DARK_BRAND: BrandRamp = {
  50: "#0f2f2b", // wash (web's --tint-brand)
  100: "#1b4a44", // wash edge (web's --edge-brand)
  200: "#22625a", // stronger edge / inactive track
  300: "#2a7a70",
  400: "#2ec2ac", // unchanged — already the on-dark step
  500: "#2ec2ac", // progress fills, gradients
  600: "#2ec2ac", // interactive text/icons/focus. 7.3:1 on #151d1e
  700: "#5adcc4", // brand text (web's --tone-brand). 10.6:1 on #151d1e
  800: "#92eeda",
  900: "#d7f5ee", // headings with a teal cast — Light's #0f423f, inverted
  950: "#effcf9",
};

const DARK_ACCENT: AccentRamp = {
  50: "#33260c", // web's --tint-accent
  100: "#59431a", // web's --edge-accent
  200: "#7a5a1e",
  300: "#f8bd55",
  400: "#f5a524", // the CTA fill does not move — see ACCENT below
  500: "#e08c0b",
  600: "#f5a524",
  700: "#f8bd55", // web's --tone-accent
  800: "#fbd894",
  900: "#fdedcc",
};

/* ------------------------------------------------------------------
   Theme-independent colour
   ------------------------------------------------------------------ */

/** Fills for bars and meters. Same hue in both themes — the mapping is learned. */
const STATUS: StatusFamily = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

/**
 * Darkened steps, kept for the SOLID job only: a severity bar, a glyph disc,
 * a badge — anything painted as a block with white ink on it. All four clear
 * 4.5:1 against white, so they are safe under white text on either surface,
 * and they stay put so a flagged row is recognisably the same flag in both
 * themes.
 */
const STATUS_SOLID: StatusFamily = {
  good: "#0a7d0a",
  warning: "#8a5a00",
  serious: "#a8442a",
  critical: "#c02f2f",
};

/** Validated categorical palette — fixed order, never cycled or reassigned. */
const CATEGORICAL_LIGHT = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
] as const;

/**
 * SELECTED, not flipped — mirrored from web's CATEGORICAL_PALETTE_DARK.
 *
 * A palette validated against white is not valid against a near-black card:
 * measured on #151d1e, four of the eight slots fall outside the lightness
 * band that keeps marks distinguishable there — yellow, orange and magenta
 * sit too light, violet too dark. Those four are re-stepped at the same hue
 * angle and chroma. The other four are byte-identical, which is what keeps a
 * category recognisably "the blue one" across a theme switch.
 */
const CATEGORICAL_DARK = [
  "#2a78d6", // 1 blue     unchanged
  "#e5632e", // 2 orange   L 0.671 -> 0.654
  "#1baf7a", // 3 aqua     unchanged
  "#c38400", // 4 yellow   L 0.764 -> 0.661
  "#d36891", // 5 magenta  L 0.716 -> 0.655
  "#008300", // 6 green    unchanged
  "#6055c4", // 7 violet   L 0.433 -> 0.520
  "#e34948", // 8 red      unchanged
] as const;

/**
 * The text colour to put ON each categorical fill, index-paired with the
 * palette above — needed wherever a label sits inside a coloured bar or slice
 * rather than beside it on the page background.
 *
 * NOT a single fixed choice, and NOT theme-resolved either: the fill is the
 * same colour whatever the page behind it is doing, so the ink on it is too.
 * Each entry is WCAG's better of {white, #1a2022} against that specific fill,
 * computed from the actual hex values. Both palettes work out to the same
 * pattern, which is a property of the hues rather than a coincidence.
 *
 * Even the better choice does not clear 4.5:1 everywhere — light's blue lands
 * at 4.42:1 and red at 4.17:1, both just under normal-text AA. Both clear
 * large-text AA (3:1) with room to spare, which is the honest bar for a
 * short, bold numeral rather than body copy. This does not relax the "text
 * wears ink tokens, never the series colour" rule — ordinary chart labels
 * still must not use this. It exists only for text placed directly on top of
 * a fill, where the alternative is no label at all.
 */
const CATEGORICAL_ON_COLOR = [
  "#ffffff",
  "#1a2022",
  "#1a2022",
  "#1a2022",
  "#1a2022",
  "#ffffff",
  "#ffffff",
  "#1a2022",
] as const;

/** Mid-grey, so it holds up on both surfaces. */
const CHART_OTHER = "#8b9a9e";

/** The viewfinder's plane. Light's ink[900] — a lens is not a page. */
const CAMERA_SURFACE = "#1a2022";

/**
 * The mascot plate. Measured off the artwork itself, not chosen: all four
 * corners of all 33 pose PNGs in assets/mascot/ sit at 252–255 on every
 * channel. See `mascotPlate` in the Palette interface for why it is fixed.
 */
const MASCOT_PLATE = "#fdfdfd";

export const lightPalette: Palette = {
  mode: "light",

  ink: LIGHT_INK,
  paper: LIGHT_PAPER,
  brand: LIGHT_BRAND,
  accent: LIGHT_ACCENT,
  ACCENT: {
    fill: LIGHT_ACCENT[400],
    fillStrong: LIGHT_ACCENT[500],
    onFill: "#1a2022",
    text: LIGHT_ACCENT[700],
    surface: LIGHT_ACCENT[50],
  },

  surface: LIGHT_PAPER.DEFAULT,
  surfaceRaised: LIGHT_PAPER.DEFAULT,
  surfaceSunken: LIGHT_PAPER[50],
  surfaceMuted: LIGHT_PAPER[100],
  surfaceStrong: LIGHT_PAPER[200],

  textPrimary: LIGHT_INK[900],
  textSecondary: LIGHT_INK[700],
  textMuted: LIGHT_INK[500],
  textFaint: LIGHT_INK[400],
  textOnFill: "#ffffff",

  border: LIGHT_PAPER[200],
  borderStrong: LIGHT_INK[200],

  brandSurface: LIGHT_BRAND[50],
  brandBorder: LIGHT_BRAND[100],
  brandText: LIGHT_BRAND[700],
  brandHeading: LIGHT_BRAND[900],
  brandFill: LIGHT_BRAND[600],
  brandFillPressed: LIGHT_BRAND[800],
  onBrandFill: "#ffffff",
  brandSolid: LIGHT_BRAND[700],
  brandSolidPressed: LIGHT_BRAND[800],
  onBrandSolid: "#ffffff",
  onBrandSolidMuted: LIGHT_BRAND[100],

  status: STATUS,
  statusText: STATUS_SOLID,
  statusSolid: STATUS_SOLID,
  statusSurface: {
    good: "#eafaf1",
    warning: "#fffbeb",
    serious: "#fdf0ea",
    critical: "#fdecec",
  },
  statusBorder: {
    good: "#c8ecd8",
    warning: "#f2dda6",
    serious: "#f8d6c4",
    critical: "#f7cccc",
  },

  categorical: CATEGORICAL_LIGHT,
  categoricalOnColor: CATEGORICAL_ON_COLOR,
  chartOther: CHART_OTHER,

  scrim: "rgba(26,32,34,0.45)",
  scrimStrong: "rgba(26,32,34,0.55)",
  cameraSurface: CAMERA_SURFACE,
  onCamera: "#ffffff",
  mascotPlate: MASCOT_PLATE,

  shadow: LIGHT_INK[900],
  shadowStrength: 1,

  statusBarStyle: "dark",
};

export const darkPalette: Palette = {
  mode: "dark",

  ink: DARK_INK,
  paper: DARK_PAPER,
  brand: DARK_BRAND,
  accent: DARK_ACCENT,
  ACCENT: {
    // The CTA rule survives the theme: amber fill, dark ink, never white.
    fill: LIGHT_ACCENT[400],
    fillStrong: LIGHT_ACCENT[500],
    onFill: "#1a2022",
    text: DARK_ACCENT[700],
    surface: DARK_ACCENT[50],
  },

  surface: DARK_PAPER.DEFAULT,
  // A sheet sits above the page, so it lifts one step rather than matching
  // the cards it covers — the same job the shadow does in Light, done with
  // lightness instead, because a shadow on a near-black page reads as nothing.
  surfaceRaised: "#1d2729",
  surfaceSunken: DARK_PAPER[50],
  surfaceMuted: DARK_PAPER[100],
  surfaceStrong: DARK_PAPER[200],

  textPrimary: DARK_INK[900],
  textSecondary: DARK_INK[700],
  textMuted: DARK_INK[500],
  textFaint: DARK_INK[400],
  textOnFill: "#ffffff",

  border: DARK_PAPER[200],
  borderStrong: DARK_INK[300],

  brandSurface: DARK_BRAND[50],
  brandBorder: DARK_BRAND[100],
  brandText: DARK_BRAND[700],
  brandHeading: DARK_BRAND[900],
  // Fixed: white ink on #0d7f72 is 4.9:1, and the lighter ramp steps cannot
  // carry white text at all.
  brandFill: LIGHT_BRAND[600],
  brandFillPressed: LIGHT_BRAND[700],
  onBrandFill: "#ffffff",
  brandSolid: LIGHT_BRAND[700],
  brandSolidPressed: LIGHT_BRAND[800],
  onBrandSolid: "#ffffff",
  onBrandSolidMuted: LIGHT_BRAND[100],

  status: STATUS,
  /**
   * The four severities keep their hue — red is critical, orange is serious,
   * amber is a warning, green is good — because that mapping is learned and
   * rotating it in one theme would mean relearning it. What changes is which
   * end of the scale carries the text job. Mirrored from web's --sev-*-ink.
   */
  statusText: {
    good: "#6edb6e",
    warning: "#f0c55a",
    serious: "#f6a88c",
    critical: "#f89191",
  },
  statusSolid: STATUS_SOLID,
  statusSurface: {
    good: "#12331b",
    warning: "#33280c",
    serious: "#371e14",
    critical: "#3a1616",
  },
  statusBorder: {
    good: "#24512f",
    warning: "#544114",
    serious: "#583222",
    critical: "#5c2626",
  },

  categorical: CATEGORICAL_DARK,
  categoricalOnColor: CATEGORICAL_ON_COLOR,
  chartOther: CHART_OTHER,

  // Pure black rather than the ink tint: the page is already near-black, so a
  // tinted scrim over it would barely register as a scrim at all.
  scrim: "rgba(0,0,0,0.62)",
  scrimStrong: "rgba(0,0,0,0.72)",
  cameraSurface: CAMERA_SURFACE,
  onCamera: "#ffffff",
  mascotPlate: MASCOT_PLATE,

  // A tinted shadow at 4% is invisible on a near-black page, so depth here
  // comes from pure black at roughly three times the opacity, plus the border
  // every card already carries.
  shadow: "#000000",
  shadowStrength: 3,

  statusBarStyle: "light",
};

export const palettes: Record<ThemeMode, Palette> = {
  light: lightPalette,
  dark: darkPalette,
};
