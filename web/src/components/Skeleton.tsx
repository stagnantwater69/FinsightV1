/**
 * Skeleton loaders — the Doherty Threshold work.
 *
 * The target is that the interface responds visibly within ~400ms even when
 * the real work can't. Three things in FinSight are structurally incapable of
 * meeting that: AI calls, tesseract OCR, and CSV parse-plus-insert. For those,
 * the honest move is to commit to the eventual SHAPE of the answer instantly,
 * so the wait reads as "fetching this specific thing" rather than as a hang.
 *
 * These deliberately mirror the real components' geometry. A skeleton that
 * doesn't match what arrives causes a layout jump, which is worse than a
 * spinner — so each one here is sized against its real counterpart.
 */

export function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`skeleton h-3 ${className}`.trim()} aria-hidden />;
}

/** Matches StatTile: label, big figure, optional sublabel. */
export function SkeletonStatTile() {
  return (
    <div className="rounded-2xl bg-paper p-5 border border-paper-200 shadow-sm">
      <SkeletonLine className="w-24" />
      <div className="skeleton mt-3 h-7 w-32" aria-hidden />
      <SkeletonLine className="mt-3 w-20" />
    </div>
  );
}

/** Matches the dashboard's two-column panel row. */
export function SkeletonPanel({ lines = 4, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="rounded-2xl bg-paper p-5 border border-paper-200 shadow-sm">
      {title ? <SkeletonLine className="mb-4 w-40" /> : null}
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} className={i % 3 === 2 ? "w-2/3" : "w-full"} />
        ))}
      </div>
    </div>
  );
}

/** Matches a Records table row / card. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-paper-200">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4">
          <SkeletonLine className="w-20 shrink-0" />
          <SkeletonLine className="flex-1" />
          <SkeletonLine className="w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * The AI drawer's "thinking" state.
 *
 * Shaped like an answer bubble rather than shown as a spinner, because the
 * useful signal is "an answer is being written in this spot", and a bubble
 * conveys that where a spinner doesn't.
 */
export function SkeletonBubble() {
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-tint-brand text-xs text-tone-brand"
      >
        ✦
      </span>
      <div className="w-[85%] space-y-2 rounded-2xl rounded-bl-sm bg-paper px-3.5 py-3 border border-paper-200">
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-11/12" />
        <SkeletonLine className="w-3/5" />
      </div>
    </div>
  );
}

/** Full dashboard skeleton, matching the real grid so nothing jumps. */
export function SkeletonDashboard() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your dashboard…</span>
      <div className="flex justify-between gap-5" aria-hidden="true">
        <SkeletonLine className="h-3 w-40" />
        <SkeletonLine className="h-3 w-40" />
      </div>
      <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-paper-200 bg-paper min-[360px]:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="min-w-0 space-y-3 border-paper-200 p-4 sm:p-5">
            <SkeletonLine className="max-w-24" />
            <SkeletonLine className="h-7 max-w-32" />
            <SkeletonLine className="max-w-20" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7"><SkeletonPanel lines={7} /></div>
        <div className="min-w-0 lg:col-span-5"><SkeletonPanel lines={5} /></div>
      </div>
      <SkeletonPanel lines={8} />
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-7"><SkeletonPanel lines={5} /></div>
        <div className="lg:col-span-5"><SkeletonPanel lines={5} /></div>
      </div>
    </div>
  );
}
