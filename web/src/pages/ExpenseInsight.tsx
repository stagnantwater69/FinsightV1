import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconTile } from "../components/IconTile";
import { Link } from "react-router-dom";
import { isAxiosError } from "axios";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  ChartPie,
  Flag,
  Lightbulb,
  ListFilter,
  MessageCircleQuestion,
  Repeat,
  ShieldCheck,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import {
  AskFinSightButton,
  useAskFinSight,
} from "../components/AskFinSightButton";
import { DonutChart } from "../components/DonutChart";
import { CategoryComparisonChart } from "../components/CategoryComparisonChart";
import { DailySpendChart } from "../components/DailySpendChart";
import {
  SkeletonLine,
  SkeletonPanel,
  SkeletonStatTile,
} from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { SectionNav, type SectionNavItem } from "../components/SectionNav";
import { Button, ButtonLink } from "../components/Button";
import { formatMoney } from "../components/Money";
import { CATEGORICAL_PALETTE, STATUS_INK } from "../lib/chartPalette";

// The donut colours categories by rank, so the largest one is always slot 1.
// Slot 1 is byte-identical in the light and dark palettes (see the table in
// chartPalette.ts), which is why it can be read here without the theme hook.
const TOP_CATEGORY_COLOR = CATEGORICAL_PALETTE[0]!;
import { RecurringAgenda } from "../components/RecurringAgenda";
import { PageHead, Panel, Callout, Pill, type PillTone } from "../components/ui";
import { ReductionSimulationModal } from "../components/ReductionSimulationModal";
import { PeriodFilter } from "../components/PeriodFilter";
import { Pagination } from "../components/Pagination";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import {
  THIS_WEEK,
  periodLabel as periodCaptionOf,
  periodParams,
  periodPhrase,
  previousLabel as previousLabelOf,
  formatDayRange,
  type PeriodSelection,
} from "../lib/reportingPeriod";
import type {
  AnomalyFinding,
  AnomalyFindingFeedback,
  AnomalyFindingPage,
  AnomalyFindingStatus,
  ExpenseBehavior as ExpenseInsightData,
  FinancialPosition,
  FlaggedRecordCounts,
  FlaggedRecordPage,
  RecordItem,
  RecurringPattern,
  RecurringSchedule,
  ReductionOpportunity,
  ReductionOpportunityResponse,
} from "../lib/types";
import type { DetailExpenseOverview } from "../lib/expenseOverview";
import { useServerStateRefresh } from "../lib/useServerStateRefresh";
import {
  KpiTile,
  PairBars,
  ShareBar,
  Sparkline,
  UsualBar,
} from "./expenseInsight/ExpenseVisuals";
import { ExpenseSummaryCard } from "./expenseInsight/ExpenseSummaryCard";
import { ListDisclosureControl, useListDisclosure } from "../components/ListDisclosure";

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
 * No panel assumes a term the reader might not have. The funds share uses the
 * server's recorded balance; increases lead with pesos before percentages.
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
  profile: {
    expectedMonthlyExpenses: number;
    largeExpenseThresholdPercent: number;
  },
): ReactNode[] {
  const reasons: ReactNode[] = [];
  if (record.largeExpenseFlag) {
    const thresholdAmount =
      profile.expectedMonthlyExpenses *
      (profile.largeExpenseThresholdPercent / 100);
    reasons.push(
      <>
        above your large-expense threshold (
        {profile.largeExpenseThresholdPercent}% of your starting monthly estimate ={" "}
        <span className="figure">{formatMoney(thresholdAmount)}</span>)
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
  profile: {
    expectedMonthlyExpenses: number;
    largeExpenseThresholdPercent: number;
  };
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
function ChangeFigure({
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
      className="figure inline-flex items-center font-semibold"
      style={{ color: up ? STATUS_INK.serious : STATUS_INK.good }}
    >
      {up ? (
        <ArrowUpRight aria-hidden className="mr-1 size-3.5" />
      ) : (
        <ArrowDownRight aria-hidden className="mr-1 size-3.5" />
      )}
      {up ? "+" : "−"}
      {formatMoney(Math.abs(change))}
      {percent !== null && percent !== 0 ? (
        <span className="ml-1 text-[11px] font-medium opacity-80">
          {Math.abs(percent).toFixed(0)}%
        </span>
      ) : null}
    </span>
  );
}

/**
 * This page is intentionally comprehensive, but comprehensive should not mean
 * forcing an owner to remember where a section sits in a long scroll. The
 * compact index stays ordinary document navigation (real anchors, no hidden
 * state), so it works with keyboard, browser history, and reduced motion.
 */
function ExpenseSectionNav({
  showOpportunities,
  showRecurring,
}: {
  showOpportunities: boolean;
  showRecurring: boolean;
}) {
  const items: SectionNavItem[] = [
    { href: "#expense-overview", label: "Overview", icon: ChartPie },
    { href: "#expense-categories", label: "Categories", icon: Boxes },
    ...(showOpportunities
      ? [
          {
            href: "#expense-opportunities",
            label: "Opportunities",
            icon: Lightbulb,
          },
        ]
      : []),
    { href: "#expense-review", label: "Review", icon: Flag },
    ...(showRecurring
      ? [{ href: "#expense-recurring", label: "Recurring", icon: Repeat }]
      : []),
  ];

  return <SectionNav ariaLabel="Expense insight sections" items={items} />;
}

// The panel is a summary, not the full review queue — FlaggedRecords already
// owns that job. Capped the same way the AI context builder caps it
// server-side (aiContext.service.ts: `take: 5`), so the two surfaces never
// disagree about what "a short list" means.
const MAX_FLAGGED_SHOWN = 5;

/** Severity is named by the pill; the icon beside it is the uniform tile. */
const FINDING_SEVERITY_LOOK: Record<string, { pill: PillTone }> = {
  HIGH: { pill: "danger" },
  MEDIUM: { pill: "warn" },
  LOW: { pill: "neutral" },
};

/**
 * How many flagged records this panel's short list asks the server for.
 *
 * It only ever shows five expenses, but the flagged list is expenses and sales
 * interleaved by date, so it asks for one page and filters. What it must NOT
 * do is what it did before — send no bound and take the whole flagged history
 * of the business (megabytes, on a re-imported spreadsheet) to render five
 * rows and a count. The count comes from /records/flagged/count now.
 */
const FLAGGED_PANEL_PAGE_SIZE = 100;

// The backend already caps `opportunities` at three (plan §4.6, §8.3), but the
// UI does not trust that as its only guarantee — a future server bug here
// would otherwise overwhelm the exact owner this feature is meant to help.
const MAX_OPPORTUNITIES_SHOWN = 3;

const FINDINGS_PER_PAGE = 3;

const OPPORTUNITY_PRIORITY_LABEL: Record<
  ReductionOpportunity["priority"],
  string
> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

const OPPORTUNITY_PRIORITY_TONE: Record<
  ReductionOpportunity["priority"],
  "danger" | "warn" | "neutral"
> = {
  high: "danger",
  medium: "warn",
  low: "neutral",
};

const OPPORTUNITY_CONFIDENCE_LABEL: Record<
  ReductionOpportunity["confidence"],
  string
> = {
  strong: "Strong confidence",
  moderate: "Moderate confidence",
  limited: "Limited confidence",
};

/**
 * Cost-behavior classification — plan §5.2/§15 Phase 5. The badge and the
 * caution note below are evidence/copy only: the backend's suggested-check
 * catalogue (`COST_BEHAVIOR_SUGGESTED_CHECK_CATALOGUE`) already tailors the
 * checks this card renders per cost-behavior, so this file adds only what
 * that catalogue does NOT already say — the label itself, and a short note
 * for the two classifications where "review the usual way" undersells what's
 * actually worth checking. `variant`/`unclassified` get no note: the base
 * checks already cover ordinary review, and unclassified is the default for
 * most categories today.
 */
const OPPORTUNITY_COST_BEHAVIOR_LABEL: Record<
  ReductionOpportunity["costBehavior"],
  string
> = {
  fixed: "Fixed cost",
  variable: "Variable cost",
  mixed: "Mixed cost",
  unclassified: "",
};

const OPPORTUNITY_COST_BEHAVIOR_NOTE: Partial<
  Record<ReductionOpportunity["costBehavior"], string>
> = {
  fixed: "Fixed cost: check the contract or whether it is still needed.",
  mixed: "Mixed cost: part stays flat, part changes with activity.",
};

/**
 * The two or three evidence figures printed on each card, per plan §10.2.
 *
 * Chosen per opportunity type so the figures actually explain the type's own
 * eligibility rule (§7.2) rather than repeating the same generic pair on every
 * card regardless of why it appeared.
 */
function evidenceFigures(
  o: ReductionOpportunity,
): { label: string; value: ReactNode }[] {
  const e = o.evidence;
  const currentAmount = {
    label: "Current spend",
    value: <span className="figure">{formatMoney(e.currentAmount)}</span>,
  };
  const share = {
    label: "Share of expenses",
    value: <span className="figure">{e.expenseSharePercent.toFixed(1)}%</span>,
  };
  const change =
    e.changeAmount !== null
      ? {
          label: "Change",
          value: (
            <ChangeFigure change={e.changeAmount} percent={e.changePercent} />
          ),
        }
      : {
          label: "Change",
          value: <span className="text-ink-500">No earlier data</span>,
        };
  const records = {
    label: "Records",
    value: <span className="figure">{e.recordCount}</span>,
  };
  const flagged = {
    label: "Flagged for review",
    value: (
      <span className="figure">
        {e.possibleDuplicateCount + e.unusualRecordCount}
      </span>
    ),
  };

  if (o.type === "RECORD_REVIEW_FIRST")
    return [currentAmount, flagged, records];
  if (o.type === "FREQUENT_PURCHASE_ACCUMULATION")
    return [currentAmount, records, share];
  return [currentAmount, share, change];
}

/** Plan §11.1's own worked example — kept as one constant so every card asks it identically. */
const OPPORTUNITY_ASK_QUESTION =
  "Why was this reduction opportunity selected, and what should I check first?";

/**
 * One opportunity card — priority/confidence, observation, evidence,
 * rationale, suggested checks, limitations, and its three implemented
 * actions in the plan's own order (§10.2: "Do not render disabled
 * placeholder actions" — every action below has an implemented destination).
 */
function OpportunityCard({
  opportunity,
  businessProfileId,
  period,
}: {
  opportunity: ReductionOpportunity;
  businessProfileId: number;
  period: PeriodSelection;
}) {
  // Its own hook instance rather than a prop threaded down from the page:
  // the card is the thing that knows which opportunity was clicked, and the
  // module never varies, so there is nothing for a shared instance to buy.
  const askFinSight = useAskFinSight("Expense Insights");
  const [simulateOpen, setSimulateOpen] = useState(false);

  // Feedback — plan §15 Phase 5. Write-only: the backend has no read-back
  // endpoint for prior feedback, so this always starts unset on load, even
  // for an opportunity the owner already rated on a previous visit. Kept
  // per-card rather than lifted to the page: nothing else on the page needs
  // to know it.
  const [feedbackRating, setFeedbackRating] = useState<
    "helpful" | "not_relevant" | null
  >(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState<
    "helpful" | "not_relevant" | null
  >(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  async function submitFeedback(rating: "helpful" | "not_relevant") {
    setFeedbackSubmitting(rating);
    setFeedbackError(null);
    try {
      await api.post("/insights/reduction-opportunities/feedback", {
        businessProfileId,
        opportunityId: opportunity.id,
        rating,
      });
      // Upserted server-side, so clicking the other button afterwards reads
      // as "changing your answer" rather than an error — never blocked once
      // a rating is already set.
      setFeedbackRating(rating);
    } catch (err) {
      setFeedbackError(getErrorMessage(err));
    } finally {
      setFeedbackSubmitting(null);
    }
  }

  const costBehaviorLabel =
    OPPORTUNITY_COST_BEHAVIOR_LABEL[opportunity.costBehavior];
  const costBehaviorNote =
    OPPORTUNITY_COST_BEHAVIOR_NOTE[opportunity.costBehavior];

  return (
    <li className="overflow-hidden rounded-2xl border border-paper-200 bg-paper transition hover:border-brand-200">
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-paper-100 text-brand-700 ring-1 ring-paper-200"
          >
            <TrendingUp className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-base font-semibold text-ink-900">
                  {opportunity.categoryName}
                </p>
                <p className="mt-0.5 text-sm text-ink-600">
                  {opportunity.observation}
                </p>
              </div>
              <Pill tone={OPPORTUNITY_PRIORITY_TONE[opportunity.priority]}>
                {OPPORTUNITY_PRIORITY_LABEL[opportunity.priority]}
              </Pill>
            </div>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-paper-200 py-3 sm:grid-cols-3">
          {evidenceFigures(opportunity).map((fig) => (
            <div key={fig.label} className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                {fig.label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink-900">
                {fig.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link
            to={`/records?type=expense&categoryId=${opportunity.categoryId}`}
            aria-label={`View related records for ${opportunity.categoryName}`}
            className="tap-inline inline-flex items-center text-xs link-action"
          >
            <ListFilter
              aria-hidden
              className="mr-1.5 size-3.5"
            />
            View records
            <span className="sr-only"> for {opportunity.categoryName}</span>
          </Link>
          <button
            type="button"
            aria-label={`Ask FinSight about this reduction opportunity for ${opportunity.categoryName}`}
            onClick={() => askFinSight(OPPORTUNITY_ASK_QUESTION, opportunity)}
            className="tap-inline inline-flex items-center text-xs link-action"
          >
            <MessageCircleQuestion
              aria-hidden
              className="mr-1.5 size-3.5"
            />
            Ask FinSight
            <span className="sr-only">
              {" "}
              reduction opportunity for {opportunity.categoryName}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSimulateOpen(true)}
            className="tap-inline inline-flex items-center text-xs link-action"
          >
            <SlidersHorizontal
              aria-hidden
              className="mr-1.5 size-3.5"
            />
            Simulate reduction
            <span className="sr-only"> for {opportunity.categoryName}</span>
          </button>
        </div>

        <details className="group mt-3 border-t border-paper-200 pt-3">
          <summary className="disclosure">
            <span className="group-open:hidden">Details</span>
            <span className="hidden group-open:inline">Hide details</span>
          </summary>
          <div className="mt-3 rounded-xl bg-paper-100 p-3.5">
            <div className="flex flex-wrap gap-2">
              <Pill tone="neutral">
                {OPPORTUNITY_CONFIDENCE_LABEL[opportunity.confidence]}
              </Pill>
              {costBehaviorLabel ? (
                <Pill tone="info">{costBehaviorLabel}</Pill>
              ) : null}
            </div>
            <p className="mt-3 text-xs text-ink-600">
              <span className="font-semibold text-ink-700">Why: </span>
              {opportunity.rationale}
            </p>
            {costBehaviorNote ? (
              <div className="mt-3">
                <Callout tone="info">{costBehaviorNote}</Callout>
              </div>
            ) : null}
            {opportunity.suggestedChecks.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-semibold text-ink-700">
                  Suggested checks
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-600">
                  {opportunity.suggestedChecks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {opportunity.limitations.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-semibold text-ink-700">
                  Limitations
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-600">
                  {opportunity.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>

        {/*
        Helpful / Not relevant — plan §15 Phase 5. Two toggle-style buttons
        rather than a single control: the question is "was this worth
        showing you", and either answer is a legitimate, equally-weighted
        response, not a default/override pair.
      */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-paper-200 pt-3">
          <span className="text-xs text-ink-500">Useful?</span>
          <button
            type="button"
            aria-pressed={feedbackRating === "helpful"}
            disabled={feedbackSubmitting !== null}
            onClick={() => void submitFeedback("helpful")}
            className={`tap-inline inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${
              feedbackRating === "helpful"
                ? "bg-tint-brand text-tone-brand ring-edge-brand"
                : "text-ink-500 ring-ink-200 hover:bg-paper-100"
            }`}
          >
            <ThumbsUp aria-hidden className="mr-1 size-3.5" />
            Helpful
            <span className="sr-only"> — {opportunity.categoryName}</span>
          </button>
          <button
            type="button"
            aria-pressed={feedbackRating === "not_relevant"}
            disabled={feedbackSubmitting !== null}
            onClick={() => void submitFeedback("not_relevant")}
            className={`tap-inline inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${
              feedbackRating === "not_relevant"
                ? "bg-tint-neutral text-tone-neutral ring-edge-neutral"
                : "text-ink-500 ring-ink-200 hover:bg-paper-100"
            }`}
          >
            <ThumbsDown
              aria-hidden
              className="mr-1 size-3.5"
            />
            Not relevant
            <span className="sr-only"> — {opportunity.categoryName}</span>
          </button>
          {feedbackRating ? (
            <span className="text-xs text-ink-500" role="status">
              Saved
            </span>
          ) : feedbackError ? (
            <span className="text-xs text-tone-danger" role="alert">
              {feedbackError}
            </span>
          ) : null}
        </div>
      </div>

      <ReductionSimulationModal
        open={simulateOpen}
        onClose={() => setSimulateOpen(false)}
        businessProfileId={businessProfileId}
        categoryId={opportunity.categoryId}
        categoryName={opportunity.categoryName}
        period={period}
        baseline={opportunity.evidence.currentAmount}
      />
    </li>
  );
}

/**
 * Runs one SUPPLEMENTARY fetch in a way that cannot take the page down with it.
 *
 * This page draws from several endpoints, and it used to await them in a
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
 * The composite expense-overview read deliberately does NOT go through this.
 * Without its behavior panel there is no page to degrade, so that panel's
 * failure is still the page's error.
 */
async function loadPanel<T>(
  request: Promise<{ data: T }>,
  apply: (value: T) => void,
  onUnavailable: (error: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const value = (await request).data;
    // A superseded request must not write anything: the panel belongs to the
    // business profile that is on screen NOW, not the one this was asked for.
    if (signal?.aborted) return;
    apply(value);
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") return;
    // Swallowed on purpose. The panel's own state now says "unavailable", and
    // an error banner for a secondary panel over a page that rendered fine
    // would be telling the owner their numbers are suspect when they are not.
    onUnavailable(error);
  }
}

type SupplementState = "loading" | "ready" | "stale" | "unavailable";

function failedSupplementState(current: SupplementState): SupplementState {
  return current === "ready" || current === "stale" ? "stale" : "unavailable";
}

function combinedSupplementState(states: readonly SupplementState[]): SupplementState {
  if (states.some((state) => state === "unavailable")) return "unavailable";
  if (states.some((state) => state === "stale")) return "stale";
  if (states.some((state) => state === "loading")) return "loading";
  return "ready";
}

function SupplementNotice({ state, label }: { state: SupplementState; label: string }) {
  if (state === "ready" || state === "loading") return null;
  return (
    <p role="status" className="mb-3 text-xs text-tone-accent">
      {state === "stale"
        ? `Showing recently loaded ${label}; the latest refresh failed.`
        : `${label[0]!.toUpperCase()}${label.slice(1)} are temporarily unavailable.`}
    </p>
  );
}

function isDefinitiveScheduleUnavailable(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}

export function ExpenseInsight() {
  return (
    <ReportingPeriodScope scope="expense-insight">
      <ExpenseInsightPage />
    </ReportingPeriodScope>
  );
}

function ExpenseInsightPage() {
  const { selected, getFinancialPosition } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  const {
    selection: sharedSelection,
    setSelection,
    ready: periodReady,
  } = useReportingPeriod();
  // Normalize unsupported All time before this page builds a request.
  const selection: PeriodSelection =
    sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  const periodKey = JSON.stringify(selection);
  const allTime = selection.kind === "all";
  const expenseScopeKey = JSON.stringify({
    businessProfileId: selected?.id ?? null,
    period: selection,
    periodReady,
  });
  const activeExpenseScopeRef = useRef(expenseScopeKey);
  activeExpenseScopeRef.current = expenseScopeKey;

  useEffect(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [setSelection, sharedSelection]);
  const [data, setData] = useState<ExpenseInsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [flaggedExpenses, setFlaggedExpenses] = useState<RecordItem[]>([]);
  const [flaggedListState, setFlaggedListState] = useState<SupplementState>("loading");
  /**
   * How many flagged expenses exist, as opposed to how many are on screen.
   * `null` means the count request didn't answer, in which case the panel
   * falls back to counting what it managed to load rather than claiming a
   * number it doesn't have.
   */
  const [flaggedExpenseCount, setFlaggedExpenseCount] = useState<number | null>(null);
  const [flaggedCountState, setFlaggedCountState] = useState<SupplementState>("loading");
  const [findings, setFindings] = useState<AnomalyFinding[]>([]);
  const [findingsState, setFindingsState] = useState<SupplementState>("loading");
  // Three to a page: each finding is a tall card with its own actions, and a
  // long run of them pushed the rest of the page out of reach.
  const [findingsPage, setFindingsPage] = useState(1);
  // Another period or business is a different list; start it from the top.
  const findingsScopeKey = `${selected?.id ?? ""}:${periodKey}`;
  const [findingsPageScope, setFindingsPageScope] = useState(findingsScopeKey);
  if (findingsPageScope !== findingsScopeKey) {
    setFindingsPageScope(findingsScopeKey);
    setFindingsPage(1);
  }
  const [recurringPatterns, setRecurringPatterns] = useState<
    RecurringPattern[]
  >([]);
  const [patternsState, setPatternsState] = useState<SupplementState>("loading");
  /**
   * Owner-declared schedules — the agenda. Distinct from the patterns above,
   * which are only what the detector suspects.
   *
   * NULL IS NOT THE EMPTY LIST. Null means there is no usable schedules
   * snapshot, so the agenda is hidden outright. A failed refresh keeps an
   * existing snapshot and marks it stale instead of turning known payments
   * into a false empty or unavailable state.
   */
  const [recurringSchedules, setRecurringSchedules] = useState<
    RecurringSchedule[] | null
  >(null);
  const [schedulesState, setSchedulesState] = useState<SupplementState>("loading");
  /**
   * Reduction opportunities — a self-contained panel with its own error/retry
   * state (plan §10.3), unlike the supplements above that fail silently into
   * "unavailable". A deterministic review prompt is useful enough on its own
   * that a transient failure here deserves an explicit retry, not a quiet
   * disappearance.
   */
  const [reductionOpportunities, setReductionOpportunities] =
    useState<ReductionOpportunityResponse | null>(null);
  const [reductionLoading, setReductionLoading] = useState(true);
  const [reductionError, setReductionError] = useState<string | null>(null);
  const [financialPosition, setFinancialPosition] =
    useState<FinancialPosition | null>(null);
  const [financialPositionProfileId, setFinancialPositionProfileId] =
    useState<number | null>(null);
  const [financialPositionLoading, setFinancialPositionLoading] =
    useState(false);
  const [financialPositionError, setFinancialPositionError] = useState<
    string | null
  >(null);
  const [financialPositionReload, setFinancialPositionReload] = useState(0);
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the "expand on this" link below hands one through to
  // be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Expense Insights");

  useEffect(() => {
    if (!selected) {
      setFinancialPosition(null);
      setFinancialPositionProfileId(null);
      setFinancialPositionLoading(false);
      setFinancialPositionError(null);
      return;
    }

    const businessProfileId = selected.id;
    const controller = new AbortController();
    setFinancialPosition(null);
    setFinancialPositionProfileId(businessProfileId);
    setFinancialPositionLoading(true);
    setFinancialPositionError(null);

    void (async () => {
      try {
        const next = await getFinancialPosition(
          businessProfileId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!Number.isFinite(next.availableFunds?.calculatedAmount)) {
          throw new Error("Recorded available funds are unavailable.");
        }
        setFinancialPosition(next);
      } catch (err) {
        if (controller.signal.aborted) return;
        setFinancialPositionError(getErrorMessage(err));
      } finally {
        if (!controller.signal.aborted) setFinancialPositionLoading(false);
      }
    })();

    return () => controller.abort();
    // The provider recreates this method when its profile list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected?.id,
    selected?.availableFunds,
    selected?.availableFundsBaselineAt,
    financialPositionReload,
  ]);

  function applyExpenseOverview(overview: DetailExpenseOverview) {
    setRefreshError(null);
    if (overview.behavior.status === "available") {
      setData(overview.behavior.data);
      setError(null);
    } else {
      setData(null);
      setError("The expense behavior panel is temporarily unavailable.");
    }

    if (overview.opportunities.status === "available") {
      setReductionOpportunities(overview.opportunities.data);
      setReductionError(null);
    } else {
      setReductionOpportunities(null);
      setReductionError("Please try again.");
    }
  }

  /** One owned-context computation supplies the two core panels independently. */
  async function loadExpenseOverview(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected || !periodReady) return;
    const params = {
      businessProfileId: selected.id,
      ...periodParams(selection),
      view: "detail" as const,
    };
    const scope = {
      businessProfileId: selected.id,
      period: selection,
      tags: ["expense-insight", "financial", "expense-overview"],
    };
    const cached = peekCachedApiData<DetailExpenseOverview>(
      "/insights/expense-overview",
      { params },
      scope,
    );

    if (cached) {
      applyExpenseOverview(cached.data);
    } else if (!force) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setReductionOpportunities(null);
      setReductionError(null);
    }
    setLoading(!cached || cached.stale || force);
    setReductionLoading(!cached || cached.stale || force);

    try {
      const { data: overview } = await cachedApiGet<DetailExpenseOverview>(
        "/insights/expense-overview",
        { signal, params },
        scope,
        { force },
      );
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      applyExpenseOverview(overview);
    } catch (err) {
      if (
        signal?.aborted ||
        (err as { name?: string })?.name === "AbortError" ||
        activeExpenseScopeRef.current !== requestScopeKey
      ) return;
      const message = getErrorMessage(err);
      if (cached?.data.behavior.status === "available" || (force && data)) {
        setRefreshError(message);
      } else if (!cached) {
        setData(null);
        setError(message);
        setReductionOpportunities(null);
        setReductionError(message);
      }
    } finally {
      if (!signal?.aborted && activeExpenseScopeRef.current === requestScopeKey) {
        setLoading(false);
        setReductionLoading(false);
      }
    }
  }

  async function loadSupplementPanels(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected || !periodReady) return;
    const businessProfileId = selected.id;
    const flaggedParams = { businessProfileId, limit: FLAGGED_PANEL_PAGE_SIZE };
    const flaggedScope = {
      businessProfileId,
      filters: { flagged: true, type: "all" },
      pagination: { cursor: null, limit: FLAGGED_PANEL_PAGE_SIZE },
      tags: ["records", "financial"],
    };
    const flaggedCountParams = { businessProfileId };
    const flaggedCountScope = {
      businessProfileId,
      filters: { flagged: true },
      tags: ["records", "financial"],
    };
    const findingsParams = { businessProfileId, status: "OPEN", take: 20 };
    const findingsScope = {
      businessProfileId,
      filters: { status: "OPEN" },
      pagination: { cursor: null, limit: 20 },
      tags: ["insights-findings", "financial"],
    };
    const applyFlaggedPage = (page: FlaggedRecordPage) =>
      setFlaggedExpenses(
        page.items
          .filter((record) => record.type === "expense")
          .sort((left, right) => (left.date < right.date ? 1 : -1)),
      );

    const cachedFlagged = peekCachedApiData<FlaggedRecordPage>(
      "/records/flagged",
      { params: flaggedParams },
      flaggedScope,
    );
    const cachedFlaggedCount = peekCachedApiData<FlaggedRecordCounts>(
      "/records/flagged/count",
      { params: flaggedCountParams },
      flaggedCountScope,
    );
    const cachedFindings = peekCachedApiData<AnomalyFindingPage>(
      "/insights/findings",
      { params: findingsParams },
      findingsScope,
    );
    if (cachedFlagged) {
      applyFlaggedPage(cachedFlagged.data);
      setFlaggedListState("ready");
    } else if (!force) {
      setFlaggedExpenses([]);
      setFlaggedListState("loading");
    }
    if (cachedFlaggedCount) {
      setFlaggedExpenseCount(cachedFlaggedCount.data.expenses);
      setFlaggedCountState("ready");
    } else if (!force) {
      setFlaggedExpenseCount(null);
      setFlaggedCountState("loading");
    }
    if (cachedFindings) {
      setFindings(cachedFindings.data.items);
      setFindingsState("ready");
    } else if (!force) {
      setFindings([]);
      setFindingsState("loading");
    }

    // Fired together; each supplement still settles independently.
    await Promise.all([
      loadPanel(
        cachedApiGet<FlaggedRecordPage>(
          "/records/flagged",
          { signal, params: flaggedParams },
          flaggedScope,
          { force },
        ),
        (page) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            applyFlaggedPage(page);
            setFlaggedListState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFlaggedListState(failedSupplementState);
          }
        },
        signal,
      ),
      loadPanel(
        cachedApiGet<FlaggedRecordCounts>(
          "/records/flagged/count",
          { signal, params: flaggedCountParams },
          flaggedCountScope,
          { force },
        ),
        (counts) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFlaggedExpenseCount(counts.expenses);
            setFlaggedCountState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFlaggedCountState(failedSupplementState);
          }
        },
        signal,
      ),
      loadPanel(
        cachedApiGet<AnomalyFindingPage>(
          "/insights/findings",
          { signal, params: findingsParams },
          findingsScope,
          { force },
        ),
        (page) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFindings(page.items);
            setFindingsState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFindingsState(failedSupplementState);
          }
        },
        signal,
      ),
    ]);
  }

  async function load(signal?: AbortSignal, forceOverview = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    /*
     * No business — an owner who chose "Skip for now". Settles instead of
     * bailing: `loading` starts true and `isInitialLoad` is `loading && !data`,
     * so a silent return left this page under its skeleton for good.
     */
    if (!selected) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setLoading(false);
      setReductionOpportunities(null);
      setReductionError(null);
      setReductionLoading(false);
      setFlaggedExpenses([]);
      setFlaggedExpenseCount(null);
      setFindings([]);
      setRecurringPatterns([]);
      setRecurringSchedules(null);
      setFlaggedListState("ready");
      setFlaggedCountState("ready");
      setFindingsState("ready");
      setPatternsState("ready");
      setSchedulesState("ready");
      return;
    }
    // Wait for the period's default so the page loads once, for the right period.
    if (!periodReady) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setLoading(true);
      setReductionOpportunities(null);
      setReductionError(null);
      setReductionLoading(true);
      setFlaggedExpenses([]);
      setFlaggedExpenseCount(null);
      setFindings([]);
      setRecurringPatterns([]);
      setRecurringSchedules(null);
      setFlaggedListState("loading");
      setFlaggedCountState("loading");
      setFindingsState("loading");
      setPatternsState("loading");
      setSchedulesState("loading");
      return;
    }

    await Promise.all([
      loadExpenseOverview(signal, forceOverview),
      loadSupplementPanels(signal, forceOverview),
      loadRecurring(signal, forceOverview),
    ]);
  }

  async function reviewFinding(
    id: number,
    status: AnomalyFindingStatus,
    feedback: AnomalyFindingFeedback,
  ) {
    if (!selected) return;
    const requestScopeKey = expenseScopeKey;
    await api.patch(
      `/insights/findings/${id}/review`,
      { status, feedback },
      { serverStateScope: { businessProfileId: selected.id } },
    );
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
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
    const requestScopeKey = expenseScopeKey;
    setError(null);
    try {
      await api.post(`/insights/recurring-patterns/${id}/confirm`, undefined, {
        serverStateScope: { businessProfileId: selected!.id },
      });
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      // Both lists move: the candidate leaves this panel and a schedule appears
      // in the agenda. Refetched rather than patched in state because the new
      // schedule's `dueState` is server-computed and this page must not guess it.
      await loadRecurring();
    } catch (err) {
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      // 409 when the pattern already has a schedule — which happens if the
      // owner has this page open in two tabs. Said out loud rather than left
      // as an unhandled rejection with a button that appears to do nothing.
      setError(getErrorMessage(err));
    }
  }

  async function dismissPattern(id: number) {
    const requestScopeKey = expenseScopeKey;
    setError(null);
    try {
      await api.patch(
        `/insights/recurring-patterns/${id}`,
        { status: "DISMISSED" },
        { serverStateScope: { businessProfileId: selected!.id } },
      );
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      setRecurringPatterns((current) =>
        current.map((pattern) =>
          pattern.id === id ? { ...pattern, status: "DISMISSED" } : pattern,
        ),
      );
    } catch (err) {
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      setError(getErrorMessage(err));
    }
  }

  async function loadRecurringSchedules(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected) return;
    const businessProfileId = selected.id;
    const schedulesParams = { businessProfileId };
    const schedulesScope = {
      businessProfileId,
      tags: ["recurring-schedules", "financial"],
    };
    const cachedSchedules = peekCachedApiData<RecurringSchedule[]>(
      "/insights/recurring-schedules",
      { params: schedulesParams },
      schedulesScope,
    );
    if (cachedSchedules) {
      setRecurringSchedules(cachedSchedules.data);
      setSchedulesState("ready");
    } else if (!force) {
      setRecurringSchedules(null);
      setSchedulesState("loading");
    }

    await loadPanel(
      cachedApiGet<RecurringSchedule[]>(
        "/insights/recurring-schedules",
        { signal, params: schedulesParams },
        schedulesScope,
        { force },
      ),
      (schedules) => {
        if (activeExpenseScopeRef.current === requestScopeKey) {
          setRecurringSchedules(schedules);
          setSchedulesState("ready");
        }
      },
      (error) => {
        if (activeExpenseScopeRef.current !== requestScopeKey) return;
        if (isDefinitiveScheduleUnavailable(error)) {
          setRecurringSchedules(null);
          setSchedulesState("unavailable");
          return;
        }
        setSchedulesState(failedSupplementState);
      },
      signal,
    );
  }

  /**
   * The two recurring reads settle independently because schedules can be
   * feature-gated while detector patterns remain available.
   */
  async function loadRecurring(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected) return;
    const businessProfileId = selected.id;
    const patternsParams = { businessProfileId };
    const patternsScope = {
      businessProfileId,
      tags: ["recurring-patterns", "financial"],
    };
    const cachedPatterns = peekCachedApiData<RecurringPattern[]>(
      "/insights/recurring-patterns",
      { params: patternsParams },
      patternsScope,
    );
    if (cachedPatterns) {
      setRecurringPatterns(cachedPatterns.data);
      setPatternsState("ready");
    } else if (!force) {
      setRecurringPatterns([]);
      setPatternsState("loading");
    }

    await Promise.all([
      loadPanel(
        cachedApiGet<RecurringPattern[]>(
          "/insights/recurring-patterns",
          { signal, params: patternsParams },
          patternsScope,
          { force },
        ),
        (patterns) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setRecurringPatterns(patterns);
            setPatternsState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setPatternsState(failedSupplementState);
          }
        },
        signal,
      ),
      loadRecurringSchedules(signal, force),
    ]);
  }

  useLayoutEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodKey, periodReady]);

  useServerStateRefresh(
    [{
      resource: "/insights/expense-overview",
      businessProfileId: selected?.id ?? null,
      period: selection,
      tags: ["expense-insight", "financial", "expense-overview"],
    }],
    (signal) => void loadExpenseOverview(signal, true),
  );

  useServerStateRefresh(
    [{
      resource: selected
        ? `/business-profiles/${selected.id}/financial-position`
        : "/business-profiles/financial-position",
      businessProfileId: selected?.id ?? null,
      tags: ["financial"],
    }],
    () => setFinancialPositionReload((version) => version + 1),
  );

  useServerStateRefresh(
    [
      {
        resource: "/records/flagged",
        businessProfileId: selected?.id ?? null,
        tags: ["records", "financial"],
      },
      {
        resource: "/records/flagged/count",
        businessProfileId: selected?.id ?? null,
        tags: ["records", "financial"],
      },
      {
        resource: "/insights/findings",
        businessProfileId: selected?.id ?? null,
        tags: ["insights-findings", "financial"],
      },
    ],
    (signal) => void loadSupplementPanels(signal, true),
  );

  useServerStateRefresh(
    [
      {
        resource: "/insights/recurring-patterns",
        businessProfileId: selected?.id ?? null,
        tags: ["recurring-patterns", "financial"],
      },
      {
        resource: "/insights/recurring-schedules",
        businessProfileId: selected?.id ?? null,
        tags: ["recurring-schedules", "financial"],
      },
    ],
    (signal) => void loadRecurring(signal, true),
  );

  // A refetch with data already on screen is a refresh, not a load — see the
  // note on the skeleton below.
  const isInitialLoad = loading && !data;
  const isRefreshing = loading && !!data;

  const periodCaption = periodCaptionOf(selection);
  const periodText = periodPhrase(selection);
  /** What changes are measured against: "August 2026", or the same days of it. */
  const comparedWith = previousLabelOf(data?.period) ?? "Previous period";
  const currentFinancialPosition =
    financialPositionProfileId === selected?.id ? financialPosition : null;
  const recordedAvailableFunds = Number.isFinite(
    currentFinancialPosition?.availableFunds.calculatedAmount,
  )
    ? currentFinancialPosition!.availableFunds.calculatedAmount
    : null;
  const currentFinancialPositionError =
    financialPositionProfileId === selected?.id
      ? financialPositionError
      : null;
  const availableFundsAreLoading =
    !!selected &&
    (financialPositionProfileId !== selected.id || financialPositionLoading);
  const startingFundsFallback =
    currentFinancialPositionError && Number.isFinite(selected?.availableFunds)
      ? selected!.availableFunds
      : null;
  const availableFundsDenominator =
    recordedAvailableFunds ?? startingFundsFallback;
  const usingStartingFundsFallback =
    recordedAvailableFunds === null && startingFundsFallback !== null;

  /**
   * The schedules read doubles as the availability probe for everything that
   * WRITES a schedule — confirming a candidate creates one, and the server gates
   * both together. So if the agenda could not be read, "Watch this" cannot work
   * either, and it is not offered.
   */
  const canWatchPatterns = recurringSchedules !== null;
  const candidatePatterns = recurringPatterns.filter(
    (pattern) => pattern.status === "CANDIDATE",
  );
  const hasCandidates = candidatePatterns.length > 0;
  const categoryDisclosure = useListDisclosure({
    total: data?.categoryTrends.length ?? 0,
    resetKey: expenseScopeKey,
  });
  const unusualDisclosure = useListDisclosure({
    total: data?.unusualExpenses.length ?? 0,
    limit: 5,
    resetKey: expenseScopeKey,
  });
  const opportunityDisclosure = useListDisclosure({
    total: reductionOpportunities?.opportunities.length ?? 0,
    limit: MAX_OPPORTUNITIES_SHOWN,
    resetKey: expenseScopeKey,
  });
  const flaggedDisclosure = useListDisclosure({
    total: flaggedExpenses.length,
    limit: MAX_FLAGGED_SHOWN,
    resetKey: expenseScopeKey,
  });
  const recurringDisclosure = useListDisclosure({
    total: candidatePatterns.length,
    limit: 5,
    resetKey: expenseScopeKey,
  });
  // With no agenda and no candidates the whole block is an empty container.
  const showRecurringBlock =
    recurringSchedules !== null ||
    hasCandidates ||
    patternsState === "stale" ||
    patternsState === "unavailable";

  /*
   * The flags panel counts with the server's number and lists with its own
   * page. `flaggedExpenses.length` used to be both, which was only ever right
   * because the request was unbounded — now the list is one page of at most a
   * hundred and the count is a count, so "3 more — review all" stays honest
   * for a business with three thousand.
   */
  const flaggedTotal = flaggedExpenseCount ?? flaggedExpenses.length;
  const hasFlaggedRecordLink =
    flaggedTotal > Math.min(flaggedExpenses.length, MAX_FLAGGED_SHOWN);
  const flaggedState = combinedSupplementState([flaggedListState, flaggedCountState]);
  const showFlaggedPanel = flaggedState !== "ready" || flaggedTotal > 0;
  const showFindingsPanel = findingsState !== "ready" || findings.length > 0;
  // Reviewing the last finding on the last page steps back a page rather than
  // leaving an empty one.
  const visibleFindingsPage = Math.min(
    findingsPage,
    Math.max(1, Math.ceil(findings.length / FINDINGS_PER_PAGE)),
  );
  const reductionHasOpportunities =
    (reductionOpportunities?.opportunities.length ?? 0) > 0;
  const showReductionPanel =
    reductionLoading ||
    !!reductionError ||
    !!refreshError ||
    reductionHasOpportunities;
  const showUnusualPanel =
    isRefreshing || !!refreshError || (data?.unusualExpenses.length ?? 0) > 0;

  // ---- headline figures, all from one denominator ----
  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.totals.current;
    const spending = data.categoryTrends.filter((t) => t.current > 0);
    const top = spending[0] ?? null; // already sorted by current, descending

    // Biggest increase by PESO movement, not by percentage — a 300% rise on a
    // PHP 200 category is noise, and percentage ranking puts it first.
    const risen = [...data.categoryTrends]
      .filter((t) => t.change > 0)
      .sort((a, b) => b.change - a.change);

    const periodDelta = total - data.totals.previous;
    // All time has no earlier period; its fourth figure is the monthly average.
    const monthsCovered = data.dailyBucket === "month" ? data.dailyTotals.length : 0;
    const periodPercent =
      data.totals.previous > 0
        ? (periodDelta / data.totals.previous) * 100
        : null;

    return {
      total,
      categoryCount: spending.length,
      top,
      topShare: top && total > 0 ? (top.current / total) * 100 : 0,
      biggestIncrease: risen[0] ?? null,
      periodDelta,
      periodPercent,
      monthlyAverage: monthsCovered > 0 ? total / monthsCovered : null,
      // All-time spending cannot be compared meaningfully with today's balance.
      fundsShare:
        availableFundsDenominator !== null &&
        availableFundsDenominator > 0 &&
        data.dailyBucket !== "month"
          ? (total / availableFundsDenominator) * 100
          : null,
    };
  }, [availableFundsDenominator, data]);

  /*
   * No `if (!selected) return <NoBusinessProfile />` any more. This page only
   * READS, so with no business it renders its own chrome — heading, period
   * picker, insights tabs — around its own empty state, rather than a gate
   * card. The `!selected` branch in the body below both supplies that state
   * and narrows `selected` for everything after it.
   */

  function categoryName(categoryId?: number) {
    return categories.find((c) => c.id === categoryId)?.name ?? "—";
  }


  // Names the exact category and figure the card above just named — a much
  // more useful starting point in the drawer than a generic "why did my
  // expenses increase?" that makes the owner retype what's already on screen.
  const expandQuestion = summary?.biggestIncrease && !allTime
    ? `Why did ${summary.biggestIncrease.categoryName} increase by ${formatMoney(summary.biggestIncrease.change)} compared with ${comparedWith}?`
    : summary?.top
      ? `Why is ${summary.top.categoryName} my highest expense category ${periodText}?`
      : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Expense insight"
        actions={<PeriodFilter showAllTime={false} />}
      />

      <InsightsTabs />

      {error ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-tint-danger px-3.5 py-3 text-sm text-tone-danger ring-1 ring-edge-danger"
        >
          <div className="min-w-0">
            <p className="font-semibold">Expense insight couldn’t load</p>
            <p className="mt-0.5 text-xs opacity-90">{error}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void load(undefined, true)}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}

      {refreshError ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-tint-accent px-3.5 py-3 text-sm text-tone-accent ring-1 ring-edge-accent"
        >
          <div className="min-w-0">
            <p className="font-semibold">Expense insight couldn’t refresh</p>
            <p className="mt-0.5 text-xs opacity-90">
              Showing recently loaded figures. {refreshError}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void loadExpenseOverview(undefined, true)}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry refresh"}
          </Button>
        </div>
      ) : null}

      {/* Skeleton only when this exact business and period have no cached data.
          A scoped cached result stays in place at reduced opacity while it is
          refreshed; data from another business or period is never reused. */}
      {isInitialLoad ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading expense insights…</span>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1.35fr_1fr_1fr_1fr]">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <SkeletonPanel lines={6} />
            <SkeletonPanel lines={6} />
          </div>
          <SkeletonPanel lines={5} />
        </div>
      ) : !selected ? (
        /*
         * Nothing to analyse, because there is nothing at all yet. Same shape
         * as the "no expenses recorded" state below — this is that state one
         * step earlier, and only the action that closes it differs.
         */
        <EmptyState
          title="No expenses yet"
          icon="◔"
          action={
            <ButtonLink to="/onboarding" variant="primary">
              Finish business setup
            </ButtonLink>
          }
        >
          Set up your business to record expenses.
        </EmptyState>
      ) : !data || !summary ? null : summary.total === 0 ? (
        /*
          TWO DIFFERENT EMPTINESSES. "Never recorded an expense" and "has
          hundreds, none in this period" must not get the same advice: telling
          an owner who just imported 527 expenses to import some is the app
          contradicting what they just did.
        */
        data.latestExpenseDate ? (
          <EmptyState
            title={`No expenses ${periodText}`}
            icon="◔"
          >
            Latest expense:{" "}
            {new Date(data.latestExpenseDate).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
          </EmptyState>
        ) : (
          <EmptyState
            title="No expenses yet"
            icon="◔"
            action={
              <>
                <ButtonLink to="/records/expenses/new" variant="primary">
                  Add an expense
                </ButtonLink>
                <ButtonLink to="/records/csv-imports/new" variant="secondary">
                  Import CSV
                </ButtonLink>
              </>
            }
          />
        )
      ) : (
        <div
          className={`space-y-6 transition-opacity duration-200 ${
            isRefreshing ? "pointer-events-none opacity-60" : ""
          }`}
          aria-busy={isRefreshing}
        >
          {/* The total leads on its own dark band; the three tiles beside it
              explain it, each with a small picture of its own figure. */}
          <section
            id="expense-overview"
            aria-label="Expense summary"
            className="grid scroll-mt-6 gap-4 sm:grid-cols-2 sm:[&>*:last-child]:col-span-2 xl:grid-cols-[1.35fr_1fr_1fr_1fr] xl:[&>*:last-child]:col-span-1"
          >
            <h2 className="sr-only">Total expenses</h2>
            <div className="relative isolate flex min-w-0 flex-col overflow-hidden rounded-2xl bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950 p-5 text-white shadow-md sm:col-span-2 xl:col-span-1">
              <WalletCards
                aria-hidden
                className="pointer-events-none absolute -right-8 -top-8 -z-10 size-40 -rotate-12 text-white/[0.06]"
              />
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-brand-200">
                Total spent
              </p>
              <p className="figure mt-2 text-3xl font-bold text-white">
                {formatMoney(summary.total)}
              </p>
              <p className="mt-1 text-xs text-brand-100">
                {data.categoryTrends.reduce(
                  (sum, trend) => sum + trend.recordCount,
                  0,
                )}{" "}
                expenses · {summary.categoryCount} categor
                {summary.categoryCount === 1 ? "y" : "ies"}
              </p>
              <div className="mt-auto pt-4 text-brand-300">
                <Sparkline
                  points={data.dailyTotals}
                  label={`Spending ${periodText}, ${data.dailyBucket === "month" ? "month" : "day"} by day`}
                />
              </div>
            </div>

            <KpiTile
              icon={ChartPie}
              tone={
                summary.fundsShare !== null && summary.fundsShare > 75
                  ? "danger"
                  : "brand"
              }
              label="Share of recorded available funds"
              order={1}
              visual={
                summary.fundsShare !== null ? (
                  <ShareBar
                    percent={summary.fundsShare}
                    color={
                      summary.fundsShare > 75
                        ? "rgb(var(--tone-danger))"
                        : "rgb(var(--tone-brand))"
                    }
                    trackClassName="bg-paper"
                  />
                ) : undefined
              }
            >
              <p className="figure mt-2 text-2xl font-bold text-ink-900">
                {summary.fundsShare === null
                  ? "—"
                  : `${summary.fundsShare.toFixed(0)}%`}
              </p>
              <p className="mt-1 text-xs text-ink-600">
                {summary.fundsShare === null
                  ? allTime
                    ? "Shown for a week or a month"
                    : availableFundsAreLoading
                      ? "Loading recorded available funds…"
                      : usingStartingFundsFallback
                        ? (startingFundsFallback ?? 0) > 0
                          ? `${formatMoney(summary.total)} of ${formatMoney(startingFundsFallback)} starting funds`
                          : `Starting funds fallback: ${formatMoney(startingFundsFallback ?? 0)}`
                        : `Recorded available funds: ${formatMoney(availableFundsDenominator ?? 0)}`
                  : `${formatMoney(summary.total)} of ${formatMoney(availableFundsDenominator ?? 0)} recorded available funds`}
              </p>
              {usingStartingFundsFallback ? (
                <div
                  role="alert"
                  className="mt-2 text-xs leading-relaxed text-tone-accent"
                >
                  <span title={currentFinancialPositionError ?? undefined}>
                    Recorded balance couldn’t load. Using starting funds.
                  </span>{" "}
                  <button
                    type="button"
                    className="tap-inline font-semibold underline underline-offset-2"
                    onClick={() =>
                      setFinancialPositionReload((version) => version + 1)
                    }
                  >
                    Retry recorded balance
                  </button>
                </div>
              ) : null}
            </KpiTile>

            <KpiTile
              icon={Boxes}
              tone="info"
              label="Largest category"
              order={2}
              visual={
                summary.top ? (
                  <ShareBar
                    percent={summary.topShare}
                    color={TOP_CATEGORY_COLOR}
                    trackClassName="bg-paper"
                  />
                ) : undefined
              }
            >
              <p className="mt-2 truncate text-xl font-bold text-ink-900">
                {summary.top?.categoryName ?? "—"}
              </p>
              <p className="figure mt-1 text-xs text-ink-600">
                {summary.top
                  ? `${summary.topShare.toFixed(1)}% · ${formatMoney(summary.top.current)}`
                  : "No spending yet"}
              </p>
            </KpiTile>

            {allTime ? (
              <KpiTile icon={TrendingUp} tone="neutral" label="Average per month" order={3}>
                <p className="figure mt-2 text-xl font-bold text-ink-900">
                  {summary.monthlyAverage === null ? "—" : formatMoney(summary.monthlyAverage)}
                </p>
                <p className="mt-1 text-xs text-ink-600">
                  {data.dailyTotals.length} month{data.dailyTotals.length === 1 ? "" : "s"}
                </p>
              </KpiTile>
            ) : (
              <KpiTile
                icon={
                  summary.periodDelta > 0
                    ? ArrowUpRight
                    : summary.periodDelta < 0
                      ? ArrowDownRight
                      : TrendingUp
                }
                tone={
                  summary.periodDelta > 0
                    ? "danger"
                    : summary.periodDelta < 0
                      ? "brand"
                      : "neutral"
                }
                label={`vs ${comparedWith}`}
                order={3}
                visual={
                  <PairBars
                    rows={[
                      {
                        label: periodCaption,
                        value: summary.total,
                        color:
                          summary.periodDelta > 0
                            ? "rgb(var(--tone-danger))"
                            : "rgb(var(--tone-brand))",
                      },
                      {
                        label: comparedWith,
                        value: data.totals.previous,
                        color: "rgb(var(--ink-300))",
                      },
                    ]}
                  />
                }
              >
                {summary.periodDelta !== 0 ? (
                  <>
                    <p
                      className={`figure mt-2 text-xl font-bold ${
                        summary.periodDelta > 0
                          ? "text-tone-danger"
                          : "text-tone-brand"
                      }`}
                    >
                      {summary.periodDelta > 0 ? "+" : "−"}
                      {formatMoney(Math.abs(summary.periodDelta))}
                    </p>
                    <p className="mt-1 text-xs text-ink-600">
                      {summary.periodPercent === null
                        ? "No earlier data"
                        : `${Math.abs(summary.periodPercent).toFixed(0)}% ${
                            summary.periodDelta > 0 ? "more" : "less"
                          }`}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-xl font-bold text-ink-900">
                      No change
                    </p>
                    <p className="mt-1 text-xs text-ink-600">Same total</p>
                  </>
                )}
              </KpiTile>
            )}
          </section>

          <ExpenseSectionNav
            showOpportunities={showReductionPanel}
            showRecurring={showRecurringBlock}
          />

          {/* A plain-language warning, only when it is actually warranted. The
              KPI above states the number; this says what to do about it. */}
          {summary.fundsShare !== null && summary.fundsShare > 75 ? (
            <Callout tone="warn">
              Spending {periodText} is{" "}
              <b className="font-semibold">{summary.fundsShare.toFixed(0)}%</b>{" "}
              of your recorded available funds.
            </Callout>
          ) : null}

          {/* What it means, beside when it happened. The summary is read
              first, so it sits on the left at the top of the page's body. */}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <ExpenseSummaryCard
              summary={summary}
              periodText={periodText}
              comparedWith={comparedWith}
              allTime={allTime}
              categoryColor={TOP_CATEGORY_COLOR}
              flaggedCount={flaggedState === "ready" || flaggedState === "stale" ? flaggedTotal : 0}
              unusualCount={data.unusualExpenses.length}
              expandQuestion={expandQuestion}
              onAsk={askFinSight}
            />
            {/* ===================== WHEN IT LEFT ===================== */}
            <Panel
              title="Spending over time"
              action={<span className="text-xs text-ink-500">{periodCaption}</span>}
              className="min-w-0"
            >
              <DailySpendChart
                key={expenseScopeKey}
                daily={data.dailyTotals}
                bucket={data.dailyBucket ?? "day"}
              />
            </Panel>
          </div>

          {/* ================= 2 & 3. WHERE IT WENT / WHAT CHANGED ================= */}
          <div
            id="expense-categories"
            className={`scroll-mt-6 grid items-start gap-5 ${allTime ? "" : "xl:grid-cols-[0.8fr_1.2fr]"}`}
          >
            <Panel title="Category distribution" className="min-w-0 xl:order-2">
              <DonutChart
                breakdown={data.categoryTrends
                  .filter((t) => t.current > 0)
                  .map((t) => ({
                    categoryName: t.categoryName,
                    total: t.current,
                  }))}
              />
            </Panel>

            {/* All time has no earlier period to compare with. */}
            {!allTime ? (
              <Panel title="Category comparison" className="min-w-0 xl:order-1">
                <CategoryComparisonChart
                  trends={data.categoryTrends}
                  currentLabel={periodCaption}
                  previousLabel={comparedWith}
                  resetKey={expenseScopeKey}
                />
              </Panel>
            ) : null}
          </div>

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
            <div id={categoryDisclosure.contentId}>
              <ul className="space-y-2 px-4 pb-4 md:hidden">
                {data.categoryTrends.slice(0, categoryDisclosure.visibleCount).map((trend) => (
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
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                          {comparedWith}
                        </dt>
                        <dd className="figure mt-1 text-sm text-ink-600">
                          {formatMoney(trend.previous)}
                        </dd>
                      </div>
                      <div className="text-right">
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
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
                    Expenses by category for {selected.name}, {periodText}
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
                    {data.categoryTrends.slice(0, categoryDisclosure.visibleCount).map((t) => (
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
              disclosure={categoryDisclosure}
              total={data.categoryTrends.length}
              itemLabel="categories"
              className="mx-4 pb-3"
            />
          </Panel>

          {/* ============ 4.5 REDUCTION OPPORTUNITIES — the next step ============
              Placed right after "what changed" and before the lower-priority
              analytical detail below (plan §10.1): understanding the numbers
              naturally leads to "so what should I check first?", and this
              panel is the deterministic answer to that question. */}
          {showReductionPanel ? (
            <div id="expense-opportunities" className="scroll-mt-6">
              <Panel title="Reduction opportunities">
                {reductionLoading &&
                !reductionHasOpportunities &&
                !reductionError ? (
                  <div
                    className="space-y-3"
                    aria-busy="true"
                    aria-live="polite"
                  >
                    <span className="sr-only">
                      Loading reduction opportunities…
                    </span>
                    {[0, 1].map((i) => (
                      <div
                        key={i}
                        className="rounded-xl border border-paper-200 p-4"
                      >
                        <SkeletonLine className="w-32" />
                        <SkeletonLine className="mt-3 w-1/2" />
                        <SkeletonLine className="mt-2 w-full" />
                        <SkeletonLine className="mt-2 w-3/4" />
                      </div>
                    ))}
                  </div>
                ) : reductionError ? (
                  <Callout tone="warn">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span>Opportunities couldn’t load. {reductionError}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void loadExpenseOverview(undefined, true)
                        }
                      >
                        Retry
                      </Button>
                    </div>
                  </Callout>
                ) : refreshError && !reductionHasOpportunities ? (
                  <p role="status" className="text-sm text-tone-accent">
                    Showing recently loaded opportunity data; the latest
                    refresh failed.
                  </p>
                ) : !reductionOpportunities ||
                  !reductionHasOpportunities ? null : (
                  <>
                    {reductionOpportunities.dataQuality.status === "limited" &&
                    reductionOpportunities.dataQuality.message ? (
                      <Callout tone="info">
                        {reductionOpportunities.dataQuality.message}
                      </Callout>
                    ) : null}
                    <ul
                      id={opportunityDisclosure.contentId}
                      className={`grid gap-3 xl:grid-cols-2 ${reductionOpportunities.dataQuality.status === "limited" ? "mt-3" : ""}`}
                    >
                      {reductionOpportunities.opportunities
                        .slice(0, opportunityDisclosure.visibleCount)
                        .map((o) => (
                          <OpportunityCard
                            key={o.id}
                            opportunity={o}
                            businessProfileId={selected.id}
                            period={selection}
                          />
                        ))}
                    </ul>
                    <ListDisclosureControl
                      disclosure={opportunityDisclosure}
                      total={reductionOpportunities.opportunities.length}
                      itemLabel="opportunities"
                      className="mt-3"
                    />
                  </>
                )}
              </Panel>
            </div>
          ) : null}

          {/* ===================== 5. FLAGS + AI ===================== */}
          {/* ===================== 5. REVIEW ===================== */}
          <section
            id="expense-review"
            aria-label="Expenses to review"
            className="scroll-mt-6 space-y-5"
          >
            {!showFlaggedPanel && !showUnusualPanel && !showFindingsPanel ? (
              <div className="flex items-center gap-3 rounded-2xl border border-paper-200 bg-paper px-5 py-4 shadow-sm">
                <IconTile icon={ShieldCheck} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">All clear</p>
                  <p className="text-xs text-ink-500">
                    No large, unusual or open findings {periodText}.
                  </p>
                </div>
              </div>
            ) : null}
            {showFlaggedPanel || showUnusualPanel ? (
              <div
                className={`grid items-start gap-5 ${showFlaggedPanel && showUnusualPanel ? "lg:grid-cols-2" : ""}`}
              >
              {showFlaggedPanel ? (
                <Panel
                  title="Large expense flags"
                  className="min-w-0"
                  action={
                    flaggedState === "stale" ? (
                      <Pill>Saved data</Pill>
                    ) : flaggedState === "unavailable" ? (
                      <Pill>Unavailable</Pill>
                    ) : flaggedState === "ready" && flaggedTotal > 0 ? (
                      <Pill tone="danger">{flaggedTotal} flagged</Pill>
                    ) : null
                  }
                >
                  <SupplementNotice
                    state={flaggedState}
                    label="flagged record details"
                  />
                  {flaggedState === "loading" ? (
                    <p
                      aria-live="polite"
                      className="py-6 text-center text-sm text-ink-500"
                    >
                      Loading flagged records…
                    </p>
                  ) : flaggedState === "unavailable" ||
                    (flaggedState === "stale" && flaggedTotal === 0) ||
                    flaggedTotal === 0 ? null : (
                    <>
                      <ul id={flaggedDisclosure.contentId} className="space-y-2">
                        {flaggedExpenses
                          .slice(0, flaggedDisclosure.visibleCount)
                          .map((r) => (
                            <li
                              key={r.id}
                              className="flex items-start gap-3 rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3"
                            >
                              <IconTile icon={Flag} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                  <p className="min-w-0 text-sm font-semibold text-ink-900">
                                    {r.description}
                                  </p>
                                  <p className="figure shrink-0 text-sm font-bold text-tone-danger">
                                    {formatMoney(r.amount)}
                                  </p>
                                </div>
                                <p className="mt-1 text-xs text-ink-500">
                                  {categoryName(r.categoryId)} ·{" "}
                                  {r.date.slice(0, 10)} ·{" "}
                                  <FlagReason record={r} profile={selected} />
                                </p>
                              </div>
                            </li>
                          ))}
                      </ul>
                      <ListDisclosureControl
                        disclosure={flaggedDisclosure}
                        total={flaggedExpenses.length}
                        itemLabel={flaggedTotal > flaggedExpenses.length ? "loaded flags" : "flags"}
                        className="mt-3"
                      />
                      {hasFlaggedRecordLink ? (
                        <Link
                          to="/records/flagged"
                          className="tap-inline mt-3 block text-sm link-action"
                        >
                          Review all {flaggedTotal} flagged
                        </Link>
                      ) : null}
                    </>
                  )}
                </Panel>
              ) : null}
            {/* ===================== 7. ANYTHING ODD (statistical) ===================== */}
            {showUnusualPanel ? (
              <Panel
                title="Unusual expenses"
                className="min-w-0"
                action={
                  data.unusualExpenses.length > 0 ? (
                    <span className="text-xs text-ink-500">
                      {data.unusualExpenses.length} flagged
                    </span>
                  ) : null
                }
              >
              {isRefreshing && data.unusualExpenses.length === 0 ? (
                <p aria-live="polite" className="py-6 text-center text-sm text-ink-500">
                  Refreshing unusual expenses…
                </p>
              ) : refreshError && data.unusualExpenses.length === 0 ? (
                <p role="status" className="text-sm text-tone-accent">
                  Showing recently loaded unusual-expense results; the latest
                  refresh failed.
                </p>
              ) : (
                <>
                  <ul id={unusualDisclosure.contentId} className="space-y-2">
                    {data.unusualExpenses.slice(0, unusualDisclosure.visibleCount).map((u) => {
                      const times =
                        u.categoryMean > 0 ? u.amount / u.categoryMean : null;
                      return (
                        <li
                          key={u.id}
                          className="rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-ink-900">
                                {u.description}
                              </p>
                              <p className="mt-0.5 text-xs text-ink-500">
                                {u.categoryName} · {u.date.slice(0, 10)}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="figure text-sm font-bold text-ink-900">
                                {formatMoney(u.amount)}
                              </p>
                              {/* Said in multiples of the usual, not in standard
                                  deviations. "4.2× usual" lands; "z-score 3.2"
                                  does not. */}
                              {times && times >= 1.5 ? (
                                <span className="figure mt-0.5 inline-block rounded-full bg-tint-danger px-1.5 py-0.5 text-[11px] font-semibold text-tone-danger">
                                  {times.toFixed(1)}× usual
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <UsualBar amount={u.amount} usual={u.categoryMean} />
                          <p className="mt-1.5 text-[11px] text-ink-500">
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
                  <ListDisclosureControl
                    disclosure={unusualDisclosure}
                    total={data.unusualExpenses.length}
                    itemLabel="unusual expenses"
                    className="mt-3"
                  />
                </>
              )}

              {data.insufficientHistoryCategories.length > 0 ? (
                <p className="mt-3 text-xs text-ink-500">
                  Not enough history to check:{" "}
                  {data.insufficientHistoryCategories
                    .map((c) => c.categoryName)
                    .join(", ")}
                </p>
              ) : null}
              </Panel>
            ) : null}

              </div>
            ) : null}
            {showFindingsPanel ? (
              <Panel
                title="Findings to review"
                action={
                  findingsState === "stale" ? (
                    <Pill>Saved data</Pill>
                  ) : findingsState === "unavailable" ? (
                    <Pill>Unavailable</Pill>
                  ) : findingsState === "ready" && findings.length > 0 ? (
                    <span className="text-xs text-ink-500">
                      {findings.length} open
                    </span>
                  ) : null
                }
              >
              <SupplementNotice state={findingsState} label="finding details" />
              {findingsState === "loading" ? (
                <p aria-live="polite" className="py-6 text-center text-sm text-ink-500">
                  Loading findings…
                </p>
              ) : findingsState === "unavailable" || (findingsState === "stale" && findings.length === 0) ? null
              : findings.length === 0 ? null : (
                <>
                <ul className="space-y-3">
                  {findings
                    .slice((visibleFindingsPage - 1) * FINDINGS_PER_PAGE, visibleFindingsPage * FINDINGS_PER_PAGE)
                    .map((finding) => (
                    <li
                      key={finding.id}
                      className="rounded-xl border border-paper-200 bg-paper-50 p-3.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <IconTile icon={AlertTriangle} />
                          <p className="text-sm font-semibold text-ink-900">
                            {finding.title}
                          </p>
                        </div>
                        <Pill tone={(FINDING_SEVERITY_LOOK[finding.severity] ?? FINDING_SEVERITY_LOOK.LOW!).pill}>
                          {finding.severity.toLowerCase()}
                        </Pill>
                      </div>
                      <ul className="mt-2 list-disc space-y-1 pl-[3.75rem] text-xs text-ink-500">
                        {finding.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
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
                      <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() =>
                            void reviewFinding(
                              finding.id,
                              "CONFIRMED",
                              finding.type === "POSSIBLE_DUPLICATE"
                                ? "DUPLICATE"
                                : "CONFIRMED_UNUSUAL",
                            )
                          }
                        >
                          Confirm
                          <span className="sr-only"> — {finding.title}</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void reviewFinding(
                              finding.id,
                              "DISMISSED",
                              "EXPECTED_TRANSACTION",
                            )
                          }
                        >
                          Expected / dismiss
                          <span className="sr-only"> — {finding.title}</span>
                        </Button>
                        <Link
                          to="/records/flagged"
                          className="tap-inline text-xs link-action"
                        >
                          More options
                          <span className="sr-only">
                            {" "}
                            for {finding.title}, on the review queue
                          </span>
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
                {findings.length > FINDINGS_PER_PAGE ? (
                  <Pagination
                    page={visibleFindingsPage}
                    pageSize={FINDINGS_PER_PAGE}
                    totalItems={findings.length}
                    onPageChange={setFindingsPage}
                    itemNoun="findings"
                    idPrefix="findings"
                    className="mt-4 border-t border-paper-200 pt-3"
                  />
                ) : null}
                </>
              )}
              </Panel>
            ) : null}
          </section>
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
        <div id="expense-recurring" className="mt-6 scroll-mt-6 space-y-6">
          {schedulesState === "stale" ? (
            <Callout tone="warn">
              <div>
                <p role="status">
                  <b className="font-semibold">Recurring payments couldn’t refresh.</b>{" "}
                  Showing recently loaded schedules.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => void loadRecurringSchedules(undefined, true)}
                >
                  Retry schedules
                </Button>
              </div>
            </Callout>
          ) : null}

          {/* Hidden when there is no successful snapshot or the server
              definitively reports that schedules are unavailable. */}
          {recurringSchedules !== null ? (
            <RecurringAgenda schedules={recurringSchedules} resetKey={expenseScopeKey} />
          ) : null}

          {hasCandidates ? (
            <Panel title="Possible recurring expenses">
              <SupplementNotice state={patternsState} label="recurring expense suggestions" />
              <ul id={recurringDisclosure.contentId} className="space-y-2">
                {candidatePatterns
                  .slice(0, recurringDisclosure.visibleCount)
                  .map((pattern) => (
                    <li
                      key={pattern.id}
                      className="rounded-xl border border-paper-200 bg-paper-100/60 px-3.5 py-3"
                    >
                      <p className="text-sm font-semibold text-ink-900">
                        {pattern.description}
                      </p>
                      <p className="mt-1 text-xs text-ink-500">
                        {pattern.category.name} · about every{" "}
                        {pattern.intervalDays} days ·{" "}
                        <span className="figure">
                          {formatMoney(pattern.expectedAmount)}
                        </span>
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
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void confirmPattern(pattern.id)}
                          >
                            Watch this
                            <span className="sr-only">
                              {" "}
                              — {pattern.description}
                            </span>
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => void dismissPattern(pattern.id)}
                        >
                          Not recurring
                          <span className="sr-only">
                            {" "}
                            — {pattern.description}
                          </span>
                        </Button>
                      </div>
                    </li>
                  ))}
              </ul>
              <ListDisclosureControl
                disclosure={recurringDisclosure}
                total={candidatePatterns.length}
                itemLabel="recurring suggestions"
                className="mt-3"
              />
            </Panel>
          ) : patternsState === "stale" || patternsState === "unavailable" ? (
            <Panel title="Recurring expense suggestions">
              <SupplementNotice state={patternsState} label="recurring expense suggestions" />
            </Panel>
          ) : null}
        </div>
      )}

      <AskFinSightButton originModule="Expense Insights" />
    </div>
  );
}
