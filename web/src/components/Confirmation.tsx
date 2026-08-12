import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * Peak-End Rule — designed confirmation moments.
 *
 * People judge an experience by its most intense point and its ending. FinSight
 * has three endings worth designing rather than defaulting to a grey toast:
 *
 *   - resolving a flagged record   (relief: the nagging thing is gone)
 *   - finishing a CSV import       (payoff: a lot of work landed at once)
 *   - the FIRST expense ever saved (the real peak — the moment the product
 *                                   starts being true for this owner)
 *
 * The first-record case gets the celebratory treatment; the routine ones get a
 * calm, specific confirmation. All of them use the same verb as the action that
 * triggered them ("Save changes" → "Changes saved"), never "Success".
 *
 * All motion here is decorative and disappears entirely under
 * prefers-reduced-motion, via the global rule in index.css.
 */

export function Celebration({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="animate-slide-up rounded-2xl bg-gradient-to-br from-brand-50 to-accent-50 p-6 text-center ring-1 ring-edge-brand">
      <span
        aria-hidden
        className="mx-auto mb-3 flex h-14 w-14 animate-pop-in items-center justify-center rounded-full bg-brand-600 text-2xl text-white shadow-sm"
      >
        ✓
      </span>
      <h2 className="font-display text-lg font-semibold text-ink-900">{title}</h2>
      {children ? <p className="mx-auto mt-2 max-w-md text-sm text-ink-600">{children}</p> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </div>
  );
}

/**
 * The routine confirmation. Inline rather than a floating toast, because it
 * stays next to the thing that changed — a toast in the corner makes the owner
 * look away from their own record to read it.
 */
export function ConfirmationBanner({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className="flex animate-slide-up items-start gap-3 rounded-xl bg-tint-brand p-3 ring-1 ring-edge-brand"
    >
      <span
        aria-hidden
        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white"
      >
        ✓
      </span>
      <p className="flex-1 text-sm text-ink-900">{children}</p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="tap -m-2 shrink-0 text-brand-600 hover:text-brand-800"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

/**
 * Remembers, per business profile, whether that business has ever saved a
 * record — so the first-record celebration fires exactly once and doesn't
 * reappear on the second expense.
 *
 * localStorage rather than a server field: it's a presentation concern, and
 * adding a column to make a one-off animation fire would be the wrong trade.
 * The cost is that it re-fires on a different device, which is harmless.
 */
const FIRST_RECORD_KEY = "finsight.firstRecordCelebrated";

function celebratedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRST_RECORD_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function hasCelebratedFirstRecord(businessProfileId: number): boolean {
  return celebratedSet().has(String(businessProfileId));
}

export function markFirstRecordCelebrated(businessProfileId: number) {
  const set = celebratedSet();
  set.add(String(businessProfileId));
  try {
    localStorage.setItem(FIRST_RECORD_KEY, JSON.stringify([...set]));
  } catch {
    // Private browsing or a full quota — losing the flag just means the
    // celebration may show twice, which is not worth handling further.
  }
}

/** Auto-dismissing wrapper for a confirmation that shouldn't linger. */
export function useAutoDismiss(active: boolean, ms = 6000) {
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    setVisible(active);
    if (!active) return;
    const t = setTimeout(() => setVisible(false), ms);
    return () => clearTimeout(t);
  }, [active, ms]);

  return [visible, () => setVisible(false)] as const;
}
