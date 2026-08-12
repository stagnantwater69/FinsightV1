import { useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useDismiss, useMenuKeys } from "../lib/hooks";
import { IconBusiness, IconChevronDown, IconPlus, IconSettings } from "./icons";

/**
 * The business switcher, in the sidebar beneath the logo.
 *
 * Moved out of the page header for two reasons. It is global state — which
 * business you are looking at colours every figure on every screen — and
 * global state belongs in the global chrome, not in a header that also
 * carries the current page's title. And it frees the topbar for the things
 * that are genuinely per-session: search, alerts, account.
 *
 * Sitting directly under the logo also matches how the rest of the category
 * reads (Slack's workspace, Linear's team, Stripe's account), so it is
 * findable without being looked for.
 *
 * Rendered directly on the rail, so the trigger button below uses the
 * `sidebar-*` tokens (tailwind.config.js) rather than paper/ink — those
 * resolve to white-alpha fills on the dark rail (Classic/Dark) and dark-ink
 * fills on the light one (Light theme). The dropdown MENU itself is a
 * separate, ordinary `bg-paper` surface once open, so it needs none of this
 * — only the always-visible trigger row sits on the rail's own surface.
 */
export function BusinessSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { profiles, selected, selectProfile, loading } = useBusinessProfiles();
  const [open, setOpen] = useState(false);
  const { ref, triggerRef } = useDismiss(open, () => setOpen(false));
  const onMenuKeys = useMenuKeys();

  if (loading) {
    return (
      <div className={`mb-3 ${collapsed ? "px-1" : "px-1"}`}>
        <div className="skeleton h-12 rounded-xl bg-sidebar-fg/10" aria-hidden />
        <span className="sr-only">Loading your businesses…</span>
      </div>
    );
  }

  // No businesses yet — the switcher would be an empty control, so it becomes
  // the invitation to create one instead.
  if (!selected) {
    if (collapsed) {
      return (
        <Link
          to="/business-profiles/new"
          title="Add a business profile"
          className="tap mx-auto mb-3 h-10 w-10 min-h-0 min-w-0 rounded-xl bg-sidebar-fg/10 text-sidebar-ink transition hover:bg-sidebar-fg/20"
          aria-label="Add a business profile"
        >
          <IconPlus className="h-4 w-4" />
        </Link>
      );
    }
    return (
      <Link
        to="/business-profiles/new"
        className="mb-3 flex min-h-tap items-center gap-2.5 rounded-xl border border-dashed border-sidebar-fg/25 px-2.5 text-left transition hover:border-sidebar-fg/50 hover:bg-sidebar-fg/10"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-fg/10 text-sidebar-ink">
          <IconPlus className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-sidebar-ink">Add a business</span>
          <span className="block text-[11px] text-sidebar-accent">Nothing set up yet</span>
        </span>
      </Link>
    );
  }

  return (
    <div ref={ref} className="relative mb-3">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={collapsed ? `${selected.name} — switch business` : undefined}
        className={`flex min-h-tap w-full items-center rounded-xl border border-sidebar-fg/15 bg-sidebar-fg/10 text-left transition hover:border-sidebar-fg/30 hover:bg-sidebar-fg/15 ${
          collapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
        }`}
      >
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
          <IconBusiness className="h-4 w-4" />
          {/* Collapsed, the "active" word is gone, so the state moves onto the
              avatar as a dot — the sidebar rail still says which business is
              live without needing to be expanded. */}
          {collapsed ? (
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-brand-300 ring-2 ring-brand-900"
            />
          ) : null}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <b className="block truncate text-[13.5px] font-semibold text-sidebar-ink">{selected.name}</b>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" />
                <small className="truncate text-[11px] text-sidebar-muted">Active business</small>
              </span>
            </span>
            <IconChevronDown
              className={`h-4 w-4 shrink-0 text-sidebar-muted transition-transform ${open ? "rotate-180" : ""}`}
            />
          </>
        ) : null}
        <span className="sr-only">
          {selected.name} — active business profile. Switch or manage businesses.
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Business profiles"
          onKeyDown={onMenuKeys}
          className={`absolute z-50 mt-2 w-[17rem] max-w-[calc(100vw-2rem)] animate-pop-down rounded-2xl border border-paper-200 bg-paper p-2 shadow-lg ${
            // Collapsed the rail is only 72px wide, so the menu flies out to
            // the side rather than hanging off the left edge of the screen.
            collapsed ? "left-full top-0 ml-2" : "left-0 top-full"
          }`}
        >
          <div className="px-2.5 pb-1.5 pt-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-400">
            Switch business profile
          </div>

          <div className="scroll-slim max-h-[16rem] overflow-y-auto">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === selected.id}
                onClick={() => {
                  selectProfile(p.id);
                  setOpen(false);
                }}
                className={`flex min-h-tap w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition ${
                  p.id === selected.id ? "bg-tint-brand" : "hover:bg-paper-100"
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tint-brand text-tone-brand">
                  <IconBusiness className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-ink-900">{p.name}</span>
                  <span className="block truncate text-[11.5px] text-ink-500">{p.type}</span>
                </span>
                {p.id === selected.id ? (
                  <span className="shrink-0 text-brand-600" aria-hidden>
                    ✓
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <hr className="my-1.5 border-paper-200" />

          <Link
            to="/business-profiles/new"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-tap items-center gap-2.5 rounded-xl px-2.5 transition hover:bg-paper-100"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tint-brand text-tone-brand">
              <IconPlus className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-ink-900">Add business profile</span>
              <span className="block text-[11.5px] text-ink-500">Store, branch, or income source</span>
            </span>
          </Link>

          <Link
            to="/business-profiles"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-tap items-center gap-2.5 rounded-xl px-2.5 transition hover:bg-paper-100"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tint-neutral text-tone-neutral">
              <IconSettings className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-ink-900">Manage businesses</span>
              <span className="block text-[11.5px] text-ink-500">Edit, archive, or restore</span>
            </span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
