import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

function shortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso.slice(5);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

interface TooltipPayload {
  active?: boolean;
  payload?: { payload: DailyExpenseTotal }[];
}

function DayTooltip({ active, payload }: TooltipPayload) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-paper-200 bg-paper px-3 py-2 shadow-md">
      <p className="text-[11.5px] font-semibold text-ink-900">{shortDate(row.date)}</p>
      <p className="figure mt-0.5 text-[13px] font-bold text-ink-900">{formatMoney(row.total)}</p>
      <p className="mt-0.5 text-[11px] text-ink-500">
        {row.count === 0
          ? "No expenses recorded"
          : `${row.count} expense${row.count === 1 ? "" : "s"}`}
      </p>
    </div>
  );
}

export function DailySpendChart({ daily }: { daily: DailyExpenseTotal[] }) {
  if (daily.length === 0) return null;

  const total = daily.reduce((s, d) => s + d.total, 0);
  const average = total / daily.length;
  const busiest = daily.reduce((a, b) => (b.total > a.total ? b : a), daily[0]!);
  const spendingDays = daily.filter((d) => d.total > 0).length;

  return (
    <div>
      {/* The plain-language reading of the chart, above the chart. Someone who
          never looks at the plot still gets the finding. */}
      <p className="mb-4 text-[13px] leading-relaxed text-ink-600">
        You spent on <b className="font-semibold text-ink-900">{spendingDays}</b> of{" "}
        <b className="font-semibold text-ink-900">{daily.length}</b> days, averaging{" "}
        <b className="figure font-semibold text-ink-900">{formatMoney(average)}</b> a day.
        {busiest.total > 0 ? (
          <>
            {" "}
            Your biggest day was{" "}
            <b className="font-semibold text-ink-900">{shortDate(busiest.date)}</b> at{" "}
            <b className="figure font-semibold text-ink-900">{formatMoney(busiest.total)}</b>.
          </>
        ) : null}
      </p>

      {/* `text-ink-400` is inherited by the axes and grid, which are drawn with
          currentColor so they follow the theme — see CategoryBreakdownChart. */}
      <div className="min-w-0 text-ink-400">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="dailySpendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--chart-emphasis))" stopOpacity={0.28} />
                <stop offset="100%" stopColor="rgb(var(--chart-emphasis))" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {/* Recessive grid: horizontal only. Vertical rules add nothing when
                the x-axis is already a labelled sequence of days. */}
            <CartesianGrid stroke="currentColor" strokeOpacity={0.18} vertical={false} />

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
              content={<DayTooltip />}
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
                  value: `usual day · ${formatMoney(average)}`,
                  position: "insideTopRight",
                  fill: "rgb(var(--sev-warning-ink))",
                  fontSize: 10.5,
                }}
              />
            ) : null}

            <Area
              type="monotone"
              dataKey="total"
              stroke="rgb(var(--chart-emphasis))"
              strokeWidth={2}
              fill="url(#dailySpendFill)"
              // Off for the same reason as the breakdown chart: the panel
              // re-fetches on every period change, and a chart that re-animates
              // on each one is noise rather than feedback.
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "rgb(var(--paper))" }}
            />
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
        <summary className="cursor-pointer list-none text-[12.5px] font-medium text-brand-700 transition hover:text-brand-800">
          <span className="tap-inline">View the daily figures as a table</span>
        </summary>
        <div className="scroll-slim mt-3 max-h-64 overflow-y-auto">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <caption className="sr-only">Expenses recorded on each day of the period.</caption>
            <thead className="sticky top-0 bg-paper">
              <tr className="border-b border-paper-200">
                <th scope="col" className="py-1.5 pr-3 font-semibold text-ink-500">
                  Day
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
                      d.total > 0 ? "font-medium text-ink-900" : "text-ink-400"
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
