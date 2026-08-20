import { useEffect, useId, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCategoricalPalette } from "../lib/useChartPalette";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { formatMoney } from "./Money";
import type { DashboardSummary } from "../lib/types";

/**
 * Category spend, largest first.
 *
 * Responsive detail that matters: the category-name axis and the value labels
 * both need horizontal room, and at 320px there isn't enough for both. Below
 * `sm` the axis narrows and the value label is dropped from the bar (it stays
 * available in the tooltip and in the figure list beneath), rather than letting
 * the two collide into unreadable overlap.
 *
 * Mount animation stays off: under headless Chrome's virtual clock it never
 * completes and the bars render invisible, and for a panel that re-fetches on
 * every period change a re-animating chart is noise anyway.
 *
 * Long tail: one row per category turns a 13-category business into a ~570px
 * tower where the last few bars are rounding error next to the first. Only the
 * top `topN` are drawn by default, with the rest a click away — the same call
 * the donut above already makes when it folds the tail into "Other (n)". The
 * chart's height is derived from the visible row count, so collapsing shrinks
 * it; that resize is deliberately instant rather than transitioned, because
 * animating a container height is the layout-thrashing case `index.css` warns
 * about, and there is nothing to gate behind prefers-reduced-motion.
 */
function useIsNarrow(breakpoint = 640) {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return narrow;
}

export interface CategoryRow {
  name: string;
  total: number;
  label: string;
}

/**
 * Rows to draw, largest first. Sorting here rather than trusting the payload's
 * order is what makes "top 5" mean the five biggest — and it matches how the
 * donut assigns colour by RANK, so a category keeps the same hue in both.
 */
export function toRows(
  breakdown: DashboardSummary["expenseCategoryBreakdown"],
  topN: number,
  expanded: boolean
): CategoryRow[] {
  const ranked = [...breakdown]
    .sort((a, b) => b.total - a.total)
    .map((c) => ({
      name: c.categoryName,
      total: c.total,
      label: `${formatMoney(c.total)} (${c.percent.toFixed(1)}%)`,
    }));
  return expanded ? ranked : ranked.slice(0, topN);
}

export function CategoryBreakdownChart({
  breakdown,
  topN = 5,
}: {
  breakdown: DashboardSummary["expenseCategoryBreakdown"];
  /** Rows shown before the reveal. Below this many categories there is no toggle. */
  topN?: number;
}) {
  const narrow = useIsNarrow();
  const palette = useCategoricalPalette();
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  if (breakdown.length === 0) {
    return (
      <EmptyState compact title="No expenses in this period yet" icon="◔">
        Once you record an expense, this is where you'll see which categories use the most.
      </EmptyState>
    );
  }

  const data = toRows(breakdown, topN, expanded);
  const hidden = breakdown.length - topN;

  return (
    // `text-ink-500` on the wrapper is load-bearing, not decoration: the axis
    // labels below are drawn with `currentColor` and inherit it. Recharts sets
    // `fill` as an SVG presentation attribute, where `rgb(var(--ink-500))`
    // would not resolve — `currentColor` does, and follows the theme.
    <div className="min-w-0 text-ink-500">
      <div id={regionId}>
        <ResponsiveContainer width="100%" height={Math.max(120, data.length * 44)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: narrow ? 8 : 96, left: 0, bottom: 4 }}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={narrow ? 82 : 110}
              tick={{ fontSize: 11, fill: "currentColor" }}
              axisLine={{ stroke: "currentColor", opacity: 0.35 }}
              tickLine={false}
            />
            <Tooltip
              formatter={(_v, _n, item) => [item.payload.label, item.payload.name]}
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                fontFamily: "IBM Plex Mono, monospace",
                background: "rgb(var(--paper))",
                border: "1px solid rgb(var(--paper-200))",
                color: "rgb(var(--ink-900))",
              }}
              itemStyle={{ color: "rgb(var(--ink-900))" }}
              labelStyle={{ color: "rgb(var(--ink-600))" }}
            />
            <Bar
              dataKey="total"
              radius={[0, 4, 4, 0]}
              maxBarSize={26}
              isAnimationActive={false}
              label={
                narrow
                  ? false
                  : {
                      position: "right",
                      fontSize: 11,
                      fill: "currentColor",
                      fontFamily: "IBM Plex Mono, monospace",
                      formatter: (v: unknown) => formatMoney(Number(v)),
                    }
              }
            >
              {data.map((_entry, index) => (
                <Cell key={index} fill={palette[index % palette.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* On narrow screens the bar labels are dropped, so the figures are
            listed here instead — the numbers stay available without a tooltip,
            which is not reachable by touch anyway. */}
        {narrow ? (
          <ul className="mt-2 space-y-1 border-t border-paper-200 pt-2">
            {data.map((d, i) => (
              <li key={d.name} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: palette[i % palette.length] }}
                  />
                  <span className="truncate text-ink-600">{d.name}</span>
                </span>
                <span className="figure shrink-0 text-ink-800">{formatMoney(d.total)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {hidden > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-center text-xs"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? `Show top ${topN} only` : `Show all ${breakdown.length} categories`}
        </Button>
      ) : null}
    </div>
  );
}
