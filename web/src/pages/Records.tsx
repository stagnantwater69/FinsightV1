import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { Money } from "../components/Money";
import { Button, ButtonLink } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { DataTable, type Column } from "../components/DataTable";
import { IconEdit, IconSearch, IconTrash } from "../components/icons";
import { RECORD_SOURCE_LABELS, type ImportBatchSummary, type RecordItem, type RecordSource } from "../lib/types";
import { PageHead, Pill, Tag, type PillTone } from "../components/ui";
import { SelectInput, TextInput } from "../components/Field";
import { useConfirm } from "../components/ConfirmDialog";
import { useDebounced } from "../lib/hooks";
import { useToast } from "../components/Toast";
import { AddExpenseModal } from "../components/AddExpenseModal";
import { AddSalesModal } from "../components/AddSalesModal";
import { DuplicateReviewModal } from "../components/DuplicateReviewModal";

interface Filters {
  type: "all" | "expense" | "sales";
  categoryId: string;
  dateFrom: string;
  dateTo: string;
  keyword: string;
  source: "" | RecordSource;
  /** Only meaningful alongside source === "CSV_UPLOAD" — see the Source select. */
  importBatchId: string;
}

const emptyFilters: Filters = {
  type: "all",
  categoryId: "",
  dateFrom: "",
  dateTo: "",
  keyword: "",
  source: "",
  importBatchId: "",
};

/** Which filters count as "advanced" for Hick's Law progressive disclosure. */
function activeAdvancedCount(f: Filters) {
  return [f.categoryId, f.dateFrom, f.dateTo, f.source, f.importBatchId].filter(Boolean).length;
}

/**
 * One status per row, not a stack of badges.
 *
 * A record can carry a duplicate flag, a large-expense flag and "Needs
 * Review" all at once, but the table only has room to say one thing at a
 * glance — so this picks the single most useful one, in priority order: a
 * possible duplicate is the most actionable (it's asking "is this the same
 * as another record?"), plain "needs review" is next, and everything settled
 * reads as "Reviewed". Large-expense records already carry reviewStatus
 * "Needs Review" (expenseRecord.service.ts), so they fall out of this
 * naturally without a fourth case.
 */
function recordStatus(r: RecordItem): { label: string; tone: PillTone } {
  if (r.duplicateStatus === "Flagged") return { label: "Possible Duplicate", tone: "info" };
  if (r.reviewStatus === "Needs Review") return { label: "Needs Review", tone: "warn" };
  return { label: "Reviewed", tone: "ok" };
}

/**
 * The filter <-> URL mapping, in one pair of functions so the two directions
 * cannot drift.
 *
 * Only non-default values are written, so an unfiltered /records stays a clean
 * URL rather than carrying six empty parameters.
 */
function filtersToParams(f: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.type !== "all") params.set("type", f.type);
  if (f.categoryId) params.set("categoryId", f.categoryId);
  if (f.keyword) params.set("keyword", f.keyword);
  if (f.dateFrom) params.set("dateFrom", f.dateFrom);
  if (f.dateTo) params.set("dateTo", f.dateTo);
  if (f.source) params.set("source", f.source);
  // Only meaningful with source, so only ever written alongside it — but
  // written unconditionally on that, rather than re-deriving "is this a CSV
  // filter" here too.
  if (f.source && f.importBatchId) params.set("importBatchId", f.importBatchId);
  return params;
}

function filtersFromParams(params: URLSearchParams): Filters {
  const source = (params.get("source") as Filters["source"]) ?? "";
  return {
    type: (params.get("type") as Filters["type"]) || "all",
    categoryId: params.get("categoryId") ?? "",
    keyword: params.get("keyword") ?? "",
    dateFrom: params.get("dateFrom") ?? "",
    dateTo: params.get("dateTo") ?? "",
    source,
    // A stray ?importBatchId= surviving a source change in the URL (e.g. a
    // hand-edited link) should not silently scope the results to a batch the
    // Source select no longer shows as selected.
    importBatchId: source === "CSV_UPLOAD" ? (params.get("importBatchId") ?? "") : "",
  };
}

export function Records() {
  const { selected } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  const [searchParams, setSearchParams] = useSearchParams();
  const confirm = useConfirm();
  const toast = useToast();

  // Seeded from the URL so a deep link can arrive pre-filtered — global search
  // sends "category X" here as ?type=expense&categoryId=N, and it would be a
  // dead end if the page ignored it.
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(searchParams));

  // A notification's "review this" link arrives as ?highlightRecordId=123.
  // Read once at mount — it isn't part of the filters<->URL round-trip below,
  // it just seeds it once (see the effect further down) and marks which row
  // gets the highlight treatment.
  const [highlightRecordId] = useState<number | null>(() => {
    const raw = searchParams.get("highlightRecordId");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  });

  /**
   * The search box is debounced; the selects are not.
   *
   * Typing fired one /records/search AND one /records/flagged per keystroke,
   * because the fetch effect depended on the whole `filters` object and its
   * identity changes on every setFilters. Choosing from a dropdown is a single
   * deliberate act and should feel immediate, so only the keyword waits.
   */
  const debouncedKeyword = useDebounced(filters.keyword, 250);

  // What the URL should say, given the filters that have actually been applied.
  // The debounced keyword rather than the raw one, so a burst of typing writes
  // one entry instead of one per character.
  const appliedFilters: Filters = { ...filters, keyword: debouncedKeyword };
  const desiredQuery = filtersToParams(appliedFilters).toString();
  const queryKey = searchParams.toString();

  /**
   * Filters -> URL, so a filtered view can be bookmarked, shared and restored
   * with the back button. The page read filters FROM the URL already but never
   * wrote any back, so the address bar went stale the moment anything changed.
   *
   * `replace` because adjusting a filter is refining one view, not navigating
   * to a new one — otherwise Back would step through every intermediate state.
   */
  const lastWritten = useRef<string | null>(null);
  const keywordSettled = debouncedKeyword === filters.keyword;

  useEffect(() => {
    // Wait for the debounce to catch up before touching the URL. This does two
    // jobs. While typing it holds the write until the keyword stops changing,
    // so a burst of characters produces one history entry. More importantly it
    // keeps the Back button working: when the read effect below applies a URL
    // the user navigated to, `filters` updates immediately but
    // `debouncedKeyword` still holds the PREVIOUS keyword for another 250ms —
    // without this guard the stale value would be written straight back and
    // Back would look broken.
    if (!keywordSettled) return;
    if (desiredQuery === queryKey) return;
    lastWritten.current = desiredQuery;
    setSearchParams(desiredQuery, { replace: true });
  }, [desiredQuery, queryKey, keywordSettled, setSearchParams]);

  /**
   * URL -> filters, for navigation this page didn't cause: global search while
   * already on /records, a pasted link, the back button.
   *
   * The ref is what stops the two effects looping. A query string this
   * component just wrote is not new information, so it is ignored; anything
   * else is an actual navigation and gets applied.
   */
  useEffect(() => {
    if (queryKey === lastWritten.current) return;
    setFilters(filtersFromParams(new URLSearchParams(queryKey)));
  }, [queryKey]);

  const [records, setRecords] = useState<RecordItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flaggedCount, setFlaggedCount] = useState(0);
  // Only loaded once the owner has actually chosen "CSV Upload" as the
  // source — fetching every business profile's whole import history on every
  // Records page load would be wasted work on the common case of never
  // touching this filter.
  const [importBatches, setImportBatches] = useState<ImportBatchSummary[]>([]);
  // Hick's Law: the two filters people reach for most (type, search) stay
  // visible; the other four are collapsed until asked for. Auto-expanded when
  // any of them is already set, so an active filter is never hidden.
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The Records page's own "Add expense" / "Add sales" now open as popups
  // rather than navigating away — everywhere else in the app (Quick Add,
  // Dashboard's empty state, GlobalSearch) still routes to the full page,
  // since only here is the list already on screen and worth staying on.
  const [addExpenseOpen, setAddExpenseOpen] = useState(false);
  const [addSalesOpen, setAddSalesOpen] = useState(false);
  /**
   * The record whose duplicate flag is being decided, if any.
   *
   * Seeded from ?reviewDuplicateId so a notification can link straight to the
   * decision rather than dropping the owner on the list to find it themselves.
   */
  const [reviewDuplicate, setReviewDuplicate] = useState<{ id: number; type: "expense" | "sales" } | null>(
    () => {
      const raw = searchParams.get("reviewDuplicateId");
      const parsed = raw ? Number(raw) : NaN;
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      // Notifications only ever carry an expense record id (notification.
      // expenseRecordId), so there is nothing else this could be.
      return { id: parsed, type: "expense" };
    },
  );

  async function loadRecords(signal?: AbortSignal, cursor?: string) {
    if (!selected) return;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<{ items: RecordItem[]; nextCursor: string | null }>("/records/search", {
        signal,
        params: {
          businessProfileId: selected.id,
          type: appliedFilters.type,
          categoryId: appliedFilters.categoryId || undefined,
          dateFrom: appliedFilters.dateFrom || undefined,
          dateTo: appliedFilters.dateTo || undefined,
          keyword: appliedFilters.keyword || undefined,
          source: appliedFilters.source || undefined,
          importBatchId: appliedFilters.importBatchId || undefined,
          limit: 100,
          cursor,
        },
      });
      setRecords((current) => (cursor ? [...current, ...data.items] : data.items));
      setNextCursor(data.nextCursor);
    } catch (err) {
      // A superseded request is not a failure — reporting it would flash an
      // error every time the filters change faster than the network.
      if (signal?.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  async function loadFlaggedCount(signal?: AbortSignal) {
    if (!selected) return;
    try {
      const { data } = await api.get<RecordItem[]>("/records/flagged", {
        signal,
        params: { businessProfileId: selected.id },
      });
      setFlaggedCount(data.length);
    } catch {
      // The badge is decoration; a failure here must not take out the page.
    }
  }

  // Depends on the individual filter values rather than the `filters` object,
  // whose identity changes on every keystroke — that identity was the reason a
  // single character re-issued both requests.
  useEffect(() => {
    const controller = new AbortController();
    loadRecords(controller.signal);
    loadFlaggedCount(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected?.id,
    appliedFilters.type,
    appliedFilters.categoryId,
    appliedFilters.dateFrom,
    appliedFilters.dateTo,
    appliedFilters.keyword,
    appliedFilters.source,
    appliedFilters.importBatchId,
  ]);

  // Fetched only while the Source filter is actually set to CSV Upload —
  // there is nowhere in the UI to pick a specific import otherwise, so
  // fetching it eagerly would be wasted on every other filter state.
  useEffect(() => {
    if (!selected || filters.source !== "CSV_UPLOAD") {
      setImportBatches([]);
      return;
    }
    const controller = new AbortController();
    api
      .get<ImportBatchSummary[]>("/records/csv-imports/batches", {
        signal: controller.signal,
        params: { businessProfileId: selected.id },
      })
      .then(({ data }) => setImportBatches(data))
      .catch(() => {
        // The picker degrading to "no imports listed" is a minor
        // inconvenience, not a reason to break the rest of the page.
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, filters.source]);

  /**
   * Arriving from a notification's "review this" link — looks up the real
   * record so the search can be seeded with its actual description, which is
   * what gets it onto page 1 without teaching DataTable anything about a
   * specific row. If the record is gone (deleted since the notification was
   * raised), this says so instead of silently landing on an empty filter.
   */
  useEffect(() => {
    if (!highlightRecordId || !selected) return;
    let cancelled = false;
    api
      .get<RecordItem>(`/records/expenses/${highlightRecordId}`)
      .then(({ data }) => {
        if (cancelled) return;
        setFilters((f) => ({ ...f, type: "expense", keyword: data.description }));
      })
      .catch(() => {
        if (!cancelled) toast("That record couldn't be found — it may have been deleted.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRecordId, selected?.id]);

  /**
   * Delete, with the row removed optimistically and an undo offered.
   *
   * The optimistic removal is what makes the table feel like it responded; the
   * undo is what makes the removal safe to be that eager. Restoring re-POSTs
   * the record rather than un-deleting it, because the API has no soft delete —
   * so the restored row is a new record with a new id, which is why the list is
   * reloaded from the server afterwards rather than patched back in memory.
   */
  async function handleDelete(record: RecordItem) {
    const ok = await confirm({
      title: `Delete "${record.description}"?`,
      body: (
        <>
          This removes the record from your history. You'll get a moment to undo it, but after that it's
          gone.
        </>
      ),
      confirmLabel: "Delete record",
      tone: "danger",
    });
    if (!ok) return;

    const path = record.type === "expense" ? `/records/expenses/${record.id}` : `/records/sales/${record.id}`;
    const key = `${record.type}-${record.id}`;
    const previous = records;

    setRecords((rows) => rows.filter((r) => `${r.type}-${r.id}` !== key));

    try {
      await api.delete(path);
      loadFlaggedCount();
      toast("Record deleted", { actionLabel: "Undo", onAction: () => restoreRecord(record) });
    } catch (err) {
      // Put the row back: the server still has it, so leaving it hidden would
      // be lying about the state of their records.
      setRecords(previous);
      setError(getErrorMessage(err));
    }
  }

  async function restoreRecord(record: RecordItem) {
    try {
      if (record.type === "expense") {
        await api.post("/records/expenses", {
          businessProfileId: record.businessProfileId,
          categoryId: record.categoryId,
          date: record.date.slice(0, 10),
          description: record.description,
          vendor: record.vendor || undefined,
          amount: record.amount,
        });
      } else {
        await api.post("/records/sales", {
          businessProfileId: record.businessProfileId,
          date: record.date.slice(0, 10),
          description: record.description,
          amount: record.amount,
        });
      }
      await Promise.all([loadRecords(), loadFlaggedCount()]);
      toast("Record restored");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function categoryName(categoryId?: number) {
    return categories.find((c) => c.id === categoryId)?.name ?? "—";
  }

  if (!selected) return null;

  const hasFilters = JSON.stringify(filters) !== JSON.stringify(emptyFilters);
  const advancedCount = activeAdvancedCount(filters);

  const editPath = (r: RecordItem) =>
    r.type === "expense" ? `/records/expenses/${r.id}/edit` : `/records/sales/${r.id}/edit`;

  // ---------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------
  // Every column except Description is "content" width — dates, amounts,
  // sources and status chips all have a known maximum size, so they shrink to
  // fit and Description absorbs everything left over. That is what gives
  // Description the room it needs at any window width without a hard-coded
  // percentage that would be wrong at some other width.
  const columns: Column<RecordItem>[] = [
    {
      key: "date",
      header: "Date",
      width: "content",
      sortValue: (r) => r.date,
      cell: (r) => <span className="figure text-ink-600">{r.date.slice(0, 10)}</span>,
    },
    {
      key: "type",
      header: "Type",
      width: "content",
      sortValue: (r) => r.type,
      cell: (r) => <Tag kind={r.type === "expense" ? "expense" : "sales"} />,
    },
    {
      key: "description",
      header: "Description",
      width: "grow",
      sortValue: (r) => r.description,
      cell: (r) => <span className="min-w-0 font-medium text-ink-900">{r.description}</span>,
    },
    {
      key: "category",
      header: "Category",
      width: "content",
      sortValue: (r) => (r.type === "expense" ? categoryName(r.categoryId) : null),
      cell: (r) => (
        <span className="text-ink-600">{r.type === "expense" ? categoryName(r.categoryId) : "—"}</span>
      ),
    },
    {
      key: "vendor",
      header: "Vendor",
      width: "content",
      sortValue: (r) => r.vendor ?? null,
      cell: (r) => <span className="text-ink-500">{r.vendor || "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      width: "content",
      align: "right",
      sortValue: (r) => r.amount,
      cell: (r) => (
        <span className={`font-medium ${r.type === "expense" ? "text-ink-900" : "text-brand-700"}`}>
          <Money value={r.amount} />
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      width: "content",
      sortValue: (r) => r.source,
      cell: (r) => (
        <span className="text-xs text-ink-500">
          {RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "content",
      sortValue: (r) => recordStatus(r).label,
      cell: (r) => {
        const status = recordStatus(r);
        return <Pill tone={status.tone}>{status.label}</Pill>;
      },
    },
    {
      key: "actions",
      header: "Actions",
      headerSrOnly: true,
      width: "content",
      align: "right",
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          {r.duplicateStatus === "Flagged" ? (
            /*
              A button, not a link to the flagged queue. The decision is about
              THIS row and belongs next to it — see DuplicateReviewModal.
            */
            <button
              type="button"
              onClick={() => setReviewDuplicate({ id: r.id, type: r.type })}
              title="Review possible duplicate"
              aria-label={`Review possible duplicate — ${r.description}`}
              className="tap flex h-9 w-9 min-h-0 min-w-0 items-center justify-center rounded-lg text-tone-info transition hover:bg-tint-info"
            >
              <span aria-hidden className="text-base leading-none">
                ⧉
              </span>
            </button>
          ) : null}
          <Link
            to={editPath(r)}
            title="Edit"
            aria-label={`Edit ${r.description}`}
            className="tap flex h-9 w-9 min-h-0 min-w-0 items-center justify-center rounded-lg text-ink-500 transition hover:bg-paper-100 hover:text-ink-800"
          >
            <IconEdit className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={() => handleDelete(r)}
            title="Delete"
            aria-label={`Delete ${r.description}`}
            className="tap flex h-9 w-9 min-h-0 min-w-0 items-center justify-center rounded-lg text-ink-400 transition hover:bg-tint-danger hover:text-tone-danger"
          >
            <IconTrash className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  // ---------------------------------------------------------------
  // Filters, rendered inside the table's own header bar
  // ---------------------------------------------------------------
  // Previously a separate floating card above the table. Folding them in
  // means the search box, the filters, the column headers and the rows all
  // share one border and one left edge, so the eye follows a single column
  // down the page instead of stepping across three stacked boxes.
  const toolbar = (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-64">
          <label htmlFor="rec-search" className="mb-1 block text-xs font-medium text-ink-500">
            Search
          </label>
          <IconSearch
            aria-hidden
            className="pointer-events-none absolute left-3 top-[2.1rem] h-4 w-4 text-ink-400"
          />
          <TextInput
            id="rec-search"
            value={filters.keyword}
            onChange={(e) => setFilters((f) => ({ ...f, keyword: e.target.value }))}
            placeholder="Description contains…"
            className="pl-9 pr-3"
          />
        </div>

        <div>
          <label htmlFor="rec-type" className="mb-1 block text-xs font-medium text-ink-500">
            Type
          </label>
          <SelectInput
            id="rec-type"
            value={filters.type}
            onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as Filters["type"] }))}
            className="w-auto px-2"
          >
            <option value="all">All</option>
            <option value="expense">Expense</option>
            <option value="sales">Sales</option>
          </SelectInput>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="tap rounded-lg px-3 text-sm font-medium text-tone-brand transition hover:bg-tint-brand"
        >
          {showAdvanced ? "Fewer filters" : "More filters"}
          {advancedCount > 0 && !showAdvanced ? (
            <span className="ml-1.5 rounded-full bg-brand-600 px-1.5 text-xs text-white">
              {advancedCount}
            </span>
          ) : null}
        </button>

        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters(emptyFilters)}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {showAdvanced || advancedCount > 0 ? (
        <div className="mt-3 grid animate-slide-up gap-3 border-t border-paper-200 pt-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="rec-cat" className="mb-1 block text-xs font-medium text-ink-500">
              Category
            </label>
            <SelectInput
              id="rec-cat"
              value={filters.categoryId}
              onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value }))}
              disabled={filters.type === "sales"}
              className="px-2 disabled:bg-paper-100 disabled:text-ink-400"
            >
              <option value="">All</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectInput>
          </div>
          <div>
            <label htmlFor="rec-src" className="mb-1 block text-xs font-medium text-ink-500">
              Source
            </label>
            <SelectInput
              id="rec-src"
              value={filters.source}
              onChange={(e) => {
                const source = e.target.value as Filters["source"];
                // Switching away from CSV Upload leaves a chosen import
                // pointing at nothing the Source select still shows —
                // filtersFromParams enforces the same rule on a URL that
                // arrives with a stale combination, so this keeps state and
                // URL agreeing about when importBatchId is allowed to mean
                // anything.
                setFilters((f) => ({ ...f, source, importBatchId: source === "CSV_UPLOAD" ? f.importBatchId : "" }));
              }}
              className="px-2"
            >
              <option value="">All sources</option>
              {(Object.keys(RECORD_SOURCE_LABELS) as RecordSource[]).map((s) => (
                <option key={s} value={s}>
                  {RECORD_SOURCE_LABELS[s]}
                </option>
              ))}
            </SelectInput>
          </div>
          {filters.source === "CSV_UPLOAD" ? (
            <div>
              <label htmlFor="rec-batch" className="mb-1 block text-xs font-medium text-ink-500">
                Which import
              </label>
              <SelectInput
                id="rec-batch"
                value={filters.importBatchId}
                onChange={(e) => setFilters((f) => ({ ...f, importBatchId: e.target.value }))}
                className="px-2"
              >
                <option value="">All imports</option>
                {importBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} · {new Date(b.uploadDate).toLocaleDateString()}
                  </option>
                ))}
              </SelectInput>
            </div>
          ) : null}
          <div>
            <label htmlFor="rec-from" className="mb-1 block text-xs font-medium text-ink-500">
              From
            </label>
            <TextInput
              id="rec-from"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              className="px-2"
            />
          </div>
          <div>
            <label htmlFor="rec-to" className="mb-1 block text-xs font-medium text-ink-500">
              To
            </label>
            <TextInput
              id="rec-to"
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              className="px-2"
            />
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div>
      <PageHead
        eyebrow="Records management"
        title="Records"
        subtitle="Store, organise, and review every expense and sales reference record."
        actions={
          <>
            {flaggedCount > 0 ? (
              <Link
                to="/records/flagged"
                className="tap gap-2 rounded-xl border border-edge-accent bg-tint-accent px-3 text-sm font-semibold text-tone-accent transition hover:brightness-95"
              >
                Review flagged
                <Pill tone="warn">{flaggedCount}</Pill>
              </Link>
            ) : null}
            <Button variant="brand" size="sm" onClick={() => setAddExpenseOpen(true)}>
              + Add expense
            </Button>
          </>
        }
      />

      {/* The less-used create paths. Scrolls horizontally on phones rather
          than wrapping into rows that push the table off-screen. */}
      <div className="scroll-slim -mx-4 mb-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
        <div className="flex w-max gap-2">
          <Button variant="secondary" size="sm" onClick={() => setAddSalesOpen(true)}>
            + Add sales
          </Button>
          <ButtonLink to="/records/receipts/new" variant="secondary" size="sm">
            Scan receipt
          </ButtonLink>
          <ButtonLink to="/records/csv-imports/new" variant="secondary" size="sm">
            Import CSV
          </ButtonLink>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-xl bg-tint-danger px-3.5 py-3 text-sm text-tone-danger ring-1 ring-edge-danger">
          {error}
        </p>
      ) : null}

      <DataTable
        rows={records}
        columns={columns}
        getRowKey={(r) => `${r.type}-${r.id}`}
        loading={loading}
        caption={`Expense and sales reference records for ${selected.name}`}
        itemNoun="records"
        storageKey="records"
        initialSort={{ key: "date", direction: "desc" }}
        toolbar={toolbar}
        rowClassName={(r) =>
          highlightRecordId && r.type === "expense" && r.id === highlightRecordId ? "bg-tint-accent" : ""
        }
        empty={
          hasFilters ? (
            <EmptyState compact title="No records match these filters" icon="⌕">
              Try widening the date range or clearing the search box.
            </EmptyState>
          ) : (
            <EmptyState
              compact
              title="You haven't added any records yet"
              action={
                <>
                  <Button variant="primary" onClick={() => setAddExpenseOpen(true)}>
                    Add your first expense
                  </Button>
                  <ButtonLink to="/records/receipts/new" variant="secondary">
                    Or scan a receipt
                  </ButtonLink>
                </>
              }
            >
              Start with what you spent today — even one entry is enough for FinSight to begin showing
              you something.
            </EmptyState>
          )
        }
        mobileRow={(r) => {
          const status = recordStatus(r);
          return (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-900">{r.description}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
                    <span className="figure">{r.date.slice(0, 10)}</span>
                    <span aria-hidden>·</span>
                    <Tag kind={r.type === "expense" ? "expense" : "sales"} />
                    {r.type === "expense" ? <span>· {categoryName(r.categoryId)}</span> : null}
                    {r.vendor ? <span>· {r.vendor}</span> : null}
                  </p>
                </div>
                <p
                  className={`shrink-0 text-right font-medium ${
                    r.type === "expense" ? "text-ink-900" : "text-brand-700"
                  }`}
                >
                  <Money value={r.amount} />
                </p>
              </div>

              <div className="mt-2">
                <Pill tone={status.tone}>{status.label}</Pill>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-paper-200 pt-2">
                <span className="text-xs text-ink-400">
                  {RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source}
                </span>
                <div className="flex gap-1">
                  {r.duplicateStatus === "Flagged" ? (
                    <button
                      type="button"
                      onClick={() => setReviewDuplicate({ id: r.id, type: r.type })}
                      className="tap rounded-lg px-3 text-sm font-medium text-tone-info transition hover:bg-tint-info"
                    >
                      Compare
                      <span className="sr-only"> possible duplicate — {r.description}</span>
                    </button>
                  ) : null}
                  <Link
                    to={editPath(r)}
                    className="tap rounded-lg px-3 text-sm font-medium text-tone-brand transition hover:bg-tint-brand"
                  >
                    Edit
                    <span className="sr-only"> {r.description}</span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleDelete(r)}
                    className="tap rounded-lg px-3 text-sm font-medium text-ink-400 transition hover:bg-tint-danger hover:text-tone-danger"
                  >
                    Delete
                    <span className="sr-only"> {r.description}</span>
                  </button>
                </div>
              </div>
            </div>
          );
        }}
      />

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => loadRecords(undefined, nextCursor)} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more records"}
          </Button>
        </div>
      ) : null}

      <AddExpenseModal
        businessProfileId={selected.id}
        open={addExpenseOpen}
        onClose={() => setAddExpenseOpen(false)}
        onSaved={() => {
          loadRecords();
          loadFlaggedCount();
        }}
      />
      <AddSalesModal
        businessProfileId={selected.id}
        open={addSalesOpen}
        onClose={() => setAddSalesOpen(false)}
        onSaved={() => {
          loadRecords();
          loadFlaggedCount();
        }}
      />
      <DuplicateReviewModal
        recordId={reviewDuplicate?.id ?? null}
        recordType={reviewDuplicate?.type ?? "expense"}
        open={reviewDuplicate !== null}
        onClose={() => setReviewDuplicate(null)}
        onResolved={() => {
          loadRecords();
          loadFlaggedCount();
        }}
      />
    </div>
  );
}
