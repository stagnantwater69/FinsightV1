import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip } from "./ChartTooltip";
import { formatMoney } from "./Money";
import type { DailyExpenseTotal } from "../lib/types";

/**
 * Spending per day across the period.
 *
 * WHY THIS EXISTS. A category breakdown says where the money went; it cannot
 * say *when*. Those are different problems with different fixes. "PHP 32,000
 * on inventory" reads as a supplier problem until you see it all left on one
 * Tuesday, at which point it is a cash-timing problem — the money was fine on
 * paper and gone in practice. This is the chart that shows the difference, and
 * it needs no accounting background to read: tall bump = big day.
 *
 * FORM. Trend over time, one series — a line with a filled area beneath it.
 * One series means no legend: the title names it.
 *
 * THE REFERENCE LINE is the point of the chart. A daily figure means nothing
 * on its own; "your usual day" is what turns a spike into information. It is
 * the mean across every day in the period INCLUDING zero-spend days, because
 * that is what the money actually has to last across.
 *
 * Empty days are plotted as zero rather than skipped — dropping them would
 * compress the axis and redraw a quiet fortnight as steady spending.
 */

/** Keeps the x-axis from turning into a solid bar of overlapping dates. */
function tickInterval(pointCount: number) {
  if (pointCount <= 8) return 0;
  if (pointCount <= 16) return 1;
  return Math.ceil(pointCount / 8) - 1;
}

/** One point per day, or per month when the period is all time. */
export type SpendBucket = "day" | "month";

function pointLabel(iso: string, bucket: SpendBucket = "day") {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso.slice(5);
  return bucket === "month"
    ? d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

interface TooltipPayload {
  active?: boolean;
  payload?: { payload: DailyExpenseTotal }[];
  bucket?: SpendBucket;
}

function DayTooltip({ active, payload, bucket }: TooltipPayload) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <ChartTooltip
      title={pointLabel(row.date, bucket)}
      rows={[{ label: "Spent", value: formatMoney(row.total), color: "rgb(var(--chart-emphasis))", strong: true }]}
      footer={row.count === 0 ? "No expenses recorded" : `${row.count} expense${row.count === 1 ? "" : "s"}`}
    />
  );
}

export function DailySpendChart({ daily, bucket = "day" }: { daily: DailyExpenseTotal[]; bucket?: SpendBucket }) {
  if (daily.length === 0) return null;
  const unit = bucket === "month" ? "month" : "day";
  const shortDate = (iso: string) => pointLabel(iso, bucket);

  const total = daily.reduce((s, d) => s + d.total, 0);
  const average = total / daily.length;
  const busiest = daily.reduce((a, b) => (b.total > a.total ? b : a), daily[0]!);
  const spendingDays = daily.filter((d) => d.total > 0).length;

  return (
    <div>
      {/* The plain-language reading of the chart, above the chart. Someone who
          never looks at the plot still gets the finding. */}
      <p className="mb-4 text-[13px] leading-relaxed text-ink-600">
        Spent on <b className="font-semibold text-ink-900">{spendingDays}</b> of{" "}
        <b className="font-semibold text-ink-900">{daily.length}</b> {unit}s · average{" "}
        <b className="figure font-semibold text-ink-900">{formatMoney(average)}</b> a {unit}
        {busiest.total > 0 ? (
          <>
            {" "}· highest{" "}
            <b className="font-semibold text-ink-900">{shortDate(busiest.date)}</b>{" "}
            <b className="figure font-semibold text-ink-900">{formatMoney(busiest.total)}</b>
          </>
        ) : null}
      </p>

      {/* `text-ink-500` is inherited by the axes and grid, which are drawn with
          currentColor so they follow the theme — see CategoryBreakdownChart. */}
      <div className="min-w-0 text-ink-500">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="dailySpendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--chart-emphasis))" stopOpacity={0.45} />
                <stop offset="60%" stopColor="rgb(var(--chart-emphasis))" stopOpacity={0.12} />
                <stop offset="100%" stopColor="rgb(var(--chart-emphasis))" stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Recessive grid: horizontal only. Vertical rules add nothing when
                the x-axis is already a labelled sequence of days. */}
            <CartesianGrid stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 4" vertical={false} />

            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              interval={tickInterval(daily.length)}
              tick={{ fontSize: 10.5, fill: "currentColor" }}
              axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              tickLine={false}
              minTickGap={4}
            />
            <YAxis
              tick={{ fontSize: 10.5, fill: "currentColor" }}
              axisLine={false}
              tickLine={false}
              width={54}
              tickFormatter={(v: number) =>
                v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))
              }
            />

            <Tooltip
              content={<DayTooltip bucket={bucket} />}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.35, strokeWidth: 1 }}
            />

            {/* "Your usual day" — the baseline that makes a spike mean
                something. Dashed so it never reads as data. */}
            {average > 0 ? (
              <ReferenceLine
                y={average}
                stroke="rgb(var(--sev-warning-ink))"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                label={{
                  value: `usual ${unit} · ${formatMoney(average)}`,
                  position: "insideTopRight",
                  fill: "rgb(var(--sev-warning-ink))",
                  fontSize: 10.5,
                  fontFamily: "IBM Plex Mono, monospace",
                }}
              />
            ) : null}

            <Area
              type="monotone"
              dataKey="total"
              stroke="rgb(var(--chart-emphasis))"
              strokeWidth={2.5}
              fill="url(#dailySpendFill)"
              // Off for the same reason as the breakdown chart: the panel
              // re-fetches on every period change, and a chart that re-animates
              // on each one is noise rather than feedback.
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2.5, stroke: "rgb(var(--paper))" }}
            />
            {/* The busiest point, marked: the sentence above names it, and the
                dot shows where it sits. */}
            {busiest.total > 0 ? (
              <ReferenceDot
                x={busiest.date}
                y={busiest.total}
                r={5}
                fill="rgb(var(--chart-emphasis))"
                stroke="rgb(var(--paper))"
                strokeWidth={2.5}
                ifOverflow="extendDomain"
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* The table twin.
          Without it, every daily figure would be reachable only by hovering
          the plot — which means not reachable at all by keyboard, by screen
          reader, or on a touch screen. Collapsed by default because the chart
          is the point and thirty rows are not, but it is real markup in the
          DOM, so assistive tech and Ctrl-F find it either way. */}
      <details className="mt-4 border-t border-paper-200 pt-3">
        <summary className="disclosure">Show as table</summary>
        <div className="scroll-slim mt-3 max-h-64 overflow-y-auto">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <caption className="sr-only">Expenses recorded in each {unit} of the period.</caption>
            <thead className="sticky top-0 bg-paper">
              <tr className="border-b border-paper-200">
                <th scope="col" className="py-1.5 pr-3 font-semibold text-ink-500">
                  {bucket === "month" ? "Month" : "Day"}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-ink-500">
                  Spent
                </th>
                <th scope="col" className="py-1.5 text-right font-semibold text-ink-500">
                  Expenses
                </th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date} className="border-b border-paper-200 last:border-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-600">
                    {shortDate(d.date)}
                  </th>
                  <td
                    className={`figure py-1.5 pr-3 text-right ${
                      d.total > 0 ? "font-medium text-ink-900" : "text-ink-500"
                    }`}
                  >
                    {formatMoney(d.total)}
                  </td>
                  <td className="figure py-1.5 text-right text-ink-500">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
