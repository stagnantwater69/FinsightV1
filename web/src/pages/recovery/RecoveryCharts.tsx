import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "../../components/Money";
import { ChartTooltip } from "../../components/ChartTooltip";
import type { DailyCoverageRow } from "../../lib/types";
import { shortDay, type CumulativePoint } from "./recoverySeries";
export { ProgressRing } from "../../components/MiniCharts";

/**
 * The Recovery Target page's charts. Every figure here is read from the
 * server's recovery payload; the only arithmetic is running totals and the
 * straight-line target estimate for days the server has not reported yet,
 * which is labelled as an estimate wherever it shows.
 */

const SALES_COLOR = "rgb(var(--chart-emphasis))";
// The target is a reference, not a second measure, so it is drawn in ink
// rather than a second hue: one coloured series per chart.
const TARGET_COLOR = "rgb(var(--ink-500))";

function axisMoney(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

function tickInterval(count: number) {
  if (count <= 8) return 0;
  return Math.ceil(count / 8) - 1;
}

function LegendSwatch({ dashed = false, color }: { dashed?: boolean; color: string }) {
  return (
    <svg aria-hidden width="18" height="8" className="shrink-0">
      <line
        x1="1"
        x2="17"
        y1="4"
        y2="4"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={dashed ? "4 3" : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChartLegend({ targetLabel }: { targetLabel: string }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600">
      <li className="flex items-center gap-1.5">
        <LegendSwatch color={SALES_COLOR} />
        Sales recorded
      </li>
      <li className="flex items-center gap-1.5">
        <LegendSwatch color={TARGET_COLOR} dashed />
        {targetLabel}
      </li>
    </ul>
  );
}

function CumulativeTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: CumulativePoint }[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <ChartTooltip
      title={shortDay(point.date)}
      rows={[
        { label: "Sales so far", value: point.sales === null ? "Not yet" : formatMoney(point.sales), color: SALES_COLOR },
        { label: point.estimated ? "Target by then (est.)" : "Target by then", value: formatMoney(point.target), color: TARGET_COLOR },
      ]}
    />
  );
}

/** Running sales against the running target for the selected period. */
export function CumulativeSalesChart({ points }: { points: CumulativePoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-ink-500">
        No days recorded in this period yet.
      </p>
    );
  }
  const hasEstimate = points.some((p) => p.estimated);
  return (
    <div>
      <ChartLegend targetLabel={hasEstimate ? "Target pace (later days estimated)" : "Target pace"} />
      <div className="mt-3 min-w-0 text-ink-500">
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="recoverySalesFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SALES_COLOR} stopOpacity={0.42} />
                <stop offset="100%" stopColor={SALES_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={shortDay}
              interval={tickInterval(points.length)}
              tick={{ fontSize: 10.5, fill: "currentColor" }}
              axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              tickLine={false}
              minTickGap={4}
            />
            <YAxis
              tick={{ fontSize: 10.5, fill: "currentColor" }}
              axisLine={false}
              tickLine={false}
              width={48}
              tickFormatter={axisMoney}
            />
            <Tooltip
              content={<CumulativeTooltip />}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.35, strokeWidth: 1 }}
            />
            <Line
              type="linear"
              dataKey="target"
              stroke={TARGET_COLOR}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "rgb(var(--paper))" }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="sales"
              stroke={SALES_COLOR}
              strokeWidth={2}
              fill="url(#recoverySalesFill)"
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "rgb(var(--paper))" }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Bars of each recorded day's sales, with that day's allocated target as a step line. */
export function DailySalesChart({ rows }: { rows: DailyCoverageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-ink-500">
        No days recorded in this period yet.
      </p>
    );
  }
  const data = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div>
      <ChartLegend targetLabel="Allocated target" />
      <div className="mt-3 min-w-0 text-ink-500">
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={shortDay}
              interval={tickInterval(data.length)}
              tick={{ fontSize: 10.5, fill: "currentColor" }}
              axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              tickLine={false}
              minTickGap={4}
            />
            <YAxis
              tick={{ fontSize: 10.5, fill: "currentColor" }}
              axisLine={false}
              tickLine={false}
              width={48}
              tickFormatter={axisMoney}
            />
            <Tooltip
              content={<DayTooltip />}
              cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
            />
            <defs>
              <linearGradient id="recoveryDayBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SALES_COLOR} stopOpacity={1} />
                <stop offset="100%" stopColor={SALES_COLOR} stopOpacity={0.5} />
              </linearGradient>
            </defs>
            <Bar
              dataKey="sales"
              fill="url(#recoveryDayBar)"
              radius={[5, 5, 0, 0]}
              maxBarSize={20}
              animationDuration={600}
            />
            <Line
              type="step"
              dataKey="neededTarget"
              stroke={TARGET_COLOR}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DayTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: DailyCoverageRow }[];
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <ChartTooltip
      title={shortDay(row.date)}
      rows={[
        { label: "Sales recorded", value: formatMoney(row.sales), color: SALES_COLOR },
        { label: "Allocated target", value: row.neededTarget === null ? "Closed day" : formatMoney(row.neededTarget), color: TARGET_COLOR },
      ]}
    />
  );
}
