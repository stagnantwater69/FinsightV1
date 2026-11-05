import { useEffect, useRef, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { expenseOverviewDetailRequest } from "../lib/screenRequests";
import { getErrorMessage } from "../lib/errors";
import { THIS_WEEK, periodPhrase, type PeriodSelection } from "../lib/reportingPeriod";
import type { DetailExpenseOverview } from "../lib/expenseOverview";
import type { ExpenseBehavior } from "../lib/types";
import { PeriodFilter } from "../components/PeriodFilter";
import { Button, ButtonLink } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { SkeletonPanel } from "../components/Skeleton";
import { Callout, Panel } from "../components/ui";
import { formatMoney } from "../components/Money";
import { UsualBar } from "./expenseInsight/ExpenseVisuals";
import { ExpenseSubpageHead } from "./expenseInsight/ExpenseSubpageHead";

/**
 * Every unusual expense for the period, on its own page.
 *
 * Expense insight shows the top five beside the large-expense flags; growing
 * that panel in place pushed the two side-by-side panels out of line. This
 * page reads the same cached overview request under the same period scope,
 * so arriving from Expense insight shows the list at once and changing the
 * period here changes it there too.
 */
export function UnusualExpensesPage() {
  return (
    <ReportingPeriodScope scope="expense-insight">
      <UnusualExpenses />
    </ReportingPeriodScope>
  );
}

function UnusualExpenses() {
  const { selected } = useBusinessProfiles();
  const { selection: sharedSelection, setSelection, ready: periodReady } = useReportingPeriod();
  // Same normalization as Expense insight: All time has no unusual-expense read.
  const selection: PeriodSelection =
    sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  const periodKey = JSON.stringify(selection);
  const [data, setData] = useState<ExpenseBehavior | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [setSelection, sharedSelection]);

  async function load(force = false) {
    if (!selected) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!periodReady) return;
    const thisRequestId = ++requestId.current;
    const { url, params, scope } = expenseOverviewDetailRequest(selected.id, selection);
    const cached = peekCachedApiData<DetailExpenseOverview>(url, { params }, scope);
    const behaviorOf = (overview: DetailExpenseOverview) =>
      overview.behavior.status === "available" ? overview.behavior.data : null;
    if (cached) setData(behaviorOf(cached.data));
    setLoading(!cached);
    setError(null);
    try {
      const { data: overview } = await cachedApiGet<DetailExpenseOverview>(
        url,
        { params },
        scope,
        { force },
      );
      if (thisRequestId !== requestId.current) return;
      const behavior = behaviorOf(overview);
      setData(behavior);
      if (!behavior) setError("Unusual expenses are unavailable right now.");
    } catch (err) {
      if (thisRequestId !== requestId.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (thisRequestId === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodKey, periodReady]);

  const items = data?.unusualExpenses ?? [];

  return (
    <div>
      <ExpenseSubpageHead
        title="Unusual expenses"
        subtitle={`Expenses well above their category's usual amount ${periodPhrase(selection)}.`}
        actions={<PeriodFilter showAllTime={false} />}
        backTo="/insights/expense-behavior#expense-review"
      />

      {error && !data ? (
        <Callout tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Unusual expenses couldn’t load. {error}</span>
            <Button type="button" size="sm" variant="secondary" onClick={() => void load(true)}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : loading && !data ? (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading unusual expenses…</span>
          <SkeletonPanel lines={6} />
        </div>
      ) : !selected || items.length === 0 ? (
        <EmptyState
          compact
          title="Nothing unusual"
          icon="✓"
          action={
            <ButtonLink to="/insights/expense-behavior" variant="secondary">
              Back to Expense insight
            </ButtonLink>
          }
        >
          No expense stood out from its category’s usual amount {periodPhrase(selection)}.
        </EmptyState>
      ) : (
        <Panel
          title={`${items.length} unusual ${items.length === 1 ? "expense" : "expenses"}`}
        >
          {error ? (
            <p role="status" className="mb-3 text-sm text-tone-accent">
              Showing recently loaded results; the latest refresh failed.
            </p>
          ) : null}
          <ul className="grid gap-3 lg:grid-cols-2">
            {items.map((u) => {
              const times = u.categoryMean > 0 ? u.amount / u.categoryMean : null;
              return (
                <li
                  key={u.id}
                  className="rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-900">{u.description}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {u.categoryName} · {u.date.slice(0, 10)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="figure text-sm font-bold text-ink-900">
                        {formatMoney(u.amount)}
                      </p>
                      {times && times >= 1.5 ? (
                        <span className="figure mt-0.5 inline-block rounded-full bg-tint-danger px-1.5 py-0.5 text-xs font-semibold text-tone-danger">
                          {times.toFixed(1)}× usual
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <UsualBar amount={u.amount} usual={u.categoryMean} />
                  <p className="mt-1.5 text-xs text-ink-500">
                    Usual{" "}
                    <span className="figure font-medium text-ink-700">
                      {formatMoney(u.categoryMean)}
                    </span>{" "}
                    (the line)
                  </p>
                </li>
              );
            })}
          </ul>
          {data && data.insufficientHistoryCategories.length > 0 ? (
            <p className="mt-4 text-xs text-ink-500">
              Not enough history to check:{" "}
              {data.insufficientHistoryCategories.map((c) => c.categoryName).join(", ")}
            </p>
          ) : null}
        </Panel>
      )}
    </div>
  );
}
