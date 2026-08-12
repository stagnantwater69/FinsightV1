import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCategoricalPalette } from "../lib/useChartPalette";
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

export function CategoryBreakdownChart({ breakdown }: { breakdown: DashboardSummary["expenseCategoryBreakdown"] }) {
  const narrow = useIsNarrow();
  const palette = useCategoricalPalette();

  if (breakdown.length === 0) {
    return (
      <EmptyState compact title="No expenses in this period yet" icon="◔">
        Once you record an expense, this is where you'll see which categories use the most.
      </EmptyState>
    );
  }

  const data = breakdown.map((c) => ({
    name: c.categoryName,
    total: c.total,
    label: `${formatMoney(c.total)} (${c.percent.toFixed(1)}%)`,
  }));

  return (
    // `text-ink-500` on the wrapper is load-bearing, not decoration: the axis
    // labels below are drawn with `currentColor` and inherit it. Recharts sets
    // `fill` as an SVG presentation attribute, where `rgb(var(--ink-500))`
    // would not resolve — `currentColor` does, and follows the theme.
    <div className="min-w-0 text-ink-500">
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
  );
}
