import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Theme selection — Classic, Light, Dark.
 *
 * Classic is the default and is the app exactly as it looked before themes
 * existed, so nobody is opted into a change they didn't ask for.
 *
 * All this does is write `data-theme` onto <html> and remember the choice.
 * The colours themselves live in index.css as CSS custom properties, which
 * the Tailwind `paper` / `ink` / `tint` / `tone` / `edge` scales read at paint
 * time. That is why no component in the app carries a `dark:` variant.
 */

export const THEMES = ["classic", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, { label: string; hint: string; glyph: string }> = {
  classic: { label: "Classic", hint: "The original FinSight look", glyph: "◐" },
  light: { label: "Light", hint: "Cooler and brighter", glyph: "☀" },
  dark: { label: "Dark", hint: "Easier on the eyes at night", glyph: "☾" },
};

const STORAGE_KEY = "finsight.theme";

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Reads the persisted choice. Falls back to Classic on anything unexpected. */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Private browsing / storage disabled. Not worth failing over — the app
    // just doesn't remember the choice between visits.
  }
  return "classic";
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialised from storage rather than defaulted and corrected in an
  // effect, so the first React paint already matches what the boot script in
  // index.html put on <html>. Correcting it afterwards would be a visible
  // flash of the wrong theme.
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // As above — a theme that doesn't persist is better than a crash.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    // The colour transition is enabled only for the length of the switch.
    // Leaving it on permanently would put a 220ms colour transition on every
    // element in the app, which makes ordinary hover states feel laggy.
    const root = document.documentElement;
    root.classList.add("theme-switching");
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => root.classList.remove("theme-switching"), 260);
    setThemeState(next);
  }, []);

  // A switch in another tab should be reflected here too — the same account,
  // the same preference.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && isTheme(e.newValue)) setThemeState(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
