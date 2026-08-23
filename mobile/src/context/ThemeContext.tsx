import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { palettes, type Palette, type ThemeMode } from "../theme/palette";
import { DEFAULT_THEME, readThemeMode, writeThemeMode } from "../lib/themeStore";

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
 */

export interface ThemeContextValue {
  /** Which theme is in force. */
  mode: ThemeMode;
  /** The resolved colours for that mode. */
  palette: Palette;
  /** Choose a theme. Applies immediately; persisted in the background. */
  setMode: (mode: ThemeMode) => void;
  /**
   * False until the stored preference has been read. App.tsx holds the splash
   * until this is true.
   */
  ready: boolean;
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
  const [mode, setModeState] = useState<ThemeMode>(initialMode ?? DEFAULT_THEME);
  const [ready, setReady] = useState(initialMode !== undefined);

  useEffect(() => {
    if (initialMode !== undefined) return;
    let active = true;
    void readThemeMode().then((stored) => {
      if (!active) return;
      setModeState(stored);
      setReady(true);
    });
    return () => {
      active = false;
    };
    // `initialMode` is a mount-time decision; changing it later is not a
    // supported use and re-running the read for it would fight the setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    // State first, write second, and the write is not awaited: the switch has
    // to feel instant, and a keystore that refuses the write is not a reason
    // to leave the owner staring at the theme they just turned off.
    setModeState(next);
    void writeThemeMode(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, palette: palettes[mode], setMode, ready }),
    [mode, setMode, ready],
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
