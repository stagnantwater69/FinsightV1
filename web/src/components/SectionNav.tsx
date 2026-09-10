import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { useActiveSection } from "../lib/useActiveSection";

export type SectionNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Recovery Target's "Save a plan" pill hijacks the click to expand a
   *  collapsed panel instead of a plain anchor jump — everything else omits
   *  this and gets ordinary in-page navigation. */
  onClick?: (event: MouseEvent) => void;
};

/**
 * The horizontally-scrolling "Jump to" pill bar shared by every insight page
 * with more sections than fit above the fold (Recovery Target, Expense
 * Insight). One component rather than two near-identical copies, so a change
 * to the bar's own behaviour — like the active-section highlight below —
 * lands on both pages at once instead of drifting between them.
 *
 * Highlights whichever section is actually on screen (`useActiveSection`),
 * so scrolling down the page moves the highlighted pill along with it —
 * previously every pill looked identical regardless of scroll position.
 */
export function SectionNav({
  ariaLabel,
  items,
}: {
  ariaLabel: string;
  items: SectionNavItem[];
}) {
  const ids = items.map((item) => item.href.slice(1));
  const active = useActiveSection(ids);

  return (
    <nav
      aria-label={ariaLabel}
      // Sticky under the topbar rather than scrolling away with the page —
      // otherwise the active-section highlight below is only ever visible
      // near the very top, defeating its own purpose on a page long enough
      // to need a jump-to bar in the first place. Same top offset and
      // frosted background DataTable's own sticky header already uses, so
      // scrolled content passes cleanly underneath instead of showing
      // through.
      className="scroll-slim sticky top-[var(--topbar-h)] z-10 -mx-2 overflow-x-auto bg-paper/95 px-2 py-2 backdrop-blur"
    >
      <div className="inline-flex min-w-max items-center rounded-2xl bg-paper p-1 ring-1 ring-paper-200">
        <span className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs font-semibold text-ink-600">
          <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
          Jump to
        </span>
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-paper-200" />
        <ul className="flex items-center gap-1">
          {items.map((item) => {
            const Icon = item.icon;
            const isCurrent = active === item.href.slice(1);
            return (
              <li key={item.label}>
                <a
                  href={item.href}
                  onClick={item.onClick}
                  aria-current={isCurrent ? "location" : undefined}
                  className={`tap inline-flex shrink-0 items-center gap-2 rounded-xl px-3 text-[13px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                    isCurrent
                      ? "bg-brand-800 text-white shadow-sm"
                      : "text-ink-600 hover:bg-tint-brand hover:text-tone-brand"
                  }`}
                >
                  <Icon aria-hidden className="size-4" strokeWidth={1.9} />
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
