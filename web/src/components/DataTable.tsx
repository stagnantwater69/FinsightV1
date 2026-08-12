import { useMemo, useState, type ReactNode } from "react";
import { Pagination, isPageSize, type PageSize } from "./Pagination";
import { usePersistentState } from "../lib/hooks";

/**
 * The one table in FinSight.
 *
 * Records, Categories, Business profiles and anything added later all render
 * through this, which is what keeps a header, a row height, a sort affordance
 * and an empty state from being redesigned slightly differently on every
 * screen (Law of Similarity — a thing that behaves the same should look the
 * same).
 *
 * What it owns:
 *   sorting, pagination, the sticky header, the loading skeleton, the empty
 *   state, and the responsive switch to cards.
 *
 * What it does NOT own: fetching, searching, or filtering. Those stay with
 * the page, because each screen filters against a different API. The table
 * takes the rows it is given, in the order it is given them, and is honest
 * about the count.
 *
 * ---------------------------------------------------------------------
 * The mobile story
 * ---------------------------------------------------------------------
 * Below `lg` this renders `mobileRow` as a stacked card list instead of a
 * table. A seven-column table at 390px either overflows horizontally or
 * crushes every column past legibility; neither is worth preserving for the
 * sake of using one element. Sorting and pagination still apply — the cards
 * are the same rows in the same order.
 */

export interface Column<T> {
  /** Stable identity — used for the sort state and as the React key. */
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /**
   * Makes the column sortable. Return the value to compare; `null` sorts to
   * the end regardless of direction, so blanks never displace real data at
   * the top of the list.
   */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "right";
  /**
   * "content" shrinks the column to fit its contents (dates, amounts, status
   * chips); "grow" lets it absorb all remaining width. This is the mechanism
   * behind columns being sized to their content while Description still takes
   * the space that's left — mark the narrow ones "content" and Description
   * "grow", and the browser's table algorithm does the rest at any width.
   */
  width?: "content" | "grow";
  /** For an actions column, where a visible header would just be clutter. */
  headerSrOnly?: boolean;
}

type SortDirection = "asc" | "desc";
export interface SortState {
  key: string;
  direction: SortDirection;
}

function compare(a: string | number | null, b: string | number | null, direction: SortDirection) {
  // Nulls last in BOTH directions — reversing the sort shouldn't fill the top
  // of the table with empty cells.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

  return direction === "asc" ? result : -result;
}

/** The sort arrow. Direction is also in aria-sort, so this is decorative. */
function SortGlyph({ state }: { state: SortDirection | null }) {
  return (
    <span
      aria-hidden
      className={`ml-1 inline-block text-[10px] leading-none transition-opacity ${
        state ? "opacity-100" : "opacity-0 group-hover:opacity-40"
      }`}
    >
      {state === "desc" ? "▼" : "▲"}
    </span>
  );
}

export function DataTable<T>({
  rows,
  columns,
  getRowKey,
  mobileRow,
  loading = false,
  skeletonRows = 8,
  empty,
  caption,
  initialSort,
  paginate = true,
  itemNoun = "records",
  storageKey,
  toolbar,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  getRowKey: (row: T) => string;
  /** Card renderer used below `lg`. */
  mobileRow: (row: T) => ReactNode;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered instead of the table when there is nothing to show. */
  empty: ReactNode;
  /** Screen-reader description of what the table contains. */
  caption: string;
  initialSort?: SortState;
  paginate?: boolean;
  itemNoun?: string;
  /** Remembers the chosen page size per table. */
  storageKey?: string;
  /** Search / filter controls, rendered in the table's own header bar. */
  toolbar?: ReactNode;
  /**
   * Extra classes for one row — e.g. a highlight ring on the specific record
   * a notification linked here for. Applied to both the desktop `<tr>` and
   * the mobile `<li>`, so the two views stay the same row visually
   * emphasised, not just the same row in the same order.
   */
  rowClassName?: (row: T) => string;
}) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentState<PageSize>(
    storageKey ? `finsight.pageSize.${storageKey}` : "finsight.pageSize.default",
    10,
    isPageSize,
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    // Copied before sorting — mutating the caller's array in place would
    // reorder their state behind their back.
    return [...rows].sort((a, b) => compare(column.sortValue!(a), column.sortValue!(b), sort.direction));
  }, [rows, sort, columns]);

  const totalItems = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  // Derived rather than corrected in an effect: when a filter shrinks the
  // results while you're on page 9, an effect would render one frame of an
  // empty table before snapping back. This just never shows that frame.
  const currentPage = Math.min(page, totalPages);

  const visible = useMemo(() => {
    if (!paginate) return sorted;
    const start = (currentPage - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, paginate, currentPage, pageSize]);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev?.key !== key) return { key, direction: "asc" };
      // asc -> desc -> unsorted, so there is always a way back to the
      // server's original order without reloading.
      if (prev.direction === "asc") return { key, direction: "desc" };
      return null;
    });
    setPage(1);
  }

  function handlePageSize(size: PageSize) {
    setPageSize(size);
    setPage(1);
  }

  // ---------------------------------------------------------------
  // Loading — a shaped skeleton, not a spinner.
  // ---------------------------------------------------------------
  if (loading) {
    return (
      <Shell toolbar={toolbar}>
        <div className="divide-y divide-paper-200" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading {itemNoun}…</span>
          {Array.from({ length: skeletonRows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4">
              <div className="skeleton h-3 w-20 shrink-0" aria-hidden />
              <div className="skeleton h-3 flex-1" aria-hidden />
              <div className="skeleton hidden h-3 w-28 shrink-0 sm:block" aria-hidden />
              <div className="skeleton h-3 w-16 shrink-0" aria-hidden />
            </div>
          ))}
        </div>
      </Shell>
    );
  }

  if (totalItems === 0) {
    return (
      <Shell toolbar={toolbar}>
        <div className="p-4">{empty}</div>
      </Shell>
    );
  }

  return (
    <Shell toolbar={toolbar}>
      {/* ---------------- Mobile: stacked cards ---------------- */}
      <ul className="divide-y divide-paper-200 lg:hidden">
        {visible.map((row) => (
          <li key={getRowKey(row)} className={`p-4 ${rowClassName?.(row) ?? ""}`}>
            {mobileRow(row)}
          </li>
        ))}
      </ul>

      {/* ---------------- Desktop: the table ----------------
          `overflow-x-auto` is a safety net, not the plan: the "content"
          columns shrink to fit and only Description grows, so at any
          realistic desktop width nothing overflows. If a very long vendor
          name ever does, it scrolls inside this box rather than pushing the
          page sideways. */}
      <div className="scroll-slim hidden overflow-x-auto lg:block">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key ? sort.direction : null;
                const alignRight = column.align === "right";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    // aria-sort is what a screen reader announces; the glyph
                    // is only for people who can see it.
                    aria-sort={
                      column.sortValue
                        ? active === "asc"
                          ? "ascending"
                          : active === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                    className={`sticky top-[var(--topbar-h)] z-10 border-b border-paper-200 bg-paper-100/95 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-500 backdrop-blur ${
                      column.width === "content" ? "w-px whitespace-nowrap" : ""
                    } ${alignRight ? "text-right" : ""}`}
                  >
                    {column.headerSrOnly ? (
                      <span className="sr-only">{column.header}</span>
                    ) : column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={`group -mx-1 flex w-full items-center rounded px-1 py-1 uppercase tracking-[0.06em] transition hover:text-brand-700 ${
                          alignRight ? "justify-end" : ""
                        }`}
                      >
                        {column.header}
                        <SortGlyph state={active} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={getRowKey(row)}
                className={`border-b border-paper-200 transition-colors last:border-0 hover:bg-paper-100 ${rowClassName?.(row) ?? ""}`}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    // py-3.5 rather than py-3: a slightly taller row is
                    // materially easier to track across seven columns, and
                    // costs about one row per screen.
                    className={`px-4 py-3.5 align-middle ${
                      column.width === "content" ? "w-px whitespace-nowrap" : ""
                    } ${column.align === "right" ? "text-right" : ""}`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A page-size selector and a "Showing 1-4 of 4" line are both about
          managing MORE than fits on screen — neither has a job to do below
          the smallest page size. Rather than showing that chrome the moment
          there's a second record, it waits until there's a first FULL page
          (the smallest page size, 10) to actually manage. */}
      {paginate && totalItems >= 10 ? (
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          totalItems={totalItems}
          onPageChange={setPage}
          onPageSizeChange={handlePageSize}
          itemNoun={itemNoun}
          idPrefix={storageKey ?? "table"}
        />
      ) : null}
    </Shell>
  );
}

/** The card the table sits in — one border and one radius for every state. */
function Shell({ toolbar, children }: { toolbar?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-paper-200 bg-paper shadow-sm">
      {toolbar ? <div className="border-b border-paper-200 p-4">{toolbar}</div> : null}
      {children}
    </div>
  );
}
