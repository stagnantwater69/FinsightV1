import { useEffect, useState } from "react";

/**
 * Which of a page's jump-to sections is actually on screen right now.
 *
 * The "Jump to" pill bars (Recovery Target, Expense Insight) only ever told
 * an owner where they COULD go, never where they currently were — scrolling
 * halfway down the page left every pill looking identical. This watches each
 * section with one shared IntersectionObserver and reports the id of
 * whichever is nearest the top of the readable area.
 */
export function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join(",");

  useEffect(() => {
    // jsdom (the test environment) has no IntersectionObserver — the nav
    // still renders and links still work via plain anchor scrolling, it
    // just never gets an active pill under test, same tolerance the landing
    // page's own observers already take (components/landing/grid.tsx).
    if (typeof IntersectionObserver === "undefined") return;

    const elements = key
      .split(",")
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      // A section only counts as "current" once it's reached the strip just
      // under the sticky topbar — not the instant its bottom edge appears at
      // the foot of the screen, which would flip the active pill a whole
      // section early.
      { rootMargin: "-96px 0px -70% 0px", threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]);

  return active;
}
