import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { formatMoney } from "../../components/Money";
import { STATUS_INK } from "../../lib/chartPalette";
import { Panel } from "../../components/ui";
import { formatDayRange } from "../../lib/reportingPeriod";
import type { ExpenseBehavior as ExpenseInsightData } from "../../lib/types";
import { ShareBar } from "./ExpenseVisuals";
import {
  ListDisclosureControl,
  useListDisclosure,
} from "../../components/ListDisclosure";

/** "▲ PHP 7,000" in the right status colour, or an em-dash for no movement. */
export function ChangeFigure({
  change,
  percent,
}: {
  change: number;
  percent: number | null;
}) {
  if (change === 0) {
    return <span className="figure text-ink-500">{formatMoney(0)}</span>;
  }
  const up = change > 0;
  return (
    // Spending MORE is the serious direction here, not the good one — this is
    // an expense screen, so up is bad. Colour is never the only signal: the
    // arrow and the sign say the same thing.
    <span
      className="figure inline-flex flex-wrap items-center justify-end font-semibold"
      style={{ color: up ? STATUS_INK.serious : STATUS_INK.good }}
    >
      {/* Sign and amount never split ("+PHP" over "5,000"); only the percent may wrap. */}
      <span className="inline-flex items-center whitespace-nowrap">
        {up ? (
          <ArrowUpRight aria-hidden className="mr-1 size-3.5" />
        ) : (
          <ArrowDownRight aria-hidden className="mr-1 size-3.5" />
        )}
        {up ? "+" : "−"}
        {formatMoney(Math.abs(change))}
      </span>
      {percent !== null && percent !== 0 ? (
        <span className="ml-1 text-xs font-medium opacity-80">
          {Math.abs(percent).toFixed(0)}%
        </span>
      ) : null}
    </span>
  );
}

export function CategorySummary({
  data,
  summary,
  disclosure,
  businessName,
  periodText,
  periodCaption,
  comparedWith,
  allTime,
}: {
  data: ExpenseInsightData;
  summary: { total: number; periodDelta: number; periodPercent: number | null };
  disclosure: ReturnType<typeof useListDisclosure>;
  businessName: string;
  periodText: string;
  periodCaption: string;
  comparedWith: string;
  allTime: boolean;
}) {
  return (
    <div id="expense-categories" className="scroll-mt-6">
      {/* ===================== 4. THE TABLE ===================== */}
      {/* The accessible reading of every chart above, and the relief the
          palette's contrast check requires: nothing on this page is
          knowable only by colour. */}
      <Panel
        title="Category summary"
        action={
          <span className="text-xs text-ink-500">
            {formatDayRange(data.periodStart.slice(0, 10), data.periodEnd.slice(0, 10))}
          </span>
        }
        bodyClassName="px-0 pb-0"
      >
        {/* On a phone, a six-column table turns comparison into horizontal
            scavenger hunting. The same values become compact category
            records; the semantic table remains the desktop reading. */}
        <div id={disclosure.contentId}>
          <ul className="space-y-2 px-4 pb-4 md:hidden">
            {data.categoryTrends.slice(0, disclosure.visibleCount).map((trend) => (
              <li
                key={trend.categoryId}
                className="rounded-xl border border-paper-200 bg-paper-100/50 p-3.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink-900">
                      {trend.categoryName}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {trend.recordCount} expense
                      {trend.recordCount === 1 ? "" : "s"} ·{" "}
                      {summary.total > 0
                        ? ((trend.current / summary.total) * 100).toFixed(1)
                        : "0.0"}
                      %
                    </p>
                  </div>
                  <p className="figure shrink-0 text-sm font-bold text-ink-900">
                    {formatMoney(trend.current)}
                  </p>
                </div>
                <ShareBar
                  percent={summary.total > 0 ? (trend.current / summary.total) * 100 : 0}
                  color="rgb(var(--chart-emphasis))"
                  className="mt-2.5 h-1.5"
                />
                {!allTime ? (
                <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-paper-200 pt-3">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-500">
                      {comparedWith}
                    </dt>
                    <dd className="figure mt-1 text-sm text-ink-600">
                      {formatMoney(trend.previous)}
                    </dd>
                  </div>
                  <div className="text-right">
                    <dt className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-500">
                      Change
                    </dt>
                    <dd className="mt-1 text-sm">
                      <ChangeFigure
                        change={trend.change}
                        percent={trend.percentChange}
                      />
                    </dd>
                  </div>
                </dl>
                ) : null}
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 border-t border-paper-200 px-1 pt-3 text-sm">
              <span className="font-semibold text-ink-600">Total</span>
              <span className="figure font-bold text-ink-900">
                {formatMoney(summary.total)}
              </span>
            </li>
          </ul>

          <div className="scroll-slim hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">
                Expenses by category for {businessName}, {periodText}
                {allTime ? "" : `, compared with ${comparedWith}`}.
              </caption>
              <thead>
                <tr className="border-y border-paper-200 bg-paper-100/60">
                  <th
                    scope="col"
                    className="px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-600"
                  >
                    Category
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600"
                  >
                    {periodCaption}
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600"
                  >
                    Share
                  </th>
                  {!allTime ? (
                    <>
                      <th
                        scope="col"
                        className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600"
                      >
                        {comparedWith}
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600"
                      >
                        Change
                      </th>
                    </>
                  ) : null}
                  <th
                    scope="col"
                    className="px-5 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600"
                  >
                    Count
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.categoryTrends.slice(0, disclosure.visibleCount).map((t) => (
                  <tr
                    key={t.categoryId}
                    className="border-b border-paper-200 last:border-0"
                  >
                    <th
                      scope="row"
                      className="px-5 py-3 text-left font-medium text-ink-900"
                    >
                      {t.categoryName}
                    </th>
                    <td className="figure px-4 py-3 text-right font-semibold text-ink-900">
                      {formatMoney(t.current)}
                    </td>
                    <td className="px-4 py-3 text-right text-ink-600">
                      <div className="flex items-center justify-end gap-2.5">
                        <div className="w-20">
                          <ShareBar
                            percent={summary.total > 0 ? (t.current / summary.total) * 100 : 0}
                            color="rgb(var(--chart-emphasis))"
                            className="h-1.5"
                          />
                        </div>
                        <span className="figure w-12">
                          {summary.total > 0
                            ? ((t.current / summary.total) * 100).toFixed(1)
                            : "0.0"}
                          %
                        </span>
                      </div>
                    </td>
                    {!allTime ? (
                      <>
                        <td className="figure px-4 py-3 text-right text-ink-500">
                          {formatMoney(t.previous)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ChangeFigure
                            change={t.change}
                            percent={t.percentChange}
                          />
                        </td>
                      </>
                    ) : null}
                    <td className="figure px-5 py-3 text-right text-ink-600">
                      {t.recordCount}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-paper-200 bg-paper-100/60">
                  <th
                    scope="row"
                    className="px-5 py-3 text-left text-xs font-bold uppercase tracking-[0.06em] text-ink-600"
                  >
                    Total
                  </th>
                  <td className="figure px-4 py-3 text-right font-bold text-ink-900">
                    {formatMoney(summary.total)}
                  </td>
                  <td className="figure px-4 py-3 text-right text-ink-600">
                    100.0%
                  </td>
                  {!allTime ? (
                    <>
                      <td className="figure px-4 py-3 text-right text-ink-600">
                        {formatMoney(data.totals.previous)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ChangeFigure
                          change={summary.periodDelta}
                          percent={summary.periodPercent}
                        />
                      </td>
                    </>
                  ) : null}
                  <td className="figure px-5 py-3 text-right text-ink-600">
                    {data.categoryTrends.reduce(
                      (s, t) => s + t.recordCount,
                      0,
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <ListDisclosureControl
          disclosure={disclosure}
          total={data.categoryTrends.length}
          itemLabel="categories"
          className="mx-4 pb-3"
        />
      </Panel>
    </div>
  );
}
