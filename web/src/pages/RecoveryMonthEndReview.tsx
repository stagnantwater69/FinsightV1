import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { Button, ButtonLink } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Field, SelectInput } from "../components/Field";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { monthLabel } from "../lib/reportingPeriod";
import { Callout, Card, PageHead, Panel } from "../components/ui";
import { formatMoney } from "../components/Money";
import { SkeletonPanel } from "../components/Skeleton";
import type {
  MonthlyExpenseBasis,
  RecoveryMonthEndReview as RecoveryMonthEndReviewData,
} from "../lib/types";

/**
 * Plan §10.9/§11 Phase 7 — a read-only, deterministic recap of one
 * already-ended month. This page NEVER offers a way to apply
 * `suggestedQuestionsForNextMonth` to the business profile's settings — the
 * only call to action here is a plain link to the existing edit form, where
 * the owner makes their own manual change if they choose. See
 * `computeMonthEndReview` in insights.service.ts for the safety rationale;
 * do not add an "apply this suggestion" control to this page.
 */

/** "YYYY-MM" for the calendar month immediately before the current one —
 * the month an owner most likely wants to review right after it closes. */
function lastMonthKey(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const formatMonthLabel = monthLabel;

function formatDayLabel(dateKey: string): string {
  // UTC-midnight-encoded date-only string, like every other date in this app.
  return new Date(`${dateKey}T00:00:00.000Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "₱X surplus" or "₱X shortfall" — never a negative-looking peso figure. */
function surplusOrShortfallText(amount: number): string {
  const label = amount < 0 ? "shortfall" : "surplus";
  return `${formatMoney(Math.abs(amount))} ${label}`;
}

function monthlyExpenseBasisProvenance(basis: MonthlyExpenseBasis): string {
  if (basis.source === "previous_complete_month") {
    const recordLabel = basis.eligibleRecordCount === 1 ? "record" : "records";
    return basis.sourceMonth
      ? `Using ${basis.eligibleRecordCount} eligible expense ${recordLabel} from ${formatMonthLabel(basis.sourceMonth)}.`
      : `Using ${basis.eligibleRecordCount} eligible expense ${recordLabel} from the latest month confirmed complete.`;
  }
  return "Using your starting estimate until you confirm a complete past month of expense records.";
}

export function RecoveryMonthEndReviewPage() {
  return (
    <ReportingPeriodScope>
      <MonthEndReview />
    </ReportingPeriodScope>
  );
}

function MonthEndReview() {
  const { selected } = useBusinessProfiles();
  /*
   * The same month list as the period filter: months this business has
   * records in. Only ENDED ones are offered, newest first, because a review
   * is of a closed month. With none (or no answer), last month is offered on
   * its own, which is what this page always defaulted to.
   */
  const { months, monthsState } = useReportingPeriod();
  const thisMonth = currentMonthKey();
  const endedMonths = months.filter((key) => key < thisMonth);
  const options = endedMonths.length > 0 ? endedMonths : [lastMonthKey()];
  const [chosen, setChosen] = useState<string | null>(null);
  const month = chosen && options.includes(chosen) ? chosen : options[0]!;
  const monthsReady = monthsState !== "loading";
  const [data, setData] = useState<RecoveryMonthEndReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  async function load() {
    /*
     * No business — an owner who chose "Skip for now". Settles rather than
     * bails: `loading` starts true, so returning silently left two skeleton
     * panels on screen with nothing ever coming to replace them.
     */
    if (!selected) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!monthsReady) return;
    const thisRequestId = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<RecoveryMonthEndReviewData>("/insights/recovery/month-end-review", {
        params: { businessProfileId: selected.id, month },
      });
      if (thisRequestId !== requestId.current) return;
      setData(data);
    } catch (err) {
      if (thisRequestId !== requestId.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (thisRequestId === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, month, monthsReady]);

  /*
   * No `if (!selected) return <NoBusinessProfile />` any more — this page only
   * READS a month that has already ended. With no business it keeps its month
   * picker and shows the empty state below, which also narrows `selected` for
   * the profile-scoped link further down.
   */

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Month-end review"
        subtitle="Recap of an ended month. Nothing is changed automatically."
      />

      <InsightsTabs />

      <Card className="mb-5 p-4">
        <div className="max-w-xs">
          <Field label="Month to review" htmlFor="month-end-review-month">
            <SelectInput
              id="month-end-review-month"
              value={month}
              onChange={(e) => setChosen(e.target.value)}
            >
              {options.map((key) => (
                <option key={key} value={key}>
                  {formatMonthLabel(key)}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
      </Card>

      {error ? (
        <Callout tone="warn">
          <b className="font-semibold">Review couldn’t load.</b> {error}
          <div className="mt-2">
            <Button type="button" variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <SkeletonPanel lines={3} />
          <SkeletonPanel lines={3} />
        </div>
      ) : !selected ? (
        <EmptyState
          title="No month to review yet"
          icon="◔"
          action={
            <ButtonLink to="/onboarding" variant="primary">
              Finish business setup
            </ButtonLink>
          }
        />
      ) : data?.status === "not_yet_reviewable" ? (
        <Callout tone="info">
          <b className="font-semibold">{formatMonthLabel(data.month)} hasn’t ended yet.</b> Its review is
          ready once the month closes.
        </Callout>
      ) : data?.status === "reviewable" ? (
        <div className="space-y-5">
          <Panel title={formatMonthLabel(data.month)} eyebrow="Month-end review">
            <p className="text-sm text-ink-700">
              Covered{" "}
              <span className="figure font-semibold">{Math.round(data.coveragePercent)}%</span> of the monthly
              expense basis:{" "}
              <span className="figure font-semibold">{surplusOrShortfallText(data.surplusOrShortfall)}</span>.
            </p>
            {data.monthlyExpenseBasis ? (
              <div className="mt-4 border-t border-paper-200 pt-4">
                <p className="text-xs font-semibold text-ink-500">Monthly expense basis</p>
                <p className="figure mt-1 text-lg font-semibold text-ink-900">
                  {formatMoney(data.monthlyExpenseBasis.amount)}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  {monthlyExpenseBasisProvenance(data.monthlyExpenseBasis)}
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel title="Strongest and weakest open days">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="eyebrow mb-0.5">Strongest</div>
                {data.strongestOpenDay ? (
                  <p className="text-sm text-ink-900">
                    <span className="font-semibold">{formatDayLabel(data.strongestOpenDay.date)}</span>{" "}
                    · <span className="figure">{formatMoney(data.strongestOpenDay.sales)}</span>
                  </p>
                ) : (
                  <p className="text-sm text-ink-500">No open days recorded that month.</p>
                )}
              </div>
              <div>
                <div className="eyebrow mb-0.5">Weakest</div>
                {data.weakestOpenDay ? (
                  <p className="text-sm text-ink-900">
                    <span className="font-semibold">{formatDayLabel(data.weakestOpenDay.date)}</span>{" "}
                    · <span className="figure">{formatMoney(data.weakestOpenDay.sales)}</span>
                  </p>
                ) : (
                  <p className="text-sm text-ink-500">No open days recorded that month.</p>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Missing or provisional days">
            <p className="text-sm text-ink-700">
              <span className="figure font-semibold">{data.missingOrProvisionalDayCount}</span> of{" "}
              <span className="figure font-semibold">{data.openDayCount}</span> open days had missing or
              unreviewed sales.
            </p>
          </Panel>

          <Panel title="Original vs. final adjusted daily target">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                  Original daily target
                </dt>
                <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                  {formatMoney(data.originalDailyTarget)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                  Final adjusted daily target
                </dt>
                {data.finalAdjustedDailyTarget !== null ? (
                  <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                    {formatMoney(data.finalAdjustedDailyTarget)}
                  </dd>
                ) : (
                  <dd className="mt-0.5 text-sm text-ink-500">
                    Not available: the last day of the month was closed.
                  </dd>
                )}
              </div>
            </dl>
          </Panel>

          {data.baselineAppearsOffFromPattern ? (
            <Callout tone="info">
              Expected monthly expenses may not match this month’s sales pattern. Your settings are unchanged.
            </Callout>
          ) : null}

          <Panel title="Questions to consider for next month">
            {data.suggestedQuestionsForNextMonth.length > 0 ? (
              <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-700">
                {data.suggestedQuestionsForNextMonth.map((question, i) => (
                  <li key={i}>{question}</li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-500">None this month.</p>
            )}
            <p className="mt-3 text-xs text-ink-500">
              Nothing here changes your settings.{" "}
              <Link
                to={`/business-profiles/${selected.id}/edit`}
                className="tap-inline inline-flex items-center gap-1.5 font-semibold text-brand-700 underline underline-offset-2"
              >
                Edit business profile
                <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.9} />
              </Link>
            </p>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
