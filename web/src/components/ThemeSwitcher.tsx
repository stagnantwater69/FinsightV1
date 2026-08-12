import { useState, type ComponentType } from "react";
import { THEMES, THEME_LABELS, useTheme, type Theme } from "../context/ThemeContext";
import { useDismiss, useMenuKeys } from "../lib/hooks";
import { IconCheck, IconMoon, IconSun, IconTheme } from "./icons";

const GLYPHS: Record<Theme, ComponentType<{ className?: string }>> = {
  classic: IconTheme,
  light: IconSun,
  dark: IconMoon,
};

/**
 * Theme switcher.
 *
 * A menu of three named themes rather than a two-state toggle, because
 * Classic is a real third option and not "light" — it is the app's original
 * warm-neutral surface, and an owner who likes it needs to be able to pick it
 * by name and stay there. A toggle could only ever offer two of the three.
 *
 * `aria-checked` inside a `menuitemradio` group, not a checkmark alone: the
 * selected theme has to be announced, not just drawn.
 */
export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const { ref, triggerRef } = useDismiss(open, () => setOpen(false));
  const onMenuKeys = useMenuKeys("[role='menuitemradio']");

  const Current = GLYPHS[theme];

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Theme — ${THEME_LABELS[theme].label}`}
        className={`tap min-h-0 min-w-0 rounded-xl text-ink-600 transition hover:bg-paper-100 hover:text-ink-900 ${
          compact ? "h-10 w-10" : "h-10 gap-2 px-2.5"
        }`}
      >
        <Current className="h-[18px] w-[18px]" />
        {!compact ? (
          <span className="text-[13px] font-medium">{THEME_LABELS[theme].label}</span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Theme"
          onKeyDown={onMenuKeys}
          className="absolute right-0 top-full z-50 mt-2 w-60 animate-pop-down rounded-2xl border border-paper-200 bg-paper p-1.5 shadow-lg"
        >
          <div className="px-2.5 pb-1.5 pt-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-400">
            Appearance
          </div>
          {THEMES.map((option) => {
            const spec = THEME_LABELS[option];
            const Glyph = GLYPHS[option];
            const active = option === theme;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(option);
                  setOpen(false);
                }}
                className={`flex min-h-tap w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition ${
                  active ? "bg-tint-brand" : "hover:bg-paper-100"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    active ? "bg-brand-600 text-white" : "bg-paper-100 text-ink-600"
                  }`}
                >
                  <Glyph className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-ink-900">{spec.label}</span>
                  <span className="block truncate text-[11.5px] text-ink-500">{spec.hint}</span>
                </span>
                {active ? (
                  <IconCheck aria-hidden className="h-4 w-4 shrink-0 text-brand-600" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
