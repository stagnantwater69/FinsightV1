import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { useDebounced } from "../lib/hooks";
import { Money } from "./Money";
import { IconSearch } from "./icons";
import type { RecordItem } from "../lib/types";

/**
 * Global search — one field that reaches everything.
 *
 * Two sources, on purpose:
 *
 *   Local, instant — destinations (every page in the app), expense
 *   categories, and business profiles. These are already in memory, so they
 *   answer on the keystroke with no spinner and no round trip.
 *
 *   Remote, debounced — expense and sales records, through the same
 *   /records/search the Records page uses. There can be tens of thousands of
 *   them, so they cannot be held client-side, and they are the one source
 *   worth waiting ~200ms for.
 *
 * Local results are never blocked on the remote fetch. Typing "rec" surfaces
 * the Recovery Target page immediately while matching records are still in
 * flight — the alternative, holding everything back for the slowest source,
 * makes the whole field feel broken.
 *
 * Modelled as a combobox: the input keeps focus and owns the arrow keys, so
 * you can type, arrow to a result and hit Enter without leaving the keyboard.
 */

interface Destination {
  label: string;
  to: string;
  section: string;
  keywords: string;
}

/**
 * Every navigable destination, including the ones with no dedicated nav item.
 * Search is how people find the settings and sub-pages they can't see, so the
 * keyword lists carry the words someone would actually type ("dark mode",
 * "duplicates", "password") rather than only the page's own title.
 */
const DESTINATIONS: Destination[] = [
  { label: "Dashboard", to: "/dashboard", section: "Overview", keywords: "home summary overview alerts funds" },
  { label: "Records", to: "/records", section: "Overview", keywords: "expenses sales list table history" },
  { label: "Ask FinSight", to: "/ai-chat", section: "Overview", keywords: "ai chat assistant conversation ask question explain history" },
  { label: "Expense insight", to: "/insights/expense-behavior", section: "Insights", keywords: "expense behaviour trends categories unusual anomaly spending patterns where money went daily chart" },
  { label: "Spending impact", to: "/insights/spending-impact", section: "Insights", keywords: "simulate what if afford purchase plan impact" },
  { label: "Recovery target", to: "/insights/recovery", section: "Insights", keywords: "daily target sales goal month coverage break even" },
  { label: "Add expense", to: "/records/expenses/new", section: "Actions", keywords: "new create spend cost" },
  { label: "Add sales reference", to: "/records/sales/new", section: "Actions", keywords: "new create revenue income takings" },
  { label: "Scan receipt", to: "/records/receipts/new", section: "Actions", keywords: "ocr photo camera capture" },
  { label: "Import CSV", to: "/records/csv-imports/new", section: "Actions", keywords: "upload spreadsheet excel bulk import file" },
  { label: "Add recurring payment", to: "/insights/recurring-schedules/new", section: "Actions", keywords: "recurring repeat schedule monthly weekly rent salary bill subscription due watch" },
  { label: "Needs review", to: "/records/flagged", section: "Actions", keywords: "flagged duplicates needs review large expense unusual scan issue findings queue" },
  { label: "Expense categories", to: "/records/categories", section: "Management", keywords: "category tags groups organise rent supplies" },
  { label: "Business profile", to: "/business-profiles", section: "Management", keywords: "business shop branch company funds expenses operating days threshold" },
  { label: "All businesses", to: "/business-profiles/all", section: "Management", keywords: "business shop branch switch archive company list compare" },
  { label: "Add business profile", to: "/business-profiles/new", section: "Management", keywords: "new business create shop branch" },
  { label: "My profile", to: "/profile", section: "Account", keywords: "account settings name email phone password personal details" },
  { label: "Notifications", to: "/notifications", section: "Account", keywords: "alerts bell unread messages announcements" },
];

interface Result {
  id: string;
  label: string;
  meta?: string;
  trailing?: React.ReactNode;
  section: string;
  to: string;
}

function matches(haystack: string, needle: string) {
  return haystack.toLowerCase().includes(needle);
}

export function GlobalSearch({ className = "" }: { className?: string }) {
  const navigate = useNavigate();
  const { profiles, selected, selectProfile } = useBusinessProfiles();
  const { categories } = useExpenseCategories();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [searching, setSearching] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, 220);

  // ---- remote: records ----
  useEffect(() => {
    if (!selected || debounced.length < 2) {
      setRecords([]);
      setSearching(false);
      return;
    }
    // AbortController rather than a "is this still the latest?" flag: it also
    // stops the browser holding open a request whose answer is already stale.
    const controller = new AbortController();
    setSearching(true);
    api
      .get<{ items: RecordItem[]; nextCursor: string | null }>("/records/search", {
        params: { businessProfileId: selected.id, type: "all", keyword: debounced, limit: 6 },
        signal: controller.signal,
      })
      .then(({ data }) => setRecords(data.items))
      .catch(() => {
        // A failed record search shouldn't blank the local results that are
        // already on screen and already useful.
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [debounced, selected]);

  // ---- assemble ----
  const results = useMemo<Result[]>(() => {
    const q = trimmed.toLowerCase();
    if (!q) return [];
    const out: Result[] = [];

    for (const d of DESTINATIONS) {
      if (matches(d.label, q) || matches(d.keywords, q)) {
        out.push({ id: `nav:${d.to}`, label: d.label, section: d.section, to: d.to, meta: "Go to page" });
      }
    }

    for (const c of categories) {
      if (matches(c.name, q)) {
        out.push({
          id: `cat:${c.id}`,
          label: c.name,
          section: "Expense categories",
          // Deep-links into Records already filtered to the category, which
          // is what someone searching a category name actually wants to see.
          to: `/records?categoryId=${c.id}&type=expense`,
          meta: "View its records",
        });
      }
    }

    for (const p of profiles) {
      if (matches(p.name, q) || matches(p.type, q)) {
        out.push({
          id: `biz:${p.id}`,
          label: p.name,
          section: "Business profiles",
          to: `/business-profiles`,
          meta: p.id === selected?.id ? `${p.type} · active` : `${p.type} · switch to this`,
        });
      }
    }

    for (const r of records) {
      out.push({
        id: `rec:${r.type}:${r.id}`,
        label: r.description,
        section: "Records",
        to: r.type === "expense" ? `/records/expenses/${r.id}/edit` : `/records/sales/${r.id}/edit`,
        meta: `${r.date.slice(0, 10)} · ${r.type === "expense" ? "Expense" : "Sales ref."}`,
        trailing: <Money value={r.amount} />,
      });
    }

    return out.slice(0, 24);
  }, [trimmed, categories, profiles, records, selected?.id]);

  // Reset the highlight whenever the result set changes, so Enter can never
  // fire whatever happened to be at the old index.
  useEffect(() => setActiveIndex(0), [results.length, trimmed]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  // ---- Cmd/Ctrl+K, and "/" when not already typing ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, []);

  function go(result: Result) {
    // Selecting a business from search switches to it as well as navigating —
    // otherwise you land on a list where the thing you searched for is merely
    // one of several rows, having done nothing.
    if (result.id.startsWith("biz:")) {
      selectProfile(Number(result.id.slice(4)));
    }
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    navigate(result.to);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (query) setQuery("");
      else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (!open || results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) go(chosen);
    }
  }

  const showPanel = open && trimmed.length > 0;
  const listboxId = "global-search-results";

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className="relative">
        <IconSearch
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && results[activeIndex] ? `gs-${activeIndex}` : undefined}
          aria-label="Search FinSight"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search records, categories, pages…"
          className="min-h-tap w-full rounded-xl border border-paper-200 bg-paper-100 pl-9 pr-16 text-sm text-ink-900 transition placeholder:text-ink-400 hover:border-brand-300 focus:bg-paper"
        />
        {/* The shortcut hint. Hidden on touch, where there is no keyboard to
            press it with and it would just be a mystery label. */}
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded-md border border-paper-200 bg-paper px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-ink-400 lg:block">
          ⌘K
        </kbd>
      </div>

      {showPanel ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 animate-pop-down overflow-hidden rounded-2xl border border-paper-200 bg-paper shadow-lg">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-500">
              {searching ? "Searching…" : <>Nothing matches “{trimmed}”.</>}
            </p>
          ) : (
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label="Search results"
              className="scroll-slim max-h-[24rem] overflow-y-auto p-1.5"
            >
              {results.map((result, index) => {
                const showSection = index === 0 || results[index - 1]!.section !== result.section;
                const active = index === activeIndex;
                return (
                  <li key={result.id}>
                    {showSection ? (
                      <div
                        role="presentation"
                        className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-400"
                      >
                        {result.section}
                      </div>
                    ) : null}
                    <div
                      id={`gs-${index}`}
                      role="option"
                      aria-selected={active}
                      data-index={index}
                      // Pointer, not focus: focus stays in the input so the
                      // arrow keys keep working while you scan the list.
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(e) => {
                        // Fires before blur would close the panel.
                        e.preventDefault();
                        go(result);
                      }}
                      className={`flex min-h-tap cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition ${
                        active ? "bg-tint-brand" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium text-ink-900">
                          {result.label}
                        </span>
                        {result.meta ? (
                          <span className="block truncate text-[11.5px] text-ink-500">{result.meta}</span>
                        ) : null}
                      </span>
                      {result.trailing ? (
                        <span className="shrink-0 text-[13px] font-medium text-ink-700">
                          {result.trailing}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-3 border-t border-paper-200 bg-paper-100 px-3 py-2 text-[11px] text-ink-400">
            <span>
              <b className="font-semibold text-ink-500">↑↓</b> to move
            </span>
            <span>
              <b className="font-semibold text-ink-500">↵</b> to open
            </span>
            <span>
              <b className="font-semibold text-ink-500">esc</b> to close
            </span>
            {searching ? <span className="ml-auto">Searching records…</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
