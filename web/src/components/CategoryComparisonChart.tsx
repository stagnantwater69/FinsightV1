import { useState } from "react";
import { formatMoney } from "./Money";
import { ChartTooltip } from "./ChartTooltip";
import type { CategoryTrend } from "../lib/types";
import { ListDisclosureControl, useListDisclosure } from "./ListDisclosure";

/**
 * This period vs the previous one, per category.
 *
 * FORM. The job is "did this go up or down, and by how much". One series is
 * the point and the other is context, so it is drawn as a bullet: the current
 * period is a filled bar on a track, the previous period a dark tick on that
 * same track. Up or down is then read as the bar passing or stopping short of
 * its tick, and the chip at the end says by how much. Expenses only, so an
 * increase is shown in the danger tone and a decrease in brand. Horizontal
 * because category names are words.
 *
 * SCALE. Every row is measured against ONE maximum across both periods, not
 * per-row. A per-row scale would draw a PHP 400 category and a PHP 40,000 one
 * as the same length, which is the most common way a chart like this lies.
 *
 * LABELS. The current value is direct-labelled on every row. That is what
 * makes the chart readable without relying on bar length or colour, and it is
 * the relief the palette's contrast check requires.
 */

/** Bars shorter than this still show, so "almost nothing" doesn't read as nothing. */
const MIN_BAR_PERCENT = 1.5;

export function CategoryComparisonChart({
  trends,
  previousLabel = "Last period",
  currentLabel = "This period",
  resetKey,
}: {
  trends: CategoryTrend[];
  previousLabel?: string;
  currentLabel?: string;
  resetKey?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const rows = trends.filter((t) => t.current > 0 || t.previous > 0);
  const disclosure = useListDisclosure({ total: rows.length, resetKey });
  if (rows.length === 0) return null;

  const max = Math.max(...rows.map((t) => Math.max(t.current, t.previous)), 1);
  const width = (value: number) =>
    value <= 0 ? 0 : Math.max((value / max) * 100, MIN_BAR_PERCENT);

  return (
    <div>
      {/* Two series, so a legend is mandatory: identity is never colour
          alone. The previous period is a tick on the same track as the bar,
          so "did it go up or down" is read as the bar passing or falling
          short of its tick. */}
      <div className="mb-4 flex flex-wrap items-center justify-end gap-4 text-[11.5px] text-ink-500">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-4 rounded-full" style={{ background: "linear-gradient(90deg, rgb(var(--chart-emphasis) / 0.55), rgb(var(--chart-emphasis)))" }} />
          {currentLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 rounded-full bg-ink-700" />
          {previousLabel}
        </span>
      </div>

      <ul id={disclosure.contentId} className="space-y-3">
        {rows.slice(0, disclosure.visibleCount).map((t) => {
          const isUp = t.change > 0;
          const isDown = t.change < 0;
          const active = hovered === t.categoryId;
          const dimmed = hovered !== null && !active;

          return (
            <li
              key={t.categoryId}
              className={`relative grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[minmax(4.5rem,7rem)_1fr_8.75rem] sm:gap-3 rounded-lg px-1 py-0.5 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-brand-500 ${dimmed ? "opacity-50" : ""}`}
              onMouseEnter={() => setHovered(t.categoryId)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(t.categoryId)}
              onBlur={() => setHovered(null)}
              tabIndex={0}
            >
              <span className="truncate text-[12.5px] font-medium text-ink-700" title={t.categoryName}>
                {t.categoryName}
              </span>

              <span aria-hidden className="relative h-3 min-w-0 rounded-full bg-paper-200">
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    width: `${width(t.current)}%`,
                    background: "linear-gradient(90deg, rgb(var(--chart-emphasis) / 0.55), rgb(var(--chart-emphasis)))",
                    boxShadow: active ? "0 0 0 2px rgb(var(--chart-emphasis) / 0.25)" : undefined,
                  }}
                />
                {t.previous > 0 ? (
                  <span
                    className="absolute -top-1 h-5 w-0.5 -translate-x-1/2 rounded-full bg-ink-700"
                    style={{ left: `${width(t.previous)}%` }}
                  />
                ) : null}
              </span>

              <span className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:justify-end">
                <span className="figure whitespace-nowrap text-[12.5px] font-semibold text-ink-900">{formatMoney(t.current)}</span>
                <span
                  className={`figure inline-flex min-w-[3.25rem] justify-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
                    isUp ? "bg-tint-danger text-tone-danger" : isDown ? "bg-tint-brand text-tone-brand" : "bg-tint-neutral text-tone-neutral"
                  }`}
                  aria-hidden
                >
                  {isUp ? "▲" : isDown ? "▼" : "="}
                  {t.percentChange !== null && t.previous > 0
                    ? ` ${Math.abs(t.percentChange).toFixed(0)}%`
                    : t.previous === 0 && t.current > 0
                      ? " new"
                      : ""}
                </span>
              </span>

              {/* Hover detail: the two amounts behind the bar and its tick. */}
              {active ? (
                <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-20 mt-1">
                  <ChartTooltip
                    title={t.categoryName}
                    rows={[
                      { label: currentLabel, value: formatMoney(t.current), color: "rgb(var(--chart-emphasis))" },
                      { label: previousLabel, value: formatMoney(t.previous), color: "rgb(var(--ink-700))" },
                      {
                        label: "Change",
                        value: `${isUp ? "+" : isDown ? "−" : ""}${formatMoney(Math.abs(t.change))}`,
                        strong: true,
                      },
                    ]}
                  />
                </span>
              ) : null}

              {/* The same reading, for anyone not using a pointer. */}
              <span className="sr-only">
                {t.categoryName}: {formatMoney(t.current)} this period, {formatMoney(t.previous)} last
                period,{" "}
                {isUp
                  ? `up ${formatMoney(t.change)}`
                  : isDown
                    ? `down ${formatMoney(Math.abs(t.change))}`
                    : "unchanged"}
                .
              </span>
            </li>
          );
        })}
      </ul>
      <ListDisclosureControl disclosure={disclosure} total={rows.length} itemLabel="categories" className="mt-3" />
    </div>
  );
}
