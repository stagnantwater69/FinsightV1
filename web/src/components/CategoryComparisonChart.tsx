import { useState } from "react";
import { formatMoney } from "./Money";
import type { CategoryTrend } from "../lib/types";

/**
 * This period vs the previous one, per category.
 *
 * FORM. The job is "did this go up or down, and by how much" — one series is
 * the point and the other is context. So this is emphasis, not identity: the
 * current period takes a single hue and the previous period a recessive grey,
 * rather than two colours competing for attention. Horizontal bars because
 * category names are words, and words fit along a horizontal axis without
 * being rotated.
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
}: {
  trends: CategoryTrend[];
  previousLabel?: string;
  currentLabel?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const rows = trends.filter((t) => t.current > 0 || t.previous > 0);
  if (rows.length === 0) return null;

  const max = Math.max(...rows.map((t) => Math.max(t.current, t.previous)), 1);
  const width = (value: number) =>
    value <= 0 ? 0 : Math.max((value / max) * 100, MIN_BAR_PERCENT);

  return (
    <div>
      {/* Two series, so a legend is mandatory — identity is never colour
          alone. */}
      <div className="mb-4 flex flex-wrap items-center justify-end gap-4 text-[11.5px] text-ink-500">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: "rgb(var(--chart-emphasis))" }}
          />
          {currentLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: "rgb(var(--chart-muted))" }}
          />
          {previousLabel}
        </span>
      </div>

      <ul className="space-y-3.5">
        {rows.map((t) => {
          const isUp = t.change > 0;
          const isDown = t.change < 0;
          const active = hovered === t.categoryId;

          return (
            <li
              key={t.categoryId}
              className="relative grid grid-cols-[minmax(4.5rem,7rem)_1fr_auto] items-center gap-3"
              onMouseEnter={() => setHovered(t.categoryId)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(t.categoryId)}
              onBlur={() => setHovered(null)}
              tabIndex={0}
            >
              <span className="truncate text-[12.5px] text-ink-600" title={t.categoryName}>
                {t.categoryName}
              </span>

              {/* The two bars. 2px of surface between them so adjacent fills
                  stay visually separate, and rounded right ends anchored to a
                  common left baseline. */}
              <span className="flex min-w-0 flex-col gap-[2px]">
                <span
                  className="h-3 rounded-r transition-[width,filter] duration-500 ease-out"
                  style={{
                    width: `${width(t.current)}%`,
                    background: "rgb(var(--chart-emphasis))",
                    filter: active ? "brightness(1.12)" : undefined,
                  }}
                />
                <span
                  className="h-2 rounded-r transition-[width] duration-500 ease-out"
                  style={{ width: `${width(t.previous)}%`, background: "rgb(var(--chart-muted))" }}
                />
              </span>

              <span className="figure shrink-0 text-right text-[12.5px] font-semibold text-ink-900">
                {formatMoney(t.current)}
              </span>

              {/* Hover detail. The bars answer "how big"; this answers "by how
                  much did it move", which is the whole reason both periods are
                  on screen. */}
              {active ? (
                <span
                  role="tooltip"
                  className="pointer-events-none absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded-lg bg-ink-900 px-2.5 py-1.5 text-[11.5px] font-medium text-paper shadow-md"
                >
                  <span className="figure">{formatMoney(t.previous)}</span> →{" "}
                  <span className="figure">{formatMoney(t.current)}</span>
                  {t.previous > 0 || t.current > 0 ? (
                    <span className="ml-1.5 opacity-80">
                      {isUp ? "▲" : isDown ? "▼" : "—"}{" "}
                      <span className="figure">{formatMoney(Math.abs(t.change))}</span>
                      {t.percentChange !== null && t.previous > 0
                        ? ` (${Math.abs(t.percentChange).toFixed(0)}%)`
                        : " (new)"}
                    </span>
                  ) : null}
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
    </div>
  );
}
