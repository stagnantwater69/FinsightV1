import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip } from "../../components/ChartTooltip";
import { formatMoney } from "../../components/Money";
import type { CashflowGranularity, CashflowPoint } from "./useDashboardFeeds";

/**
 * Money in against money out, bucket by bucket, with the net drawn as a line
 * over the bars on the same axis. Three series, so the legend carries each
 * one's total. Hovering a bucket dims the others so it can be read alone. Expenses are a neutral ink rather than a warning colour: spending is
 * not bad news, it is half of the picture.
 */

const SALES = "rgb(var(--chart-emphasis))";
const EXPENSES = "rgb(var(--ink-400))";
// Net is a line over the bars on the same peso axis: the bars say how much
// came and went, the line says what was left of it.
const NET = "rgb(var(--ink-900))";

function bucketLabel(date: string, granularity: CashflowGranularity, long = false) {
  if (granularity === "monthly") {
    const d = new Date(`${date}-01T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: long ? "long" : "short", year: long ? "numeric" : undefined, timeZone: "UTC" });
  }
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString(undefined, long
    ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }
    : { weekday: "short", timeZone: "UTC" });
}

function axisMoney(v: number) {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1000) return `${sign}${Math.round(a / 1000)}k`;
  return `${sign}${Math.round(a)}`;
}

function CashflowTooltip({
  active,
  payload,
  granularity,
}: {
  active?: boolean;
  payload?: { payload: CashflowPoint }[];
  granularity: CashflowGranularity;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const net = p.sales - p.expenses;
  return (
    <ChartTooltip
      title={bucketLabel(p.date, granularity, true)}
      rows={[
        { label: "In", value: formatMoney(p.sales), color: SALES },
        { label: "Out", value: formatMoney(p.expenses), color: EXPENSES },
        { label: "Net", value: `${net >= 0 ? "+" : "−"}${formatMoney(Math.abs(net))}`, strong: true },
      ]}
    />
  );
}

export function CashflowChart({
  points,
  granularity,
}: {
  points: CashflowPoint[];
  granularity: CashflowGranularity;
}) {
  const totalIn = points.reduce((s, p) => s + p.sales, 0);
  const totalOut = points.reduce((s, p) => s + p.expenses, 0);
  const net = totalIn - totalOut;
  const window = granularity === "daily" ? "last 7 days" : "last 6 months";
  const [active, setActive] = useState<number | null>(null);
  const chartPoints = points.map((p) => ({ ...p, net: p.sales - p.expenses }));

  return (
    <div>
      {points.length > 0 ? <p className="mb-3 text-xs font-medium text-ink-600">{bucketLabel(points[0]!.date, granularity, true)} to {bucketLabel(points[points.length - 1]!.date, granularity, true)}</p> : null}
      <dl className="grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { label: "In", value: formatMoney(totalIn), swatch: SALES },
          { label: "Out", value: formatMoney(totalOut), swatch: EXPENSES },
          { label: "Net", value: `${net >= 0 ? "+" : "−"}${formatMoney(Math.abs(net))}`, swatch: NET, line: true },
        ].map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-ink-500">
              {"line" in item ? (
                <span aria-hidden className="relative h-2 w-3.5">
                  <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded" style={{ backgroundColor: item.swatch }} />
                  <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ backgroundColor: item.swatch }} />
                </span>
              ) : (
                <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: item.swatch }} />
              )}
              {item.label}
            </dt>
            <dd className={`figure mt-0.5 break-words text-sm font-semibold sm:text-lg ${item.label === "Net" ? (net < 0 ? "text-tone-danger" : "text-tone-brand") : "text-ink-900"}`}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 min-w-0 text-ink-500" onMouseLeave={() => setActive(null)}>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart
            data={chartPoints}
            margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
            barGap={4}
            barCategoryGap="26%"
            onMouseMove={(state) => {
              const index = (state as { activeTooltipIndex?: number | string | null }).activeTooltipIndex;
              setActive(index === undefined || index === null ? null : Number(index));
            }}
          >
            <defs>
              <linearGradient id="cashflowIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SALES} stopOpacity={1} />
                <stop offset="100%" stopColor={SALES} stopOpacity={0.55} />
              </linearGradient>
              <linearGradient id="cashflowOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EXPENSES} stopOpacity={0.95} />
                <stop offset="100%" stopColor={EXPENSES} stopOpacity={0.45} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => bucketLabel(d, granularity)}
              tick={{ fontSize: 11, fill: "currentColor" }}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "currentColor" }}
              axisLine={false}
              tickLine={false}
              width={44}
              tickFormatter={axisMoney}
            />
            <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.35} />
            <Tooltip
              content={<CashflowTooltip granularity={granularity} />}
              cursor={{ fill: "currentColor", fillOpacity: 0.05, radius: 8 } as object}
            />
            <Bar dataKey="sales" name="In" fill="url(#cashflowIn)" radius={[6, 6, 0, 0]} maxBarSize={30} animationDuration={600}>
              {chartPoints.map((p, i) => (
                <Cell key={p.date} fillOpacity={active === null || active === i ? 1 : 0.35} />
              ))}
            </Bar>
            <Bar dataKey="expenses" name="Out" fill="url(#cashflowOut)" radius={[6, 6, 0, 0]} maxBarSize={30} animationDuration={600}>
              {chartPoints.map((p, i) => (
                <Cell key={p.date} fillOpacity={active === null || active === i ? 1 : 0.35} />
              ))}
            </Bar>
            <Line
              type="monotone"
              dataKey="net"
              name="Net"
              stroke={NET}
              strokeWidth={2}
              dot={{ r: 3.5, fill: NET, stroke: "rgb(var(--paper))", strokeWidth: 2 }}
              activeDot={{ r: 5.5, fill: NET, stroke: "rgb(var(--paper))", strokeWidth: 2 }}
              animationDuration={700}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* The table twin: every bar's value, reachable without hovering. */}
      <div className="sr-only">
      <table>
        <caption>Sales and expenses, {window}.</caption>
        <thead>
          <tr><th scope="col">Period</th><th scope="col">Sales</th><th scope="col">Expenses</th><th scope="col">Net</th></tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{bucketLabel(p.date, granularity, true)}</th>
              <td>{formatMoney(p.sales)}</td>
              <td>{formatMoney(p.expenses)}</td>
              <td>{p.sales - p.expenses >= 0 ? "+" : "−"}{formatMoney(Math.abs(p.sales - p.expenses))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
