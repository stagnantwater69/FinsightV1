import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Info,
  ListFilter,
  MessageCircleQuestion,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
} from "lucide-react";
import { api } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { useAskFinSight } from "../../components/AskFinSightButton";
import { SkeletonLine } from "../../components/Skeleton";
import { Button } from "../../components/Button";
import { formatMoney } from "../../components/Money";
import { Panel, Callout, Pill } from "../../components/ui";
import { ReductionSimulationModal } from "../../components/ReductionSimulationModal";
import { Modal } from "../../components/Modal";
import type { PeriodSelection } from "../../lib/reportingPeriod";
import type { ReductionOpportunity, ReductionOpportunityResponse } from "../../lib/types";
import { ChangeFigure } from "./CategorySummary";

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
  strong: "Very sure",
  moderate: "Fairly sure",
  limited: "Not very sure",
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
/**
 * Reduction opportunities in a single horizontal row. Cards keep a readable
 * width instead of being squeezed into columns; the rest are a swipe, a
 * trackpad scroll or a Previous/Next press away. Snap points stop a card from
 * resting half off the edge.
 *
 * Cards grow to share the row's width, so a short list fills the panel
 * instead of floating in the middle; below their minimum width they stop
 * shrinking and the row scrolls. The bar is hidden; the next card peeking
 * past the edge says there is more.
 */
function OpportunityRow({
  count,
  className = "",
  children,
}: {
  count: number;
  className?: string;
  children: ReactNode;
}) {
  const scrollerRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () =>
      setEdges({
        atStart: el.scrollLeft <= 1,
        atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [count]);

  // One card per press: the first card's width plus the gap between cards.
  const step = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!el || !card) return;
    el.scrollBy({ left: direction * (card.offsetWidth + 12), behavior: "smooth" });
  };

  // Up to three cards is the usual case and needs no controls; past that,
  // the buttons appear whenever the row actually overflows.
  const showControls = count > 3 && !(edges.atStart && edges.atEnd);

  return (
    <div className={className}>
      {/* `relative` makes the scroller the containing block for the
          absolutely positioned sr-only labels inside its cards. Without it
          they escape the overflow clip and widen the whole page on a phone. */}
      <ul
        ref={scrollerRef}
        role="list"
        aria-label={`Reduction opportunities, ${count} in all`}
        tabIndex={0}
        className="scroll-none relative flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain scroll-smooth rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 [&>li]:shrink-0 [&>li]:grow [&>li]:basis-[min(20rem,88%)] [&>li]:snap-start"
      >
        {children}
      </ul>
      {showControls ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => step(-1)}
            disabled={edges.atStart}
            aria-label="Previous opportunity"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => step(1)}
            disabled={edges.atEnd}
            aria-label="Next opportunity"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const OPPORTUNITY_ACTION =
  "tap flex min-h-tap items-center justify-center rounded-lg border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
// Icon over label keeps three tiles side by side even in the narrowest card.
const OPPORTUNITY_TILE = `${OPPORTUNITY_ACTION} flex-col gap-1 border-paper-200 bg-paper px-1.5 py-2 text-xs leading-tight text-ink-700 hover:border-edge-brand hover:bg-tint-brand hover:text-tone-brand`;

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
  const [detailsOpen, setDetailsOpen] = useState(false);

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
            className="flex size-8 shrink-0 items-center justify-center text-ink-500"
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
              <dt className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-500">
                {fig.label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink-900">
                {fig.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Simulate is the card's main action, so it gets the full width;
            the other three are equal tiles below it. Details is a popup
            rather than an inline disclosure: in the horizontal row an
            expanded card grew every card beside it to the same height. */}
        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={() => setSimulateOpen(true)}
            className={`${OPPORTUNITY_ACTION} w-full flex-row gap-2 border-edge-brand bg-tint-brand py-2 text-sm text-tone-brand hover:border-brand-600 hover:bg-brand-600 hover:text-white`}
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            Simulate reduction
            <span className="sr-only"> for {opportunity.categoryName}</span>
          </button>
          <div className="grid grid-cols-3 gap-2">
            <Link
              to={`/records?type=expense&categoryId=${opportunity.categoryId}`}
              aria-label={`View related records for ${opportunity.categoryName}`}
              className={OPPORTUNITY_TILE}
            >
              <ListFilter aria-hidden className="size-4" />
              View records
              <span className="sr-only"> for {opportunity.categoryName}</span>
            </Link>
            <button
              type="button"
              aria-label={`Ask FinSight about this reduction opportunity for ${opportunity.categoryName}`}
              onClick={() => askFinSight(OPPORTUNITY_ASK_QUESTION, opportunity)}
              className={OPPORTUNITY_TILE}
            >
              <MessageCircleQuestion aria-hidden className="size-4" />
              Ask FinSight
              <span className="sr-only">
                {" "}
                reduction opportunity for {opportunity.categoryName}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className={OPPORTUNITY_TILE}
            >
              <Info aria-hidden className="size-4" />
              Details
              <span className="sr-only"> for {opportunity.categoryName}</span>
            </button>
          </div>
        </div>

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

      <Modal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title={`${opportunity.categoryName} — details`}
      >
        <p className="text-sm text-ink-600">{opportunity.observation}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Pill tone="neutral">
            {OPPORTUNITY_CONFIDENCE_LABEL[opportunity.confidence]}
          </Pill>
          {costBehaviorLabel ? (
            <Pill tone="info">{costBehaviorLabel}</Pill>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-ink-600">
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
            <p className="text-sm font-semibold text-ink-700">
              Suggested checks
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-600">
              {opportunity.suggestedChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {opportunity.limitations.length > 0 ? (
          <div className="mt-3">
            <p className="text-sm font-semibold text-ink-700">
              Limitations
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-600">
              {opportunity.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Modal>

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

export function ReductionOpportunitiesPanel({
  reductionOpportunities,
  reductionLoading,
  reductionError,
  reductionHasOpportunities,
  refreshError,
  onRetry,
  businessProfileId,
  period,
}: {
  reductionOpportunities: ReductionOpportunityResponse | null;
  reductionLoading: boolean;
  reductionError: string | null;
  reductionHasOpportunities: boolean;
  refreshError: string | null;
  onRetry: () => void;
  businessProfileId: number;
  period: PeriodSelection;
}) {
  return (
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
                onClick={onRetry}
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
            <OpportunityRow
              count={reductionOpportunities.opportunities.length}
              className={reductionOpportunities.dataQuality.status === "limited" ? "mt-3" : ""}
            >
              {reductionOpportunities.opportunities.map((o) => (
                <OpportunityCard
                  key={o.id}
                  opportunity={o}
                  businessProfileId={businessProfileId}
                  period={period}
                />
              ))}
            </OpportunityRow>
          </>
        )}
      </Panel>
    </div>
  );
}
