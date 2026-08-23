import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { CategoryBreakdownChart } from "../components/CategoryBreakdownChart";
import { CategoryComparisonChart } from "../components/CategoryComparisonChart";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { SkeletonDashboard } from "../components/Skeleton";
import { EmptyState, SetupProgress } from "../components/EmptyState";
import { GreetingHero } from "../components/GreetingHero";
import { ButtonLink } from "../components/Button";
import { formatMoney } from "../components/Money";
import { DonutChart } from "../components/DonutChart";
import { AiCard, Callout, KpiCard, Kw, Panel, PageHead, Pill } from "../components/ui";
import { IconArrowRight } from "../components/icons";
import type { DashboardSummary, ExpenseBehavior } from "../lib/types";

/**
 * `days: 0` is "All time" — the server drops the date filter entirely rather
 * than widening it (see ALL_TIME_PERIOD in dashboard.service.ts).
 *
 * It exists because the other three are all lookback windows of a month or
 * less, and CSV import now invites owners to bring in YEARS of history. Without
 * it, a business whose records end more than 30 days ago has no setting on this
 * page that can see a single one of them — which is exactly what happened to a
 * 21,097-row import of 2023-2025 data.
 */
const PERIOD_OPTIONS = [
  { label: "Today", days: 1 },
  { label: "This week", days: 7 },
  { label: "This month", days: 30 },
  { label: "All time", days: 0 },
];

export function Dashboard() {
  const { selected } = useBusinessProfiles();
  // The ONE mascot this preference governs — Fin's daily line below. Every
  // other appearance (Ask FinSight, the tour, empty states, onboarding) is a
  // reply to something the owner just did, not an unprompted daily message,
  // and stays put.
  const { preferences } = useAuth();
  const { categories } = useExpenseCategories();
  const [periodDays, setPeriodDays] = useState(30);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ExpenseBehavior | null>(null);
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the "expand on this" link below hands one through to
  // be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Dashboard");

  async function load() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<DashboardSummary>("/dashboard/summary", {
        params: { businessProfileId: selected.id, periodDays },
      });
      setSummary(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodDays]);

  // This vs last month, independent of the KPI row's own period toggle above
  // — "Today" or "This week" would make a month-over-month comparison
  // meaningless, so this always asks for the fixed 30-day window regardless
  // of what periodDays is currently set to.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api
      .get<ExpenseBehavior>("/insights/expense-behavior", {
        params: { businessProfileId: selected.id, periodDays: 30 },
      })
      .then(({ data }) => {
        if (!cancelled) setComparison(data);
      })
      .catch(() => {
        // A quiet failure here — the KPI row and the rest of the dashboard
        // already loaded successfully via a separate request, and this one
        // panel degrading to its empty state is a much smaller problem than
        // a page-level error banner over a dashboard that otherwise works.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  /*
   * No business yet — which now only happens to someone who chose "Skip for
   * now" during setup, since everyone else is redirected into the wizard by
   * RequireBusinessProfile.
   *
   * This used to `return null`, so the first screen a new owner ever saw was a
   * blank page with no explanation and no way forward. Resuming setup is the
   * only useful thing to offer here, so that is the only thing offered.
   */
  if (!selected) {
    return (
      <div>
        <PageHead title="Welcome to FinSight" subtitle="One short step and your dashboard comes to life." />
        <EmptyState
          image="/mascot/01-onboarding/businessprofilesetup.webp"
          title="Finish setting up your business"
          action={<ButtonLink to="/onboarding" variant="primary">Continue setup</ButtonLink>}
        >
          FinSight needs your business name and a few figures before it can work out your sales
          target, track your recovery or flag large expenses. Anything you already typed was kept.
        </EmptyState>
      </div>
    );
  }

  /*
   * "Has this business ever recorded anything" — NOT "did it record anything
   * in the selected period".
   *
   * These were the same expression, read off the period-scoped overview, and
   * the difference is not academic: an owner who imported two years of history
   * saw "Record your first expense or sale" still unticked, because none of
   * their 21,097 records fell inside the last 30 days. The checklist told them
   * the import had failed. It had not.
   *
   * Falls back to the period figures when an older server sends no `lifetime`,
   * which is the previous behaviour rather than a blank.
   */
  const hasAnyRecords = summary?.lifetime
    ? summary.lifetime.recordCount > 0
    : !!summary && (summary.overview.totalExpenses > 0 || summary.overview.totalSalesReference > 0);

  /**
   * Records exist, just none of them in this window.
   *
   * Worth calling out precisely because everything else on the page is
   * correctly empty: an owner cannot tell "no activity lately" from "my import
   * did not work", and silence gets read as the second one.
   */
  const periodIsEmpty =
    !!summary &&
    hasAnyRecords &&
    summary.overview.totalExpenses === 0 &&
    summary.overview.totalSalesReference === 0;
  const latestRecordDate = summary?.lifetime?.latestRecordDate ?? null;

  // ---- values the KPI row and the summary card read -----------------------
  // All derived from `summary`, which the server computed. Nothing here
  // recalculates a financial figure; it only picks and phrases.

  const periodLabel = `Last ${summary?.periodDays ?? 0} day${summary?.periodDays === 1 ? "" : "s"}`;

  const topCategory = summary?.expenseCategoryBreakdown?.length
    ? [...summary.expenseCategoryBreakdown].sort((a, b) => b.total - a.total)[0]
    : null;

  /**
   * Recovery reduced to a KPI-sized verdict.
   *
   * `onTrack` is the server's own judgement — this does not re-derive it.
   * The "not set up" case is distinct from "behind": an owner who never
   * entered expected monthly expenses is not failing a target, they simply
   * have not set one, and telling them they are "behind" would be wrong.
   */
  const recovery: { label: string; meta: ReactNode; tone: "brand" | "accent" | "danger" | "info" } = !summary
    ? { label: "—", meta: "", tone: "info" }
    : summary.recoveryStatus.expectedMonthlyExpenses <= 0
      ? { label: "Not set up", meta: "Add expected monthly expenses", tone: "info" }
      : summary.recoveryStatus.onTrack
        ? {
            label: "On track",
            meta: `${Math.round(summary.recoveryStatus.monthCoveragePercent)}% of the month covered`,
            tone: "brand",
          }
        : {
            label: "Behind pace",
            meta: (
              <>
                <span className="figure">{formatMoney(summary.recoveryStatus.remainingTarget)}</span> still needed
              </>
            ),
            tone: "danger",
          };

  // Names whichever specific thing the card above actually flagged — the
  // records needing review if there are any (the most actionable item),
  // otherwise the top category — rather than a generic "summarise this".
  const expandQuestion = summary
    ? summary.recordsNeedingReview > 0
      ? `What should I do about the ${summary.recordsNeedingReview} record${summary.recordsNeedingReview === 1 ? "" : "s"} that need${summary.recordsNeedingReview === 1 ? "s" : ""} review?`
      : topCategory
        ? `Why is ${topCategory.categoryName} my largest expense category ${periodLabel.toLowerCase()}?`
        : undefined
    : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Financial summary"
        title="Dashboard"
        subtitle={
          <>
            Overview for <b className="font-semibold text-ink-700">{selected.name}</b>
          </>
        }
        actions={
          <>
            <div className="flex gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setPeriodDays(opt.days)}
                  aria-pressed={periodDays === opt.days}
                  className={`tap rounded-lg px-3 text-[13.5px] font-semibold transition ${
                    periodDays === opt.days
                      ? "bg-paper text-brand-800 shadow-sm"
                      : "text-ink-500 hover:text-brand-800"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        }
      />

      {/*
        Fin opens the page, above the checklist and the figures alike: it names
        the reader and says the one thing that most wants acting on, which is
        the question someone arriving at a dashboard is actually asking. It
        renders during loading too — `summary` is null then, and the panel holds
        its shape with skeleton lines rather than appearing a beat late.
      */}
      {/* data-tour="dashboard-summary" is the product tour's "dashboard
          overview" spotlight — the greeting panel is the page's summary
          sentence and the first thing the tour should point at. The KPI row
          below carries the same marker as a fallback, so an owner who has
          turned the daily message off still gets that step pointed at
          something rather than having it silently skipped (TourOverlay
          resolves the first VISIBLE match, which is this one when it is
          here). */}
      {preferences.showDashboardMascotMessage ? (
        <div data-tour="dashboard-summary">
          <GreetingHero summary={loading ? null : summary} />
        </div>
      ) : null}

      {/* Invisible marker for the tour's auto-start gate: present only once
          the dashboard fetch has settled, so the tour never opens over a
          skeleton. Zero-size, aria-hidden — costs nothing. */}
      {!loading ? <span data-tour="dashboard-loaded" aria-hidden className="hidden" /> : null}

      {/* Goal-Gradient: a brand-new business sees how close it is to a first
          insight, rather than three unrelated empty panels. */}
      {!loading && summary ? (
        <SetupProgress
          steps={[
            { label: "Set up your business profile", done: true },
            { label: "Add an expense category", done: categories.length > 0 },
            { label: "Record your first expense or sale", done: hasAnyRecords },
          ]}
        />
      ) : null}

      {/*
        Above the panels, because it explains all of them at once.

        Placed here rather than inside each empty chart for the reason the
        panels are grouped at all: three separate "no data" messages describe a
        symptom three times, while one line at the top gives the cause and a way
        out. The date is the whole value of it — "no records in this period" is
        just as opaque as the empty charts; "your most recent record is 31 Jul
        2025" tells the owner their import landed and where to look.
      */}
      {!loading && periodIsEmpty ? (
        <div className="mb-6">
          <Callout tone="info">
            <b className="font-semibold">
              No records in {PERIOD_OPTIONS.find((o) => o.days === periodDays)?.label.toLowerCase() ?? "this period"}
              , but this business has {summary!.lifetime!.recordCount.toLocaleString()} in total.
            </b>{" "}
            {latestRecordDate ? (
              <>
                The most recent one is dated{" "}
                <span className="figure font-semibold text-ink-700">
                  {/* UTC, like every other date rendering here: these are
                      date-only columns stored at midnight UTC, and formatting
                      them in local time shows the previous day west of it. */}
                  {new Date(latestRecordDate).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </span>
                . Your imported history is safe — this page is only looking at the period selected
                above.{" "}
              </>
            ) : null}
            {/*
              The fix, not a signpost to somewhere else. Sending the owner to
              Records answered "is my data there?" but left the dashboard —
              the page with the actual insights — permanently blank for them.
            */}
            <button
              type="button"
              onClick={() => setPeriodDays(0)}
              className="tap-inline font-semibold text-brand-700 underline underline-offset-2"
            >
              Show all time →
            </button>
          </Callout>
        </div>
      ) : null}

      {error ? (
        <p className="mb-4 rounded-lg bg-tint-danger p-3 text-sm text-tone-danger ring-1 ring-edge-danger">{error}</p>
      ) : null}

      {/* Doherty: the dashboard commits to its shape immediately on load and on
          every period / business switch, so the change feels instant even while
          the request is in flight. */}
      {loading || !summary ? (
        <SkeletonDashboard />
      ) : (
        // 8px scale throughout: 24px between the major bands, 20px inside a
        // band. Consistent vertical rhythm is what stops a dashboard reading
        // as a pile of unrelated cards.
        <div className="space-y-6">
          {/*
            Serial Position Effect — the order here is deliberate.

            FIRST: Available business funds. The single figure owners check most
            often ("how much do I actually have?"), so it takes the primacy slot.

            MIDDLE: expenses and sales. Important context, but they are read as a
            pair and are the least likely to be recalled individually — which is
            what the weak middle position is for.

            LAST: Recovery status, in its own full-width band. It is the
            actionable "so what" of the whole screen, and recency makes it the
            thing an owner leaves with.
          */}
          <div data-tour="dashboard-summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Available business funds"
              value={<span className="figure">{formatMoney(summary.overview.availableFunds)}</span>}
              meta="Owner-entered reference"
              glyph="◆"
              tone="brand"
            />
            <KpiCard
              label="Total expenses"
              value={<span className="figure">{formatMoney(summary.overview.totalExpenses)}</span>}
              meta={periodLabel}
              glyph="▾"
              tone="accent"
            />
            <KpiCard
              label="Total sales reference"
              value={<span className="figure">{formatMoney(summary.overview.totalSalesReference)}</span>}
              meta={periodLabel}
              glyph="▴"
              tone="info"
            />
            <KpiCard
              label="Recovery status"
              value={<span className="text-xl">{recovery.label}</span>}
              meta={recovery.meta}
              glyph="◎"
              tone={recovery.tone}
            />
          </div>

          {/*
            The mockup puts an "AI Summary" card here. This is the same
            surface, but the sentence below is composed from the figures
            already on this page — it is NOT AI-written, so it does not claim
            to be. Real AI lives one click away in Ask FinSight, where the
            answer is grounded and the disclaimer travels with it.
          */}
          <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr] xl:grid-cols-[2fr_1fr]">
            <AiCard
              title="This month at a glance"
              subtitle="Composed from your records — not AI-written"
              footer={
                <button
                  type="button"
                  onClick={() => askFinSight(expandQuestion)}
                  className="tap-inline font-semibold text-accent-200 underline-offset-2 hover:underline"
                >
                  Ask FinSight about any of this →
                </button>
              }
            >
              {topCategory ? (
                <>
                  <Kw>{topCategory.categoryName}</Kw> is your largest expense category{" "}
                  {periodLabel.toLowerCase()}, at{" "}
                  <Kw>
                    <span className="figure">{formatMoney(topCategory.total)}</span>
                  </Kw>
                  .{" "}
                </>
              ) : (
                <>No expenses recorded {periodLabel.toLowerCase()} yet. </>
              )}
              {summary.recoveryStatus.expectedMonthlyExpenses > 0 ? (
                <>
                  Sales reference so far this month is{" "}
                  <Kw>
                    <span className="figure">{formatMoney(summary.recoveryStatus.salesThisMonth)}</span>
                  </Kw>{" "}
                  against a monthly target of{" "}
                  <Kw>
                    <span className="figure">{formatMoney(summary.recoveryStatus.expectedMonthlyExpenses)}</span>
                  </Kw>
                  .{" "}
                </>
              ) : null}
              {summary.recordsNeedingReview > 0 ? (
                <>
                  <Kw>
                    {summary.recordsNeedingReview} record
                    {summary.recordsNeedingReview === 1 ? "" : "s"}
                  </Kw>{" "}
                  need{summary.recordsNeedingReview === 1 ? "s" : ""} review before being counted as settled.
                </>
              ) : (
                <>Nothing is waiting for review.</>
              )}
            </AiCard>

            <Panel
              title="Things to review"
              action={
                summary.recordsNeedingReview > 0 ? (
                  <Pill tone="warn">
                    {summary.recordsNeedingReview} item{summary.recordsNeedingReview === 1 ? "" : "s"}
                  </Pill>
                ) : (
                  <Pill tone="ok">All clear</Pill>
                )
              }
            >
              {summary.recordsNeedingReview === 0 ? (
                <p className="text-sm text-ink-500">
                  Nothing needs a second look right now. Flagged records show up here.
                </p>
              ) : (
                <Link
                  to="/records/flagged"
                  className="flex min-h-tap items-center gap-2 rounded-xl border border-paper-200 px-3.5 text-sm font-semibold text-tone-brand transition hover:border-brand-300 hover:bg-tint-brand"
                >
                  Open your review queue
                  <IconArrowRight className="ml-auto h-4 w-4" />
                </Link>
              )}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel eyebrow="Where your money went" title="Expense distribution" className="min-w-0">
              {summary.expenseCategoryBreakdown.length === 0 ? (
                <EmptyState compact title="No expenses in this period yet" icon="◔">
                  Once you record an expense, this is where you'll see which categories use the most.
                </EmptyState>
              ) : (
                <>
                  <DonutChart breakdown={summary.expenseCategoryBreakdown} />
                  {/* The bar view stays below the donut. A donut is good at
                      "what share", poor at "how much bigger" — the bars answer
                      the second question, and give a non-circular reading for
                      anyone the donut fails. */}
                  <div className="mt-5 border-t border-paper-200 pt-4">
                    <CategoryBreakdownChart breakdown={summary.expenseCategoryBreakdown} />
                  </div>
                </>
              )}
            </Panel>

            <Panel
              eyebrow="This month vs last month"
              title="Expense comparison"
              className="min-w-0"
              action={
                comparison && comparison.totals.previous > 0 ? (
                  <Pill tone={comparison.totals.current > comparison.totals.previous ? "warn" : "ok"}>
                    <span aria-hidden>
                      {comparison.totals.current > comparison.totals.previous
                        ? "▲"
                        : comparison.totals.current < comparison.totals.previous
                          ? "▼"
                          : "—"}
                    </span>
                    {Math.abs(
                      ((comparison.totals.current - comparison.totals.previous) / comparison.totals.previous) * 100,
                    ).toFixed(0)}
                    % vs last month
                  </Pill>
                ) : null
              }
            >
              {!comparison || comparison.categoryTrends.filter((t) => t.current > 0 || t.previous > 0).length === 0 ? (
                <EmptyState compact title="Not enough history yet" icon="◔">
                  Once you've recorded expenses in two consecutive months, this compares them side by side,
                  category by category.
                </EmptyState>
              ) : (
                <CategoryComparisonChart
                  trends={comparison.categoryTrends}
                  currentLabel="This month"
                  previousLabel="Last month"
                />
              )}
            </Panel>
          </div>

          {/* Recency slot — full width so it reads as the closing statement. */}
          <Panel
            eyebrow="Target-based recovery"
            title="Recovery target"
            action={<span className="text-xs text-ink-400">This month</span>}
          >
            {summary.recoveryStatus.expectedMonthlyExpenses > 0 ? (
              <RecoveryMeter recoveryStatus={summary.recoveryStatus} />
            ) : (
              <EmptyState compact title="Add your expected monthly expenses" icon="◎">
                FinSight needs to know roughly what a month costs you before it can work out a daily sales
                target.
              </EmptyState>
            )}
            <div className="mt-4 border-t border-paper-200 pt-3">
              <Link
                to="/insights/recovery"
                className="tap-inline text-sm font-semibold text-brand-700 hover:text-brand-800"
              >
                See the full recovery breakdown →
              </Link>
            </div>
          </Panel>

          {!hasAnyRecords ? (
            <EmptyState
              image="/mascot/01-onboarding/emptydashboard.webp"
              title="Nothing recorded in this period yet"
              action={
                <ButtonLink to="/records/expenses/new" variant="primary">
                  Add your first expense
                </ButtonLink>
              }
            >
              Your dashboard fills in as soon as you record something. Even a single day of expenses gives
              FinSight enough to work with.
            </EmptyState>
          ) : null}
        </div>
      )}

      <AskFinSightButton originModule="Dashboard" />
    </div>
  );
}
