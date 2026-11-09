import { useEffect, useRef } from "react";

/**
 * Loads the next page when the end of a list scrolls into view, in place of a
 * "Load more" button.
 *
 * The observer is rebuilt whenever `loading` settles, so a page too short to
 * push the sentinel off screen keeps loading until it does. `paused` stops
 * that loop after a failed load and shows a "Try again" button instead.
 * Without IntersectionObserver (old browsers, jsdom) it falls back to a
 * button, so the rest of the list is never unreachable.
 */
export function AutoLoadMore({
  onLoadMore,
  loading,
  paused = false,
  label = "Load more",
}: {
  onLoadMore: () => void;
  loading: boolean;
  paused?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const supported = typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    const node = ref.current;
    if (!node || !supported || loading || paused) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect();
          onLoadMore();
        }
      },
      // Starts a little before the end is reached, so rows are usually in
      // place by the time the owner scrolls to them.
      { rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [supported, loading, paused, onLoadMore]);

  return (
    <div ref={ref} className="mt-4 flex min-h-6 justify-center">
      {loading ? (
        <p role="status" className="text-xs text-ink-500">
          Loading more…
        </p>
      ) : !supported || paused ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="tap rounded-lg px-3 py-2 text-sm font-medium text-tone-brand hover:bg-paper-100"
        >
          {paused ? "Try again" : label}
        </button>
      ) : null}
    </div>
  );
}
