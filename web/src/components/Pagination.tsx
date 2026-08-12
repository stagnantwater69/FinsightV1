import { useMemo } from "react";
import { SelectInput } from "./Field";

/**
 * Pagination for every data table in the app.
 *
 * Two deliberate choices:
 *
 * 1. The count line ("Showing 1–10 of 243 records") is not optional. A page
 *    number on its own tells an owner nothing about how much there is; the
 *    range and total are what let them judge whether a filter did what they
 *    expected.
 *
 * 2. It renders a real <nav> with real buttons and an aria-current page, not
 *    a row of styled divs — so it is reachable by Tab and announced properly
 *    rather than being a visual-only affordance.
 *
 * The page-number window is capped and elided, so 500 pages still renders one
 * short row rather than wrapping across the screen.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export function isPageSize(v: unknown): v is PageSize {
  return typeof v === "number" && (PAGE_SIZES as readonly number[]).includes(v);
}

/**
 * Builds the visible page-number window: always the first and last page, the
 * current page with a neighbour either side, and "…" for the gaps.
 */
function pageWindow(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  // Keep the row a stable width near the ends, rather than letting it shrink
  // when the current page has no neighbour on one side.
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => pages.add(p));

  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);

  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) out.push("gap");
    out.push(page);
    previous = page;
  }
  return out;
}

const ARROW_BASE =
  "tap h-9 w-9 min-h-0 min-w-0 rounded-lg border border-paper-200 bg-paper text-ink-600 transition " +
  "hover:border-brand-300 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40 " +
  "disabled:hover:border-paper-200 disabled:hover:text-ink-600";

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  itemNoun = "records",
  idPrefix = "pagination",
}: {
  /** 1-indexed. */
  page: number;
  pageSize: PageSize;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
  /** Pluralised noun for the count line — "records", "categories", … */
  itemNoun?: string;
  /** Distinguishes the page-size <select> when two tables share a screen. */
  idPrefix?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clamped = Math.min(Math.max(page, 1), totalPages);
  const firstItem = totalItems === 0 ? 0 : (clamped - 1) * pageSize + 1;
  const lastItem = Math.min(clamped * pageSize, totalItems);

  const windowed = useMemo(() => pageWindow(clamped, totalPages), [clamped, totalPages]);

  const sizeId = `${idPrefix}-size`;

  return (
    <div className="flex flex-col gap-3 border-t border-paper-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      {/* ---- count + page size ---- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm text-ink-500" aria-live="polite">
          {totalItems === 0 ? (
            <>No {itemNoun}</>
          ) : (
            <>
              Showing{" "}
              <span className="figure font-semibold text-ink-800">
                {firstItem.toLocaleString()}–{lastItem.toLocaleString()}
              </span>{" "}
              of <span className="figure font-semibold text-ink-800">{totalItems.toLocaleString()}</span>{" "}
              {itemNoun}
            </>
          )}
        </p>

        <div className="flex items-center gap-2">
          <label htmlFor={sizeId} className="whitespace-nowrap text-sm text-ink-500">
            Rows
          </label>
          <SelectInput
            id={sizeId}
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
            className="w-auto px-2 transition hover:border-brand-300"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </SelectInput>
        </div>
      </div>

      {/* ---- page controls ----
          Hidden entirely at one page: a disabled row of arrows next to
          "Showing 1–4 of 4" is noise that implies there is somewhere to go. */}
      {totalPages > 1 ? (
        <nav aria-label="Pagination" className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(1)}
            disabled={clamped === 1}
            className={ARROW_BASE}
            aria-label="First page"
          >
            <span aria-hidden>«</span>
          </button>
          <button
            type="button"
            onClick={() => onPageChange(clamped - 1)}
            disabled={clamped === 1}
            className={ARROW_BASE}
            aria-label="Previous page"
          >
            <span aria-hidden>‹</span>
          </button>

          {/* The numbered window costs the most horizontal room and is the
              least essential control on a phone — prev/next plus the count
              line already convey position there. */}
          <ol className="hidden items-center gap-1 sm:flex">
            {windowed.map((entry, i) =>
              entry === "gap" ? (
                <li key={`gap-${i}`} aria-hidden className="px-1 text-sm text-ink-400">
                  …
                </li>
              ) : (
                <li key={entry}>
                  <button
                    type="button"
                    onClick={() => onPageChange(entry)}
                    aria-current={entry === clamped ? "page" : undefined}
                    aria-label={`Page ${entry}`}
                    className={`tap h-9 w-9 min-h-0 min-w-0 rounded-lg border text-sm transition ${
                      entry === clamped
                        ? "border-brand-600 bg-brand-600 font-semibold text-white"
                        : "border-paper-200 bg-paper text-ink-600 hover:border-brand-300 hover:text-brand-700"
                    }`}
                  >
                    <span className="figure">{entry}</span>
                  </button>
                </li>
              ),
            )}
          </ol>

          {/* The compact equivalent of the number row. */}
          <span className="figure px-2 text-sm text-ink-500 sm:hidden">
            {clamped} / {totalPages}
          </span>

          <button
            type="button"
            onClick={() => onPageChange(clamped + 1)}
            disabled={clamped === totalPages}
            className={ARROW_BASE}
            aria-label="Next page"
          >
            <span aria-hidden>›</span>
          </button>
          <button
            type="button"
            onClick={() => onPageChange(totalPages)}
            disabled={clamped === totalPages}
            className={ARROW_BASE}
            aria-label="Last page"
          >
            <span aria-hidden>»</span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}
