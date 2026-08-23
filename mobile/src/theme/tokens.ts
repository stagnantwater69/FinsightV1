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
 *
 * WHAT IS AND IS NOT IN HERE
 * --------------------------
 * Only the tokens a theme has no opinion about: the type scale, the font
 * families, radius, space and the tap target. A card is 16pt round and a
 * caption is 12pt in Light and in Dark alike.
 *
 * COLOUR MOVED to theme/palette.ts, behind a resolved palette that
 * `context/ThemeContext.tsx` hands out through `useTheme()`. It is not
 * re-exported from here, so an unmigrated `import { ink } from
 * "../theme/tokens"` is a typecheck failure rather than a component that
 * quietly stays light on a dark device.
 */

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
