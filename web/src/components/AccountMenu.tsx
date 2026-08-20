import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useNotifications } from "../context/NotificationContext";
import { useTourOptional } from "../context/TourContext";
import { THEMES, THEME_LABELS, useTheme } from "../context/ThemeContext";
import { useDismiss, useMenuKeys } from "../lib/hooks";
import { STATUS_TEXT_COLORS } from "../lib/chartPalette";
import {
  IconBell,
  IconBusiness,
  IconChevronDown,
  IconHelp,
  IconLogout,
  IconProfile,
  IconSettings,
  IconSparkle,
} from "./icons";

/** Initials for the avatar. Falls back to "?" rather than rendering empty. */
export function initials(first?: string, last?: string) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";
}

/**
 * The account menu, top-right.
 *
 * Includes an inline theme row as well as the dedicated switcher in the
 * topbar. That is deliberate duplication, not an oversight: the switcher is
 * discoverable for someone scanning the chrome, and the account menu is where
 * people look for a preference by habit. Both write the same context, so they
 * cannot disagree.
 *
 * Log out sits below a divider and is the only item that isn't navigation —
 * separated so it can't be hit while aiming for the item above it.
 */
export function AccountMenu() {
  const { profile: user, logout } = useAuth();
  const { unreadCount } = useNotifications();
  const { theme, setTheme } = useTheme();
  const tour = useTourOptional();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const { ref, triggerRef } = useDismiss(open, () => setOpen(false));
  const onMenuKeys = useMenuKeys();

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Account";

  async function handleLogout() {
    setOpen(false);
    await logout();
    navigate("/login");
  }

  const item =
    "flex min-h-tap w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13.5px] text-ink-700 transition hover:bg-paper-100 hover:text-ink-900";

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="tap min-h-0 gap-2 rounded-xl px-1.5 py-1 text-left transition hover:bg-paper-100"
      >
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-700 text-[12.5px] font-bold text-white"
        >
          {initials(user?.firstName, user?.lastName)}
        </span>
        {/* The name is hidden below `sm` — the avatar alone identifies the
            account, and the name is the first thing worth spending width on
            when width is short. */}
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-[9rem] truncate text-[13px] font-semibold text-ink-900">
            {fullName}
          </span>
        </span>
        <IconChevronDown
          className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
        <span className="sr-only">Account menu</span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeys}
          className="absolute right-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-1.5rem)] animate-pop-down rounded-2xl border border-paper-200 bg-paper p-1.5 shadow-lg"
        >
          {/* Identity header — confirms WHICH account, which matters as soon
              as someone has a personal and a work login. */}
          <div className="flex items-center gap-2.5 border-b border-paper-200 px-2.5 pb-2.5 pt-2">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-sm font-bold text-white"
            >
              {initials(user?.firstName, user?.lastName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink-900">{fullName}</p>
              <p className="truncate text-[11.5px] text-ink-500">{user?.email}</p>
            </div>
          </div>

          <div className="pt-1.5">
            <Link to="/profile" role="menuitem" onClick={() => setOpen(false)} className={item}>
              <IconProfile aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
              My profile
            </Link>
            <Link to="/business-profiles" role="menuitem" onClick={() => setOpen(false)} className={item}>
              <IconSettings aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
              Account settings
            </Link>
            <Link to="/notifications" role="menuitem" onClick={() => setOpen(false)} className={item}>
              <IconBell aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
              Notifications
              {unreadCount > 0 ? (
                <span
                  className="ml-auto rounded-full px-1.5 text-[10.5px] font-bold text-white"
                  style={{ backgroundColor: STATUS_TEXT_COLORS.critical }}
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : null}
            </Link>
            <Link to="/business-profiles" role="menuitem" onClick={() => setOpen(false)} className={item}>
              <IconBusiness aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
              Business profiles
            </Link>
          </div>

          {/* ---- theme, inline ---- */}
          <div className="mt-1.5 border-t border-paper-200 pt-2">
            <div className="px-2.5 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-400">
              Theme
            </div>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="mx-1.5 mb-1 flex gap-1 rounded-xl bg-paper-100 p-1"
            >
              {THEMES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={theme === option}
                  onClick={() => setTheme(option)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] font-semibold transition ${
                    theme === option
                      ? "bg-paper text-brand-800 shadow-sm"
                      : "text-ink-500 hover:text-ink-800"
                  }`}
                >
                  {THEME_LABELS[option].label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-1 border-t border-paper-200 pt-1.5">
            {tour ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  // Rewind the stored state, then land on the dashboard —
                  // the tour auto-resumes there once its data has loaded.
                  tour.restart();
                  navigate("/dashboard");
                }}
                className={item}
              >
                <IconSparkle aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
                Restart product tour
              </button>
            ) : null}
            <a
              href="mailto:support@finsight.app?subject=FinSight%20help"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={item}
            >
              <IconHelp aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
              Help &amp; support
            </a>
            <button type="button" role="menuitem" onClick={handleLogout} className={item}>
              <IconLogout aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
              Log out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
