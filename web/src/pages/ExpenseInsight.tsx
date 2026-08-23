import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { DonutChart } from "../components/DonutChart";
import { CategoryComparisonChart } from "../components/CategoryComparisonChart";
import { DailySpendChart } from "../components/DailySpendChart";
import { SkeletonPanel, SkeletonStatTile } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Button, ButtonLink } from "../components/Button";
import { formatMoney } from "../components/Money";
import { STATUS_INK } from "../lib/chartPalette";
import { RecurringAgenda } from "../components/RecurringAgenda";
import { AiCard, KpiCard, Kw, PageHead, Panel, Callout, Pill } from "../components/ui";
import type { AnomalyFinding, AnomalyFindingFeedback, AnomalyFindingPage, AnomalyFindingStatus, ExpenseBehavior as ExpenseInsightData, RecordItem, RecurringPattern, RecurringSchedule } from "../lib/types";

const PERIOD_OPTIONS = [
  { label: "This week", days: 7 },
  { label: "This month", days: 30 },
];

/**
 * Expense Insight.
 *
 * The audience is a small-business owner, not an accountant. So every panel
 * here answers a plain question in the order someone actually asks it:
 *
 *   1. How much did I spend, and is that a lot?      — the KPI row
 *   2. Where did it go?                              — Category distribution
 *   3. What changed since last time?                 — Category comparison
 *   4. The numbers, exactly                          — Category summary table
 *   5. Anything I should act on?                     — Large expense flags + FinSight's own read of the panel
 *   6. When did it leave?                            — Daily spending
 *   7. Anything odd, statistically?                  — Unusual expenses (Z-score)
 *
 * No panel assumes a term the reader might not have. "Exp. of available funds"
 * is written out as a share of the cash they told us they have; "biggest
 * increase" is a peso figure before it is a percentage.
 *
 * Every share percentage on this screen divides by the SAME server-computed
 * `totals.current`. That sounds obvious and is exactly what mixed-denominator
 * dashboards get wrong — a donut saying 59.6% beside a table saying 45.7% for
 * the same category destroys trust in every other number on the page.
 */

/**
 * Why a record showed up on the Large Expense Flags panel.
 *
 * Grounded in the exact rule the backend applies (expenseRecord.service.ts:
 * `amount >= expectedMonthlyExpenses * (largeExpenseThresholdPercent / 100)`),
 * so the reason line names a real, checkable threshold rather than a vague
 * "this seemed big". A record can carry a large-expense flag, a duplicate
 * flag, or both — the sentence says whichever actually applied.
 */
function flagReasons(
  record: RecordItem,
  profile: { expectedMonthlyExpenses: number; largeExpenseThresholdPercent: number },
): ReactNode[] {
  const reasons: ReactNode[] = [];
  if (record.largeExpenseFlag) {
    const thresholdAmount = profile.expectedMonthlyExpenses * (profile.largeExpenseThresholdPercent / 100);
    reasons.push(
      <>
        above your large-expense threshold ({profile.largeExpenseThresholdPercent}% of expected monthly expenses
        = <span className="figure">{formatMoney(thresholdAmount)}</span>)
      </>,
    );
  }
  if (record.duplicateStatus === "Flagged") {
    reasons.push(
      record.duplicateOfRecordId
        ? `a possible duplicate of record #${record.duplicateOfRecordId}`
        : "a possible duplicate of another record",
    );
  }
  return reasons.length > 0 ? reasons : ["flagged for a second look"];
}

/** Renders `flagReasons` joined with " · ", the same separator the plain-string version used. */
function FlagReason({
  record,
  profile,
}: {
  record: RecordItem;
  profile: { expectedMonthlyExpenses: number; largeExpenseThresholdPercent: number };
}) {
  const reasons = flagReasons(record, profile);
  return (
    <>
      {reasons.map((reason, i) => (
        <Fragment key={i}>
          {i > 0 ? " · " : null}
          {reason}
        </Fragment>
      ))}
    </>
  );
}

/** "▲ PHP 7,000" in the right status colour, or an em-dash for no movement. */
function ChangeFigure({ change, percent }: { change: number; percent: number | null }) {
  if (change === 0) {
    return <span className="figure text-ink-400">{formatMoney(0)}</span>;
  }
  const up = change > 0;
  return (
    // Spending MORE is the serious direction here, not the good one — this is
    // an expense screen, so up is bad. Colour is never the only signal: the
    // arrow and the sign say the same thing.
    <span className="figure font-semibold" style={{ color: up ? STATUS_INK.serious : STATUS_INK.good }}>
      <span aria-hidden>{up ? "▲" : "▼"}</span> {up ? "+" : "−"}
      {formatMoney(Math.abs(change))}
      {percent !== null && percent !== 0 ? (
        <span className="ml-1 text-[11px] font-medium opacity-80">
          {Math.abs(percent).toFixed(0)}%
        </span>
      ) : null}
    </span>
  );
}

// The panel is a summary, not the full review queue — FlaggedRecords already
// owns that job. Capped the same way the AI context builder caps it
// server-side (aiContext.service.ts: `take: 5`), so the two surfaces never
// disagree about what "a short list" means.
const MAX_FLAGGED_SHOWN = 5;

/**
 * Runs one SUPPLEMENTARY fetch in a way that cannot take the page down with it.
 *
 * This page draws from five endpoints, and it used to await all five in a
 * single `Promise.all`. `Promise.all` is all-or-nothing: one rejection
 * discarded the four responses that had already arrived, so a disabled
 * `/insights/recurring-schedules` — an optional panel at the very bottom —
 * replaced the KPI row, every chart, the category table and the flags with an
 * error banner. A transient 500 on `/insights/findings` would have done exactly
 * the same thing, which is why the fix is structural rather than a check for
 * status 404: nothing here asks WHY a supplement failed, only that its failure
 * stays inside its own panel. Status-sniffing would have left the identical
 * defect in place for every other failure mode.
 *
 * The core read (`/insights/expense-behavior`) deliberately does NOT go through
 * this. Without it there is no page to degrade, so its failure is still the
 * page's error.
 */
async function loadPanel<T>(
  request: Promise<{ data: T }>,
  apply: (value: T) => void,
  onUnavailable: () => void,
): Promise<void> {
  try {
    apply((await request).data);
  } catch {
    // Swallowed on purpose. The panel's own state now says "unavailable", and
    // an error banner for a secondary panel over a page that rendered fine
    // would be telling the owner their numbers are suspect when they are not.
    onUnavailable();
  }
}

export function ExpenseInsight() {
  const { selected } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  const [periodDays, setPeriodDays] = useState(30);
  /**
   * The day the window ends on, or null for "today".
   *
   * Set by the "Most recent month" option, which exists because every window
   * here is measured back from today and a business whose history was imported
   * can have its last expense a year ago — putting all of them in a gap, and
   * making the page report "no expenses recorded" to someone with hundreds.
   *
   * It is a real, selectable period rather than an automatic redirect. An
   * automatic one flips back the instant a single new expense is recorded,
   * yanking the owner out of the month they were reading and into a window
   * holding one record; and a page that silently decides what you are looking
   * at is one you cannot trust the labels on.
   */
  const [endDate, setEndDate] = useState<string | null>(null);
  const [data, setData] = useState<ExpenseInsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flaggedExpenses, setFlaggedExpenses] = useState<RecordItem[]>([]);
  const [findings, setFindings] = useState<AnomalyFinding[]>([]);
  const [recurringPatterns, setRecurringPatterns] = useState<RecurringPattern[]>([]);
  /**
   * Owner-declared schedules — the agenda. Distinct from the patterns above,
   * which are only what the detector suspects.
   *
   * NULL IS NOT THE EMPTY LIST. Null means the schedules endpoint did not
   * answer (the feature is switched off server-side, or the request failed),
   * and the agenda is then hidden outright. Rendering the empty state instead
   * would tell an owner "nothing scheduled yet" — a claim about their business
   * that we have no basis for, and one that is flatly false for anyone who has
   * schedules the server simply would not hand over.
   */
  const [recurringSchedules, setRecurringSchedules] = useState<RecurringSchedule[] | null>(null);
  // Sends the owner to /ai-chat. The plain floating trigger goes with no
  // question; the "expand on this" link below hands one through to be typed
  // into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Expense Insights");

  async function load() {
    if (!selected) return;
    const businessProfileId = selected.id;
    setLoading(true);
    setError(null);

    // Still fired together, so the page costs one round trip's worth of
    // latency as before — they are only SETTLED apart.
    const supplements = Promise.all([
      loadPanel(
        api.get<RecordItem[]>("/records/flagged", { params: { businessProfileId } }),
        (rows) =>
          setFlaggedExpenses(
            rows.filter((r) => r.type === "expense").sort((a, b) => (a.date < b.date ? 1 : -1)),
          ),
        () => setFlaggedExpenses([]),
      ),
      loadPanel(
        api.get<AnomalyFindingPage>("/insights/findings", {
          params: { businessProfileId, status: "OPEN", take: 20 },
        }),
        (page) => setFindings(page.items),
        () => setFindings([]),
      ),
      loadRecurring(),
    ]);

    try {
      const behavior = await api.get<ExpenseInsightData>("/insights/expense-behavior", {
        params: { businessProfileId, periodDays, ...(endDate ? { endDate } : {}) },
      });
      setData(behavior.data);
    } catch (err) {
      // The core read. Nothing on this page is readable without it, so this one
      // failure IS the page's failure.
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }

    // Awaited so the page is not still writing state after the caller believes
    // the load is done — `loadPanel` never rejects, so this cannot throw.
    await supplements;
  }

  async function reviewFinding(id: number, status: AnomalyFindingStatus, feedback: AnomalyFindingFeedback) {
    await api.patch(`/insights/findings/${id}/review`, { status, feedback });
    setFindings((current) => current.filter((finding) => finding.id !== id));
  }

  /**
   * Promotes a detector candidate into an owner-owned schedule.
   *
   * A POST to /confirm, not the old PATCH to `{ status: "CONFIRMED" }`. That
   * PATCH marked the pattern confirmed and nothing else, which made it vanish
   * from this panel with no schedule behind it and nowhere in the app to see it
   * again — the exact defect the agenda below exists to close. The server does
   * both writes in one transaction and seeds the label from the pattern's own
   * description, so nothing is sent in the body.
   */
  async function confirmPattern(id: number) {
    setError(null);
    try {
      await api.post(`/insights/recurring-patterns/${id}/confirm`);
      // Both lists move: the candidate leaves this panel and a schedule appears
      // in the agenda. Refetched rather than patched in state because the new
      // schedule's `dueState` is server-computed and this page must not guess it.
      await loadRecurring();
    } catch (err) {
      // 409 when the pattern already has a schedule — which happens if the
      // owner has this page open in two tabs. Said out loud rather than left
      // as an unhandled rejection with a button that appears to do nothing.
      setError(getErrorMessage(err));
    }
  }

  async function dismissPattern(id: number) {
    setError(null);
    try {
      await api.patch(`/insights/recurring-patterns/${id}`, { status: "DISMISSED" });
      setRecurringPatterns((current) =>
        current.map((pattern) => (pattern.id === id ? { ...pattern, status: "DISMISSED" } : pattern)),
      );
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  /**
   * The two recurring reads, settled independently.
   *
   * They are different endpoints with different availability: patterns is
   * ungated detector output, schedules is behind a server feature flag. Bundled
   * in a `Promise.all` they failed as one, so a dark schedules endpoint also
   * emptied the candidates panel that was working perfectly.
   */
  async function loadRecurring() {
    if (!selected) return;
    const businessProfileId = selected.id;
    await Promise.all([
      loadPanel(
        api.get<RecurringPattern[]>("/insights/recurring-patterns", { params: { businessProfileId } }),
        setRecurringPatterns,
        () => setRecurringPatterns([]),
      ),
      loadPanel(
        api.get<RecurringSchedule[]>("/insights/recurring-schedules", { params: { businessProfileId } }),
        setRecurringSchedules,
        // Null, not []. See the state declaration: hidden, not "none".
        () => setRecurringSchedules(null),
      ),
    ]);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodDays, endDate]);

  // A refetch with data already on screen is a refresh, not a load — see the
  // note on the skeleton below.
  const isInitialLoad = loading && !data;
  const isRefreshing = loading && !!data;

  /**
   * The month the owner's records actually end in, when that is somewhere the
   * ordinary windows cannot reach.
   *
   * Null in the normal case — a business recording daily has its latest expense
   * inside "This month" already, and offering a second button for the same
   * window under a stranger name would be worse than offering nothing.
   */
  const anchorMonth = useMemo(() => {
    const latest = data?.latestExpenseDate;
    if (!latest) return null;
    const latestTime = new Date(latest).getTime();
    // Reachable by the widest ordinary window (30 days back from today)? Then
    // there is nothing here the existing options do not already cover.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (latestTime >= thirtyDaysAgo) return null;
    return {
      endDate: latest.slice(0, 10),
      label: new Date(latest).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    };
  }, [data?.latestExpenseDate]);

  /** True while showing a window that ends somewhere other than today. */
  const isAnchored = endDate !== null;

  const periodLabel = isAnchored
    ? `in ${anchorMonth?.label ?? "that period"}`
    : periodDays === 7
      ? "this week"
      : "this month";
  const previousLabel = periodDays === 7 ? "Last week" : "Last month";

  /**
   * The schedules read doubles as the availability probe for everything that
   * WRITES a schedule — confirming a candidate creates one, and the server gates
   * both together. So if the agenda could not be read, "Watch this" cannot work
   * either, and it is not offered.
   */
  const canWatchPatterns = recurringSchedules !== null;
  const hasCandidates = recurringPatterns.some((pattern) => pattern.status === "CANDIDATE");
  // With no agenda and no candidates the whole block is an empty container.
  const showRecurringBlock = recurringSchedules !== null || hasCandidates;

  // ---- headline figures, all from one denominator ----
  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.totals.current;
    const spending = data.categoryTrends.filter((t) => t.current > 0);
    const top = spending[0] ?? null; // already sorted by current, descending

    // Biggest increase by PESO movement, not by percentage — a 300% rise on a
    // PHP 200 category is noise, and percentage ranking puts it first.
    const risen = [...data.categoryTrends].filter((t) => t.change > 0).sort((a, b) => b.change - a.change);

    const periodDelta = total - data.totals.previous;
    const periodPercent =
      data.totals.previous > 0 ? (periodDelta / data.totals.previous) * 100 : null;

    return {
      total,
      categoryCount: spending.length,
      top,
      topShare: top && total > 0 ? (top.current / total) * 100 : 0,
      biggestIncrease: risen[0] ?? null,
      periodDelta,
      periodPercent,
      // What share of the cash the owner says they have is going out. The
      // single most useful number here for someone with no accounting
      // background: it turns an abstract total into "this is how much of my
      // money that is".
      fundsShare:
        selected && selected.availableFunds > 0 ? (total / selected.availableFunds) * 100 : null,
    };
  }, [data, selected]);

  if (!selected) return null;

  function categoryName(categoryId?: number) {
    return categories.find((c) => c.id === categoryId)?.name ?? "—";
  }

  /**
   * The AI card's body — composed from figures already on this page, not
   * generated. Same reasoning as the Dashboard's "This month at a glance"
   * card: it can share a denominator with the KPI row above it and never
   * drift out of step with them, which an actual model call could.
   */
  const aiSummary = summary ? (
    <>
      {summary.top ? (
        <>
          <Kw>{summary.top.categoryName}</Kw> is your highest expense category {periodLabel}, making up{" "}
          <Kw>{summary.topShare.toFixed(1)}%</Kw> of recorded expenses.{" "}
        </>
      ) : (
        <>No expenses recorded {periodLabel} yet. </>
      )}
      {summary.biggestIncrease ? (
        <>
          <Kw>{summary.biggestIncrease.categoryName}</Kw> rose the most, up{" "}
          <Kw>
            <span className="figure">{formatMoney(summary.biggestIncrease.change)}</span>
          </Kw>{" "}
          compared with {previousLabel.toLowerCase()}, so it may be worth reviewing.
        </>
      ) : null}
    </>
  ) : null;

  // Names the exact category and figure the card above just named — a much
  // more useful starting point in the drawer than a generic "why did my
  // expenses increase?" that makes the owner retype what's already on screen.
  const expandQuestion = summary?.biggestIncrease
    ? `Why did ${summary.biggestIncrease.categoryName} increase by ${formatMoney(summary.biggestIncrease.change)} compared with ${previousLabel.toLowerCase()}?`
    : summary?.top
      ? `Why is ${summary.top.categoryName} my highest expense category ${periodLabel}?`
      : undefined;

  const periodPicker = (
    <div className="flex flex-wrap gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.days}
          type="button"
          onClick={() => {
            setPeriodDays(opt.days);
            setEndDate(null);
          }}
          aria-pressed={periodDays === opt.days && endDate === null}
          className={`tap rounded-lg px-3 text-[13.5px] font-semibold transition ${
            periodDays === opt.days && endDate === null
              ? "bg-paper text-brand-800 shadow-sm"
              : "text-ink-500 hover:text-brand-800"
          }`}
        >
          {opt.label}
        </button>
      ))}
      {/*
        Offered only when it would show something the other options cannot —
        i.e. the latest expense is outside the window they cover. A business
        recording daily never sees this button, because for them it would be a
        duplicate of "This month" under a stranger name.
      */}
      {anchorMonth ? (
        <button
          type="button"
          onClick={() => {
            setPeriodDays(30);
            setEndDate(anchorMonth.endDate);
          }}
          aria-pressed={endDate === anchorMonth.endDate}
          className={`tap rounded-lg px-3 text-[13.5px] font-semibold transition ${
            endDate === anchorMonth.endDate
              ? "bg-paper text-brand-800 shadow-sm"
              : "text-ink-500 hover:text-brand-800"
          }`}
        >
          {anchorMonth.label}
        </button>
      ) : null}
    </div>
  );

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Expense insight"
        subtitle={
          <>
            Expense Behavior Analysis — answers "What is happening with my expenses?"
          </>
        }
        actions={periodPicker}
      />

      <InsightsTabs />

      {error ? (
        <p className="mb-4 rounded-xl bg-tint-danger px-3.5 py-3 text-sm text-tone-danger ring-1 ring-edge-danger">
          {error}
        </p>
      ) : null}

      {/* Skeleton ONLY on the very first load.
          Switching period is a refetch of a page that is already on screen, and
          swapping it for a skeleton throws away a layout the reader is
          currently using, jumps the scroll position, and then throws the
          skeleton away too. Holding the previous render at reduced opacity says
          "same page, updating" — which is what is actually happening. */}
      {isInitialLoad ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading your expense insight…</span>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <SkeletonPanel lines={6} />
            <SkeletonPanel lines={6} />
          </div>
          <SkeletonPanel lines={5} />
        </div>
      ) : !data || !summary ? null : summary.total === 0 ? (
        /*
          TWO DIFFERENT EMPTINESSES, and they were getting the same screen.

          "You have never recorded an expense" and "you have hundreds, none of
          them recent" look identical from inside a 30-day window, and the old
          state answered both with "Add an expense / Import from a spreadsheet"
          — which told an owner who had just imported 527 expenses to go and
          import some expenses. That is not merely unhelpful; it is the app
          confidently contradicting something the owner just did.
        */
        anchorMonth ? (
          <EmptyState
            title={`No expenses ${periodLabel}`}
            icon="◔"
            action={
              /* A Button, not a ButtonLink: nothing is being navigated to. The
                 data is already loaded and this only moves the window — it is
                 the same control as the period option above. */
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  setPeriodDays(30);
                  setEndDate(anchorMonth.endDate);
                }}
              >
                Show {anchorMonth.label}
              </Button>
            }
          >
            Your records are here — the most recent one is dated{" "}
            {new Date(data.latestExpenseDate!).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
            . This page reads a window ending today, and there's nothing in the last{" "}
            {periodDays} days.
          </EmptyState>
        ) : (
          <EmptyState
            title={`No expenses recorded ${periodLabel}`}
            icon="◔"
            action={
              <>
                <ButtonLink to="/records/expenses/new" variant="primary">
                  Add an expense
                </ButtonLink>
                <ButtonLink to="/records/csv-imports/new" variant="secondary">
                  Import from a spreadsheet
                </ButtonLink>
              </>
            }
          >
            Once you record a few expenses, this page shows where your money goes, what changed since
            last period, and anything that looks unusual — in plain language.
          </EmptyState>
        )
      ) : (
        <div
          className={`space-y-6 transition-opacity duration-200 ${
            isRefreshing ? "pointer-events-none opacity-60" : ""
          }`}
          aria-busy={isRefreshing}
        >
          {/* ============================ 1. KPI ROW ============================
              Four headline numbers. These are stat tiles, not charts, because
              each is a single current value — a one-bar bar chart would be a
              worse way to show the same thing. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Total expenses"
              value={<span className="figure">{formatMoney(summary.total)}</span>}
              glyph="◆"
              tone="brand"
              meta={
                <>
                  Across {summary.categoryCount} categor{summary.categoryCount === 1 ? "y" : "ies"}
                  {summary.periodPercent !== null ? (
                    <>
                      {" · "}
                      <span
                        style={{
                          color: summary.periodDelta > 0 ? STATUS_INK.serious : STATUS_INK.good,
                        }}
                      >
                        {summary.periodDelta > 0 ? "▲" : summary.periodDelta < 0 ? "▼" : "—"}{" "}
                        {Math.abs(summary.periodPercent).toFixed(0)}% vs {previousLabel.toLowerCase()}
                      </span>
                    </>
                  ) : null}
                </>
              }
            />

            <KpiCard
              label="Highest category"
              value={<span className="text-xl">{summary.top?.categoryName ?? "—"}</span>}
              glyph="▣"
              tone="info"
              meta={
                summary.top ? (
                  <>
                    {summary.topShare.toFixed(1)}% of total ·{" "}
                    <span className="figure">{formatMoney(summary.top.current)}</span>
                  </>
                ) : (
                  "No spending yet"
                )
              }
            />

            <KpiCard
              label="Biggest increase"
              value={
                summary.biggestIncrease ? (
                  <span className="figure" style={{ color: STATUS_INK.serious }}>
                    +{formatMoney(summary.biggestIncrease.change)}
                  </span>
                ) : (
                  <span className="text-xl" style={{ color: STATUS_INK.good }}>
                    Nothing rose
                  </span>
                )
              }
              glyph="▲"
              tone={summary.biggestIncrease ? "danger" : "brand"}
              meta={
                summary.biggestIncrease
                  ? `${summary.biggestIncrease.categoryName} vs ${previousLabel.toLowerCase()}`
                  : `No category went up vs ${previousLabel.toLowerCase()}`
              }
            />

            <KpiCard
              label="Share of available funds"
              value={
                summary.fundsShare === null ? (
                  <span className="text-xl">—</span>
                ) : (
                  <span className="figure">{summary.fundsShare.toFixed(0)}%</span>
                )
              }
              glyph="◈"
              tone={summary.fundsShare !== null && summary.fundsShare > 75 ? "danger" : "accent"}
              meta={
                summary.fundsShare === null ? (
                  "Add available funds to your business profile"
                ) : (
                  <>
                    <span className="figure">{formatMoney(summary.total)}</span> of{" "}
                    <span className="figure">{formatMoney(selected.availableFunds)}</span>
                  </>
                )
              }
            />
          </div>

          {/* A plain-language warning, only when it is actually warranted. The
              KPI above states the number; this says what to do about it. */}
          {summary.fundsShare !== null && summary.fundsShare > 75 ? (
            <Callout tone="warn">
              Your spending {periodLabel} is{" "}
              <b className="font-semibold">{summary.fundsShare.toFixed(0)}%</b> of the funds you have on
              hand. That doesn't mean anything is wrong — but if sales don't cover it, this is the pace
              that runs the money down.
            </Callout>
          ) : null}

          {/* ================= 2 & 3. WHERE IT WENT / WHAT CHANGED ================= */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel eyebrow="Category share" title="Category distribution" className="min-w-0">
              <DonutChart
                breakdown={data.categoryTrends
                  .filter((t) => t.current > 0)
                  .map((t) => ({ categoryName: t.categoryName, total: t.current }))}
              />
            </Panel>

            <Panel
              eyebrow={`Current vs previous period`}
              title="Category comparison"
              className="min-w-0"
            >
              <CategoryComparisonChart
                trends={data.categoryTrends}
                currentLabel={periodDays === 7 ? "This week" : "This month"}
                previousLabel={previousLabel}
              />
            </Panel>
          </div>

          {/* ===================== 4. THE TABLE ===================== */}
          {/* The accessible reading of every chart above, and the relief the
              palette's contrast check requires: nothing on this page is
              knowable only by colour. */}
          <Panel
            eyebrow="The numbers"
            title="Category summary"
            action={
              <span className="text-xs text-ink-400">
                {data.periodStart.slice(0, 10)} → {data.periodEnd.slice(0, 10)}
              </span>
            }
            bodyClassName="px-0 pb-0"
          >
            <div className="scroll-slim overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Expenses by category for {selected.name}, {periodLabel}, compared with the previous
                  period.
                </caption>
                <thead>
                  <tr className="border-y border-paper-200 bg-paper-100/60">
                    <th scope="col" className="px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                      Category
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                      This period
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                      Share
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                      {previousLabel}
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                      Change
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.categoryTrends.map((t) => (
                    <tr key={t.categoryId} className="border-b border-paper-200 last:border-0">
                      <th scope="row" className="px-5 py-3 text-left font-medium text-ink-900">
                        {t.categoryName}
                      </th>
                      <td className="figure px-4 py-3 text-right font-semibold text-ink-900">
                        {formatMoney(t.current)}
                      </td>
                      <td className="figure px-4 py-3 text-right text-ink-600">
                        {summary.total > 0 ? ((t.current / summary.total) * 100).toFixed(1) : "0.0"}%
                      </td>
                      <td className="figure px-4 py-3 text-right text-ink-500">
                        {formatMoney(t.previous)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ChangeFigure change={t.change} percent={t.percentChange} />
                      </td>
                      <td className="figure px-5 py-3 text-right text-ink-600">{t.recordCount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-paper-200 bg-paper-100/60">
                    <th scope="row" className="px-5 py-3 text-left text-xs font-bold uppercase tracking-[0.06em] text-ink-600">
                      Total
                    </th>
                    <td className="figure px-4 py-3 text-right font-bold text-ink-900">
                      {formatMoney(summary.total)}
                    </td>
                    <td className="figure px-4 py-3 text-right text-ink-500">100.0%</td>
                    <td className="figure px-4 py-3 text-right text-ink-500">
                      {formatMoney(data.totals.previous)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChangeFigure change={summary.periodDelta} percent={summary.periodPercent} />
                    </td>
                    <td className="figure px-5 py-3 text-right text-ink-600">
                      {data.categoryTrends.reduce((s, t) => s + t.recordCount, 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>

          {/* ===================== 5. FLAGS + AI ===================== */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="Large expense flags"
              action={
                flaggedExpenses.length > 0 ? (
                  <Pill tone="danger">{flaggedExpenses.length} flagged</Pill>
                ) : (
                  <Pill tone="ok">All clear</Pill>
                )
              }
            >
              {flaggedExpenses.length === 0 ? (
                <EmptyState compact title="Nothing flagged right now" icon="✓">
                  Expenses land here once they cross your large-expense threshold or look like a possible
                  duplicate.
                </EmptyState>
              ) : (
                <>
                  <ul className="space-y-2">
                    {flaggedExpenses.slice(0, MAX_FLAGGED_SHOWN).map((r) => (
                      <li
                        key={r.id}
                        className="flex items-start gap-2.5 rounded-xl bg-tint-danger px-3.5 py-3 ring-1 ring-edge-danger"
                      >
                        <span aria-hidden className="mt-0.5 shrink-0 text-tone-danger">
                          ⚑
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <p className="min-w-0 text-sm font-semibold text-tone-danger">{r.description}</p>
                            <p className="figure shrink-0 text-sm font-bold text-tone-danger">
                              {formatMoney(r.amount)}
                            </p>
                          </div>
                          <p className="mt-1 text-xs text-tone-danger opacity-90">
                            {categoryName(r.categoryId)} · {r.date.slice(0, 10)} ·{" "}
                            <FlagReason record={r} profile={selected} />
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {flaggedExpenses.length > MAX_FLAGGED_SHOWN ? (
                    <Link
                      to="/records/flagged"
                      className="tap-inline mt-3 block text-sm font-semibold text-brand-700 hover:text-brand-800"
                    >
                      {flaggedExpenses.length - MAX_FLAGGED_SHOWN} more — review all flagged records →
                    </Link>
                  ) : null}
                  <p className="mt-3 text-xs text-ink-400">
                    A large-expense flag marks records worth a second look. It does not mean the expense is
                    wrong.
                  </p>
                </>
              )}
            </Panel>

            <AiCard
              title="FinSight explanation"
              subtitle="Scoped to Expense Insights — composed from your records, not AI-written"
              footer={
                <button
                  type="button"
                  onClick={() => askFinSight(expandQuestion)}
                  className="tap-inline font-semibold text-accent-200 underline-offset-2 hover:underline"
                >
                  Ask FinSight to expand on this →
                </button>
              }
            >
              {aiSummary}
            </AiCard>
          </div>

          {/* ===================== 6. WHEN IT LEFT ===================== */}
          <Panel
            eyebrow="Day by day"
            title="When your money left"
            action={<span className="text-xs text-ink-400">Last {data.periodDays} days</span>}
          >
            <DailySpendChart daily={data.dailyTotals} />
          </Panel>

          {/* ===================== 7. ANYTHING ODD (statistical) ===================== */}
          <Panel
            eyebrow="Worth a look"
            title="Unusual expenses"
            action={
              data.unusualExpenses.length > 0 ? (
                <span className="text-xs text-ink-400">
                  {data.unusualExpenses.length} flagged
                </span>
              ) : null
            }
          >
            {data.unusualExpenses.length === 0 ? (
              <EmptyState compact title="Nothing looks out of the ordinary" icon="✓">
                FinSight compares each expense against what you usually spend in that category. Nothing
                this period stood out.
              </EmptyState>
            ) : (
              <ul className="space-y-2">
                {data.unusualExpenses.map((u) => {
                  const times = u.categoryMean > 0 ? u.amount / u.categoryMean : null;
                  return (
                    <li
                      key={u.id}
                      className="rounded-xl bg-tint-accent px-3.5 py-3 ring-1 ring-edge-accent"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <p className="min-w-0 text-sm font-semibold text-tone-accent">{u.description}</p>
                        <p className="figure shrink-0 text-sm font-bold text-tone-accent">
                          {formatMoney(u.amount)}
                        </p>
                      </div>
                      {/* Said in multiples of the usual, not in standard
                          deviations. "About 4x your usual Inventory expense"
                          lands; "z-score 3.2" does not. */}
                      <p className="mt-1 text-xs text-tone-accent opacity-90">
                        {u.categoryName} · {u.date.slice(0, 10)} ·{" "}
                        {times && times >= 1.5 ? (
                          <>
                            about {times.toFixed(1)}× your usual{" "}
                            <span className="figure">{formatMoney(u.categoryMean)}</span>
                          </>
                        ) : (
                          <>
                            usually around <span className="figure">{formatMoney(u.categoryMean)}</span>
                          </>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            {data.insufficientHistoryCategories.length > 0 ? (
              <p className="mt-3 text-xs text-ink-400">
                Not enough history yet to check:{" "}
                {data.insufficientHistoryCategories.map((c) => c.categoryName).join(", ")}. FinSight needs
                a few expenses in a category before it can tell what "normal" looks like.
              </p>
            ) : null}
          </Panel>

          <Panel
            eyebrow="Review queue"
            title="FinSight findings"
            action={findings.length > 0 ? <span className="text-xs text-ink-400">{findings.length} open</span> : null}
          >
            {findings.length === 0 ? (
              <EmptyState compact title="No findings need review" icon="✓">
                FinSight will place explainable amount, duplicate, frequency, recurring, trend, and behavior findings here.
              </EmptyState>
            ) : (
              <ul className="space-y-3">
                {findings.map((finding) => (
                  <li key={finding.id} className="rounded-xl border border-paper-200 p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-ink-800">{finding.title}</p>
                      <Pill>{finding.severity.toLowerCase()}</Pill>
                    </div>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-500">
                      {finding.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                    {/*
                      Button primitives, not hand-rolled ones. These two were
                      the last raw <button>s carrying their own colour classes:
                      they missed the 44px tap floor every other button in the
                      app clears, and one of them named an `edge` step that
                      generates no CSS at all, so it silently fell back to
                      Tailwind's hard-coded #e5e7eb — a fixed grey that ignores
                      the theme and is wrong in Dark.

                      Only two of the five feedback values are reachable here,
                      on purpose: this panel is a SUMMARY beside the expense
                      figures, and the full set of answers (including "wrong
                      match", the one the duplicate detector most needs) lives
                      on the review queue, which the link below leads to.
                    */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void reviewFinding(finding.id, "CONFIRMED", finding.type === "POSSIBLE_DUPLICATE" ? "DUPLICATE" : "CONFIRMED_UNUSUAL")}
                      >
                        Confirm
                        <span className="sr-only"> — {finding.title}</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void reviewFinding(finding.id, "DISMISSED", "EXPECTED_TRANSACTION")}
                      >
                        Expected / dismiss
                        <span className="sr-only"> — {finding.title}</span>
                      </Button>
                      <Link
                        to="/records/flagged"
                        className="tap-inline text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        More options
                        <span className="sr-only"> for {finding.title}, on the review queue</span>
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

        </div>
      )}

      {/*
        THE RECURRING BLOCK SITS OUTSIDE THE PERIOD-SCOPED PAGE ABOVE, on
        purpose. Everything above is a reading of one window of expenses; a
        schedule is not — an overdue salary run is overdue whether or not
        anything was recorded in the last thirty days. Nested inside, it
        disappeared for exactly the owner most likely to have forgotten a
        payment: the one with an empty window.

        Agenda first, candidates second. The agenda is what the owner asked
        FinSight to watch; the candidates are FinSight asking a question back.
      */}
      {isInitialLoad || !showRecurringBlock ? null : (
        <div className="mt-6 space-y-6">
          {/* Hidden outright when the schedules read did not answer — an agenda
              saying "nothing scheduled yet" to an owner we cannot see the
              schedules of is a worse lie than showing nothing at all. */}
          {recurringSchedules !== null ? <RecurringAgenda schedules={recurringSchedules} /> : null}

          {hasCandidates ? (
            <Panel
              eyebrow="Suggested by FinSight"
              title="Does this repeat?"
              action={
                <span className="text-xs text-ink-400">
                  {canWatchPatterns ? "Not watched until you confirm" : "Detected from your records"}
                </span>
              }
            >
              <ul className="space-y-2">
                {recurringPatterns.filter((pattern) => pattern.status === "CANDIDATE").map((pattern) => (
                  <li
                    key={pattern.id}
                    className="rounded-xl border border-paper-200 bg-paper-100/60 px-3.5 py-3"
                  >
                    <p className="text-sm font-semibold text-ink-900">{pattern.description}</p>
                    <p className="mt-1 text-xs text-ink-500">
                      {pattern.category.name} · about every {pattern.intervalDays} days ·{" "}
                      <span className="figure">{formatMoney(pattern.expectedAmount)}</span>
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {/* HIDDEN, not disabled, when schedules are unavailable.
                          POST /recurring-patterns/:id/confirm sits behind the
                          same server gate as the schedules read, so the button
                          would 404 — and a disabled control still advertises a
                          capability, inviting the owner to hunt for what would
                          re-enable it. "Not recurring" stays: PATCH
                          /recurring-patterns/:id is ungated and still works, so
                          dismissing a bad guess remains available. */}
                      {canWatchPatterns ? (
                        <Button type="button" size="sm" onClick={() => void confirmPattern(pattern.id)}>
                          Watch this
                          <span className="sr-only"> — {pattern.description}</span>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void dismissPattern(pattern.id)}
                      >
                        Not recurring
                        <span className="sr-only"> — {pattern.description}</span>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}

      <AskFinSightButton originModule="Expense Insights" />
    </div>
  );
}
