import { SkeletonLine, SkeletonPanel } from "./Skeleton";

/**
 * Shown while a protected page's code is still downloading; AppShell stays
 * mounted around it. A page skeleton rather than a "Loading page…" line, so
 * the owner sees one loading state, not a text loader followed by the page's
 * own skeleton. The words stay for screen readers.
 */
export function RouteContentFallback() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <span className="sr-only">Loading page…</span>
      <div className="space-y-3" aria-hidden>
        <div className="skeleton h-7 w-48" />
        <SkeletonLine className="w-72 max-w-full" />
      </div>
      <SkeletonPanel lines={6} />
    </div>
  );
}
