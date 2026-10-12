import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useReportingPeriod } from "../context/ReportingPeriodContext";
import { useDismiss } from "../lib/hooks";
import { ALL_TIME, THIS_WEEK, monthLabel } from "../lib/reportingPeriod";
import { IconChevronDown } from "./icons";

// ink-400-ok: an inactive, aria-hidden grid cell (WCAG 1.4.3 exempts inactive components).
const UNAVAILABLE_MONTH = "flex h-10 items-center justify-center rounded-lg text-[13px] text-ink-400/60";

const MONTH_NUMBERS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

/** "2026-09" as "Sep". UTC for the same reason as monthLabel. */
function shortMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * This week | Month ▾ | All time, with All time optional for bounded views.
 *
 * The Month choice opens a picker laid out like a calendar: one row of twelve
 * months per year, newest year first. Only the months this business has
 * records in can be picked; the rest stay in place, dimmed, so the grid keeps
 * its shape and a gap reads as "nothing recorded" rather than as a missing
 * row. Once one is picked, the segment reads as that month ("September
 * 2026 ▾").
 */
export function PeriodFilter({
  className = "",
  showAllTime = true,
}: {
  className?: string;
  /** Recovery planning has no meaningful all-time target. */
  showAllTime?: boolean;
}) {
  const { selection, setSelection, months, monthsState, refreshMonths } =
    useReportingPeriod();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { ref, triggerRef } = useDismiss(open, close);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // A shared selection can arrive from another screen. Do not leave a hidden
  // All time choice active, and do not let its unsupported query escape.
  const visibleSelection =
    !showAllTime && selection.kind === "all" ? THIS_WEEK : selection;
  useEffect(() => {
    if (!showAllTime && selection.kind === "all") setSelection(THIS_WEEK);
  }, [selection, setSelection, showAllTime]);

  const monthActive = visibleSelection.kind === "month";
  const activeMonth = monthActive ? visibleSelection.month : null;
  const options =
    activeMonth && !months.includes(activeMonth) ? [activeMonth, ...months] : months;
  const noMonths = options.length === 0;
  const available = new Set(options);
  const years = [...new Set(options.map((month) => month.slice(0, 4)))].sort().reverse();

  useEffect(() => {
    if (noMonths) setOpen(false);
  }, [noMonths]);

  // Opening lands focus on the chosen month, or the newest one, so arrow keys
  // start from where the owner already is.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const target =
      list?.querySelector<HTMLElement>("[role='option'][aria-selected='true']") ??
      list?.querySelector<HTMLElement>("[role='option']");
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  const choose = (month: string) => {
    setSelection({ kind: "month", month });
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Arrows move through the grid as it is drawn: left/right by one month,
  // up/down by a year, skipping months that cannot be picked.
  const onGridKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 };
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='option']"),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Tab") {
      setOpen(false);
      return;
    } else if (event.key in steps && current >= 0) {
      // Positions in the drawn grid: year row from the top, month column.
      const position = (el: HTMLElement) => Number(el.dataset.position);
      const want = position(items[current]!) + steps[event.key]!;
      const direction = Math.sign(steps[event.key]!);
      next =
        items.find((el) => position(el) === want) ??
        (direction > 0
          ? items.find((el) => position(el) > want)
          : [...items].reverse().find((el) => position(el) < want));
    } else return;
    event.preventDefault();
    next?.focus();
  };

  const emptyTitle =
    monthsState === "loading"
      ? "Loading months"
      : monthsState === "error"
        ? "Couldn't load months"
        : "No months with records yet";

  return (
    <div ref={ref} className={`relative flex w-fit flex-col items-end gap-1 ${className}`}>
      <div
        role="group"
        aria-label="Period"
        className="flex flex-wrap gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1"
      >
        <Segment
          active={visibleSelection.kind === "week"}
          onClick={() => setSelection(THIS_WEEK)}
        >
          This week
        </Segment>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-label="Month"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={noMonths}
          title={noMonths ? emptyTitle : undefined}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={`tap gap-1.5 rounded-lg pl-3 pr-2.5 text-[13.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
            monthActive ? "bg-paper text-tone-brand shadow-sm" : "text-ink-600 hover:text-tone-brand"
          }`}
        >
          {activeMonth ? monthLabel(activeMonth) : "Month"}
          <IconChevronDown
            className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""} ${monthActive ? "text-tone-brand" : "text-ink-500"}`}
          />
        </button>
        {showAllTime ? (
          <Segment
            active={visibleSelection.kind === "all"}
            onClick={() => setSelection(ALL_TIME)}
          >
            All time
          </Segment>
        ) : null}
      </div>

      {open ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Months with records"
          onKeyDown={onGridKeys}
          className="scroll-slim absolute right-0 top-full z-50 mt-2 max-h-[22rem] w-[19rem] max-w-[calc(100vw-2rem)] animate-pop-down overflow-y-auto rounded-2xl border border-paper-200 bg-paper p-2 shadow-lg"
        >
          {years.map((year, yearIndex) => (
            <div key={year} role="group" aria-label={year} className="pb-1">
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-paper px-2 pb-1.5 pt-2">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-500">
                  {year}
                </span>
                <span aria-hidden className="h-px flex-1 bg-paper-200" />
              </div>
              <div className="grid grid-cols-4 gap-1">
                {MONTH_NUMBERS.map((monthNumber, column) => {
                  const month = `${year}-${monthNumber}`;
                  if (!available.has(month)) {
                    return (
                      <span
                        key={month}
                        aria-hidden
                        className={UNAVAILABLE_MONTH}
                      >
                        {shortMonth(month)}
                      </span>
                    );
                  }
                  const selected = month === activeMonth;
                  return (
                    <button
                      key={month}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-label={monthLabel(month)}
                      tabIndex={-1}
                      data-position={yearIndex * 12 + column}
                      onClick={() => choose(month)}
                      className={`flex h-10 items-center justify-center rounded-lg text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        selected
                          ? "bg-brand-600 text-white shadow-sm"
                          : "text-ink-800 hover:bg-tint-brand hover:text-tone-brand focus-visible:bg-tint-brand"
                      }`}
                    >
                      {shortMonth(month)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {monthsState === "error" ? (
        <p role="alert" className="text-xs text-tone-danger">
          {months.length > 0
            ? "Month list may be out of date."
            : "Couldn't load months."}{" "}
          <button
            type="button"
            aria-label="Retry loading months"
            className="tap-inline font-semibold underline decoration-current/40 underline-offset-2 hover:decoration-current"
            onClick={refreshMonths}
          >
            Retry
          </button>
        </p>
      ) : null}
    </div>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`tap rounded-lg px-3 text-[13.5px] font-semibold transition ${
        active ? "bg-paper text-tone-brand shadow-sm" : "text-ink-600 hover:text-tone-brand"
      }`}
    >
      {children}
    </button>
  );
}
