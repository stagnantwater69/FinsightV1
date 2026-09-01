import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance } from "react-native";

import { palettes, resolveThemeMode, type Palette, type ThemeMode, type ThemePreference } from "../theme/palette";
import { DEFAULT_THEME, DEFAULT_THEME_PREFERENCE, readThemePreference, writeThemePreference } from "../lib/themeStore";

/**
 * The one place a colour is chosen.
 *
 * MOUNTED ABOVE EVERYTHING in App.tsx — above NavigationContainer, because the
 * navigator's own theme (header background, tab bar, card background) is built
 * from these values too, and above AuthProvider, because the login screen is
 * painted before anyone has signed in and must already be the right colour.
 *
 * A HOOK RATHER THAN A STYLESHEET REWRITE. Nearly every style in this app is
 * an inline object evaluated during render, so a context read is enough to
 * repaint the whole tree the moment the mode changes — there is no static
 * `StyleSheet.create` holding a stale colour. (`components/ui.tsx` had exactly
 * one such block; it now takes the palette as an argument.)
 *
 * THE COLD-START FLASH is handled by `ready`, not by guessing. SecureStore is
 * async, so the stored preference is not available on the first frame. App.tsx
 * folds `ready` into the same gate that already holds the native splash screen
 * for the fonts and the restored session — so on a cold start the app goes
 * splash → correctly-themed app, and nothing is painted in the wrong palette
 * in between. Rendering a default-Light tree first and correcting it a beat
 * later is precisely the flash this avoids.
 *
 * THREE CHOICES, TWO PALETTES. "Use device setting" is a PREFERENCE, not a
 * palette — there is no third set of colours. It is resolved against
 * `Appearance` here and nowhere else, so every consumer keeps receiving one of
 * the two real palettes and no component has to know the option exists. The
 * device's scheme is subscribed to rather than sampled once: a phone that goes
 * dark on a schedule has to repaint the running app, not the next launch.
 *
 * The NATIVE side of the same decision is `userInterfaceStyle: "automatic"` in
 * app.config.ts, which is what themes the keyboard and native alerts. The two
 * can legitimately disagree — an owner may pin Light on a dark phone — and
 * that is the owner's call, not a bug.
 */

export interface ThemeContextValue {
  /**
   * Which theme is in force — always a real palette, never "system".
   * Everything that paints reads this.
   */
  mode: ThemeMode;
  /**
   * What the owner CHOSE, which is what the Appearance control has to show
   * selected. With "Use device setting" picked this is `"system"` while `mode`
   * is whichever of the two the phone is currently doing, and a control bound
   * to `mode` would silently move its own selection to Light or Dark.
   */
  preference: ThemePreference;
  /** The resolved colours for that mode. */
  palette: Palette;
  /** Choose a theme. Applies immediately; persisted in the background. */
  setPreference: (preference: ThemePreference) => void;
  /**
   * The narrow setter, kept for callers that can only mean one of the two
   * palettes. `setPreference` is the general form.
   */
  setMode: (mode: ThemeMode) => void;
  /**
   * False until the stored preference has been read. App.tsx holds the splash
   * until this is true.
   */
  ready: boolean;
}

/**
 * What the phone is doing right now.
 *
 * `getColorScheme()` returns null when the platform has no opinion (and in
 * some simulators), which is not "dark" — falling back to the app's own
 * default keeps an unknown system scheme looking like an app nobody has
 * configured, rather than like a choice the owner did not make.
 */
function systemMode(): ThemeMode {
  return Appearance.getColorScheme() === "dark" ? "dark" : DEFAULT_THEME;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  /**
   * Skips the SecureStore read and pins the mode. For tests and for any future
   * preview surface that needs to render a specific theme — not used by the
   * app itself.
   */
  initialMode,
}: {
  children: ReactNode;
  initialMode?: ThemeMode;
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialMode ?? DEFAULT_THEME_PREFERENCE);
  const [ready, setReady] = useState(initialMode !== undefined);

  /**
   * The device's scheme, mirrored into state so a change repaints.
   *
   * `Appearance.getColorScheme()` is a read, not a subscription — without the
   * listener below, an owner on "Use device setting" whose phone switches to
   * Dark on a schedule would keep the Light app until the next cold start.
   * Tracked even when the preference is Light or Dark, because switching TO
   * "system" has to have an answer ready rather than a frame of the wrong one.
   */
  const [scheme, setScheme] = useState<ThemeMode>(systemMode);

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setScheme(colorScheme === "dark" ? "dark" : DEFAULT_THEME);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (initialMode !== undefined) return;
    let active = true;
    void readThemePreference().then((stored) => {
      if (!active) return;
      setPreferenceState(stored);
      setReady(true);
    });
    return () => {
      active = false;
    };
    // `initialMode` is a mount-time decision; changing it later is not a
    // supported use and re-running the read for it would fight the setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    // State first, write second, and the write is not awaited: the switch has
    // to feel instant, and a keystore that refuses the write is not a reason
    // to leave the owner staring at the theme they just turned off.
    setPreferenceState(next);
    void writeThemePreference(next);
  }, []);

  const setMode = useCallback((next: ThemeMode) => setPreference(next), [setPreference]);

  const mode = resolveThemeMode(preference, scheme);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, preference, palette: palettes[mode], setPreference, setMode, ready }),
    [mode, preference, setPreference, setMode, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The palette, for painting.
 *
 * Returns the resolved `Palette` directly rather than the context object,
 * because that is what nine call sites in ten want and
 * `const { ink, paper, brand } = useTheme()` then reads the same way the old
 * static imports did.
 *
 * Throws outside a provider on purpose. The alternative — falling back to
 * Light — is a component that renders in the wrong palette on a dark device
 * and gives no clue why.
 */
export function useTheme(): Palette {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside a ThemeProvider");
  return ctx.palette;
}

/** The mode and the setter — for the Appearance control, and App.tsx's gate. */
export function useThemeControl(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemeControl must be used inside a ThemeProvider");
  return ctx;
}
