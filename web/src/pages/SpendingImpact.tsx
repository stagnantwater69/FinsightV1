import { useEffect, useState, type ReactNode } from "react";
import { IconTile } from "../components/IconTile";
import { Link, useLocation } from "react-router-dom";
import {
  CircleDollarSign,
  Coins,
  HelpCircle,
  MessageCircle,
  Package,
  RefreshCw,
  Repeat,
  RotateCcw,
  Sparkles,
  Tag as Tag_,
  Target,
  WalletCards,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { ButtonLink } from "../components/Button";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { periodLabel, periodParams, periodPhrase } from "../lib/reportingPeriod";
import type {
  CategorySuggestion,
  ImpactBand,
  PriceComparison,
  PurchaseKind,
  PurchasePriceContext,
  PurchaseReview,
  SpendingImpact as SpendingImpactData,
} from "../lib/types";
import { PageHead, Pill, type PillTone } from "../components/ui";
import { Field, SelectInput } from "../components/Field";
import { Money, formatMoney } from "../components/Money";
import { discussionPrompt } from "../lib/purchaseConversation";
import { PriceRangeStrip, SlipMeter, ZoneBand } from "./spendingImpact/ImpactVisuals";

// The band glyphs stay beside the stamp text: severity must survive greyscale
// and colourblindness, so the shape carries it as well as the colour.
const BAND_GLYPH: Record<ImpactBand, string> = {
  "Low Impact": "✓",
  "Noticeable Impact": "●",
  "High Impact": "▲",
};

function percentText(data: SpendingImpactData): string {
  return data.percentOfFunds >= 999999 ? "more than 100%" : `${data.percentOfFunds.toFixed(1)}%`;
}

const QUICK_AMOUNTS = [5000, 10000, 25000];

function ImpactGauge({ data }: { data: SpendingImpactData }) {
  const displayCeiling = Math.max(data.thresholdPercent * 1.35, data.percentOfFunds, 1);

  return (
    <div
      role="meter"
      aria-label="Planned expense as a percentage of available funds"
      aria-valuemin={0}
      aria-valuemax={Math.ceil(displayCeiling)}
      aria-valuenow={Math.min(Math.ceil(displayCeiling), Math.round(data.percentOfFunds))}
      aria-valuetext={`${percentText(data)} of available funds; ${data.impactBand}`}
    >
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-semibold text-ink-700">Share of available funds</span>
        <span className="figure text-base font-bold text-ink-900">{percentText(data)}</span>
      </div>
      <SlipMeter
        percent={data.percentOfFunds}
        noticeableAt={data.thresholdPercent * 0.4}
        highAt={data.thresholdPercent}
        band={data.impactBand}
      />
      <p className="mt-2 text-[11px] text-ink-500">
        High impact from {data.thresholdPercent}% (<Money value={data.thresholdAmount} />)
      </p>
    </div>
  );
}

/** The stamp's ink, per band. Text colour drives the border via currentColor. */
const STAMP_INK: Record<ImpactBand, string> = {
  "Low Impact": "text-tone-brand",
  "Noticeable Impact": "text-tone-accent",
  "High Impact": "text-tone-danger",
};

/** One ledger line on the slip. */
function SlipLine({
  label,
  value,
  muted = false,
}: {
  label: ReactNode;
  value: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={`min-w-0 truncate ${muted ? "text-ink-500" : "text-ink-700"}`}>{label}</dt>
      <dd className={`figure shrink-0 ${muted ? "text-ink-500" : "font-semibold text-ink-900"}`}>{value}</dd>
    </div>
  );
}

const SLIP_RULE = "my-4 border-t-2 border-dashed border-paper-200";

/**
 * What the owner is actually buying, next to what it does to their money.
 *
 * THE PROBLEM THIS SOLVES. "What are you planning to buy?" was a field that
 * changed nothing. It fed a silent category guess and the AiCard's phrasing,
 * and an owner who typed "display fridge" got back exactly the arithmetic they
 * would have got by typing nothing at all. The figures answer "what happens to
 * my money"; nothing answered "what am I actually buying, and what should I be
 * asking about it".
 *
 * WHAT IT IS AND IS NOT. It is a classification (kept and used, or used up and
 * bought again), what a business of this type typically does with the thing,
 * the costs that come along behind it, and the questions only the owner can
 * answer. It is NOT a verdict. FinSight monitors and explains; it does not
 * tell an owner what to decide — the same rule its AI has always run under,
 * and here the server enforces it on the way out rather than trusting the
 * prompt (see reviewPlannedPurchase in backend/src/services/ai.service.ts).
 *
 * The questions are the load-bearing part. "Does it replace ice you already
 * buy every week?" is worth more to a shop owner than any answer a model could
 * give from one line of text, because they are the only person who knows.
 */
const PURCHASE_KIND_LABEL: Record<PurchaseKind, string> = {
  asset: "Something you keep",
  "running-cost": "Something you use up",
  mixed: "A bit of both",
  unclear: "Hard to tell from this",
};

/*
 * Deliberately NOT good/bad colouring. A fridge is not virtuous and a sack of
 * rice is not a failing — they are different KINDS of spending, and painting
 * one green and one red would turn a neutral description into the verdict this
 * card exists not to give. Two informational tones and a neutral.
 */
const PURCHASE_KIND_TONE: Record<PurchaseKind, PillTone> = {
  asset: "info",
  "running-cost": "neutral",
  mixed: "info",
  unclear: "neutral",
};

const PURCHASE_KIND_ICON: Record<PurchaseKind, typeof Package> = {
  asset: Package,
  "running-cost": Repeat,
  mixed: Repeat,
  unclear: HelpCircle,
};

/**
 * "Is this the right price?", answered the only honest way this app can.
 *
 * NOT from the model. What a display fridge costs in Cebu this week is not
 * something FinSight knows, and a language model asked would produce a
 * confident range with nothing behind it — sitting inches from figures that
 * ARE real, in the same card, indistinguishable from them. The server drops
 * any price claim the model makes for exactly that reason.
 *
 * What FinSight does know is what this owner has paid. "You bought something
 * described 'fridge' for ₱9,800 in March" and "your Equipment purchases
 * usually run ₱4,200" turn an unanswerable market question into an answerable
 * personal one — is this normal FOR ME — and every number in it is arithmetic
 * over their own records.
 *
 * The wording never judges. "More than you usually spend here" is a fact about
 * their history; "too expensive" would be an opinion about a market nobody
 * here can see.
 */
const PRICE_COMPARISON_COPY: Record<PriceComparison, { label: string; tone: PillTone } | null> = {
  "no-history": null,
  "no-amount": null,
  below: { label: "Less than you usually spend here", tone: "info" },
  "in-line": { label: "In line with what you usually spend here", tone: "ok" },
  above: { label: "More than you usually spend here", tone: "warn" },
  "far-above": { label: "Well beyond anything in your records", tone: "warn" },
};

function PriceContextPanel({
  price,
  plannedAmount,
}: {
  price: PurchasePriceContext;
  plannedAmount: number | "";
}) {
  const badge = PRICE_COMPARISON_COPY[price.comparison];
  const hasHistory = price.recordCount > 0 || price.similar.length > 0;

  return (
    <div className="rounded-2xl border border-paper-200 bg-paper-50 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink-900">
            {plannedAmount === "" ? "What you usually pay" : `Is ${formatMoney(plannedAmount)} normal for you?`}
          </p>
          {/*
            Says where these came from, in the same breath as the figures. The
            paragraphs above this panel were written by a model; these numbers
            were not, and the difference is the whole reason the panel exists.
          */}
          <p className="mt-0.5 text-xs text-ink-600">From your records, not AI</p>
        </div>
        {badge ? <Pill tone={badge.tone}>{badge.label}</Pill> : null}
      </div>

      {!hasHistory ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          No similar purchases in the last {Math.round(price.windowDays / 30)} months.
        </p>
      ) : (
        <>
          {price.similar.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">
                Last time you bought something like this
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {price.similar.map((record) => (
                  <li
                    key={`${record.description}-${record.date}-${record.amount}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-ink-700"
                  >
                    <span className="min-w-0 truncate">
                      {record.description}
                      <span className="ml-1.5 text-xs text-ink-600">
                        {new Date(record.date).toLocaleDateString(undefined, {
                          month: "short",
                          year: "numeric",
                          timeZone: "UTC",
                        })}
                        {" · "}
                        {record.categoryName}
                      </span>
                    </span>
                    <Money value={record.amount} className="figure shrink-0 font-semibold text-ink-900" />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {price.typicalAmount !== null &&
          price.smallestAmount !== null &&
          price.largestAmount !== null &&
          price.recordCount > 1 ? (
            <div className="mt-3">
              <PriceRangeStrip
                smallest={price.smallestAmount}
                largest={price.largestAmount}
                typical={price.typicalAmount}
                planned={plannedAmount === "" ? null : plannedAmount}
              />
            </div>
          ) : null}

          {price.typicalAmount !== null && price.categoryName ? (
            <p className="mt-3 text-sm leading-relaxed text-ink-700">
              Your {price.recordCount} {price.categoryName} {price.recordCount === 1 ? "record" : "records"} in
              the last year usually run{" "}
              <b className="figure font-semibold text-ink-900">{formatMoney(price.typicalAmount)}</b>
              {price.smallestAmount !== null && price.largestAmount !== null && price.recordCount > 1 ? (
                <>
                  {" "}
                  (from <span className="figure">{formatMoney(price.smallestAmount)}</span> to{" "}
                  <span className="figure">{formatMoney(price.largestAmount)}</span>)
                </>
              ) : null}
              {price.multipleOfTypical && price.multipleOfTypical >= 1.4 ? (
                <>
                  . This one is about{" "}
                  <b className="figure font-semibold text-ink-900">{price.multipleOfTypical}×</b> that.
                </>
              ) : (
                "."
              )}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function PurchaseReviewCard({
  review,
  price,
  plannedAmount,
  item,
  stale,
  onRefresh,
  onDiscuss,
  busy,
}: {
  review: PurchaseReview;
  /** Calculated, not written — see PriceContextPanel. */
  price: PurchasePriceContext | null;
  plannedAmount: number | "";
  item: string;
  /** The description has moved on since this was written. */
  stale: boolean;
  onRefresh: () => void;
  /** Carries this card into the Ask FinSight drawer as an opening question. */
  onDiscuss: () => void;
  busy: boolean;
}) {
  const KindIcon = PURCHASE_KIND_ICON[review.kind];
  // Ticks are the owner's own working-out while they decide. Kept only on
  // this card, never saved, and reset whenever a new review arrives.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setAnswered(new Set()), [review]);

  const facts: { icon: typeof Package; label: string; body: string }[] = [
    { icon: Target, label: "Usually for", body: review.businessUse },
    { icon: Coins, label: "Costs to keep", body: review.ongoingCosts ?? "None identified." },
    /*
      What to CHECK about the amount — never what the amount should be. The
      server refuses any answer that names a figure or calls the price fair,
      cheap or steep, because FinSight has no price feed and a guess sitting
      beside the real figures below would be indistinguishable from them.
    */
    ...(review.priceCheck ? [{ icon: Tag_, label: "Check the price", body: review.priceCheck }] : []),
  ];

  return (
    <article className="overflow-hidden rounded-2xl bg-paper shadow-sm ring-1 ring-paper-200">
      <div className="grid lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        {/* The item itself, and who wrote about it. */}
        <aside className="flex flex-col border-b border-paper-200 bg-tint-brand/40 p-6 lg:border-b-0 lg:border-r">
          <IconTile icon={KindIcon} size="lg" />
          <h2 className="mt-4 break-words font-display text-2xl font-bold tracking-[-0.02em] text-ink-900">
            About {item}
          </h2>
          {/*
            Says who wrote these words, in the same language the rest of the
            app uses for the distinction. The figures on this page are
            calculated; this paragraph is not, and an owner is entitled to
            know which is which before weighing it.
          */}
          <p className="mt-1 text-xs text-ink-600">Written by AI from what you typed</p>
          <div className="mt-3">
            <Pill tone={PURCHASE_KIND_TONE[review.kind]}>{PURCHASE_KIND_LABEL[review.kind]}</Pill>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-ink-700">{review.kindReason}</p>

          {/*
            The card is one turn, not the end of the subject. This carries what
            was just said into the drawer as a written-out opening question —
            the owner reads it and presses send themselves. Nothing is asked on
            their behalf.
          */}
          <div className="mt-6 flex flex-col gap-2 lg:mt-auto lg:pt-6">
            <button
              type="button"
              onClick={onDiscuss}
              aria-label={`Ask FinSight about ${item}`}
              className="inline-flex min-h-tap items-center justify-center gap-2 rounded-xl bg-brand-800 px-4 text-sm font-semibold text-brand-50 shadow-sm transition-colors hover:bg-brand-900"
            >
              <MessageCircle aria-hidden size={16} />
              Ask FinSight
            </button>
            {stale ? (
              <button
                type="button"
                onClick={onRefresh}
                disabled={busy}
                className="inline-flex min-h-tap items-center justify-center gap-1.5 rounded-xl bg-paper px-3 text-xs font-semibold text-ink-700 ring-1 ring-paper-200 transition-colors hover:bg-tint-brand hover:text-tone-brand disabled:opacity-60"
              >
                <RefreshCw aria-hidden size={14} /> {busy ? "Looking…" : "Item changed: look again"}
              </button>
            ) : null}
            <p className="text-center text-[11.5px] text-ink-600">The decision is yours.</p>
          </div>
        </aside>

        <div className="min-w-0 p-6">
          <dl className="divide-y divide-paper-200">
            {facts.map(({ icon: Icon, label, body }) => (
              <div key={label} className="grid gap-1.5 py-3.5 first:pt-0 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-4">
                <dt className="flex items-center gap-2 text-xs font-semibold text-ink-600">
                  <Icon aria-hidden size={15} className="shrink-0 text-tone-brand" />
                  {label}
                </dt>
                <dd className="text-sm leading-relaxed text-ink-700">{body}</dd>
              </div>
            ))}
          </dl>

          {price ? (
            <div className="mt-4">
              <PriceContextPanel price={price} plannedAmount={plannedAmount} />
            </div>
          ) : null}

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold text-ink-900">Questions only you can answer</p>
              <span className="figure text-xs text-ink-500">
                {answered.size}/{review.questions.length}
              </span>
            </div>
            <ul className="mt-2.5 space-y-2">
              {review.questions.map((question) => {
                const done = answered.has(question);
                return (
                  <li key={question}>
                    <label
                      className={`flex cursor-pointer gap-3 rounded-xl p-3 text-sm leading-relaxed ring-1 transition-colors ${
                        done
                          ? "bg-paper-100 text-ink-600 ring-paper-200"
                          : "bg-paper text-ink-700 ring-paper-200 hover:bg-tint-brand/50 hover:ring-edge-brand"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={done}
                        onChange={() =>
                          setAnswered((prev) => {
                            const next = new Set(prev);
                            if (next.has(question)) next.delete(question);
                            else next.add(question);
                            return next;
                          })
                        }
                        className="mt-0.5 size-4 shrink-0 accent-brand-700"
                      />
                      {question}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </article>
  );
}

export function SpendingImpact() {
  return (
    <ReportingPeriodScope scope="spending-impact">
      <SpendingImpactPage />
    </ReportingPeriodScope>
  );
}

function SpendingImpactPage() {
  const { selected } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  // Ask FinSight's "Open this in Spending Impact" arrives with the amount it
  // parsed from the owner's question. It only fills the box; the owner still
  // presses Calculate.
  const location = useLocation();
  const [plannedAmount, setPlannedAmount] = useState<number | "">(() => {
    const prefill = (location.state as { plannedAmount?: unknown } | null)?.plannedAmount;
    return typeof prefill === "number" && Number.isFinite(prefill) && prefill > 0 ? prefill : "";
  });
  const [description, setDescription] = useState("");
  // The page's period (This week, a month, All time): what "recent spending"
  // means for the before/after expense line.
  const { selection, ready: periodReady } = useReportingPeriod();
  const periodKey = JSON.stringify(selection);
  const [data, setData] = useState<SpendingImpactData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);

  // The category is reference-only — like Description, it is never sent to
  // /insights/spending-impact and never affects the calculation. This is a
  // hypothetical, unsaved expense, not a real record, so there is no actual
  // category assignment for it yet; this is a hint at what it MIGHT be filed
  // under, not a computed input.
  const [categoryId, setCategoryId] = useState<number | "">("");
  // Once the owner picks a category by hand, a later suggestion must not
  // silently overwrite their choice — "editable" has to mean it stays edited.
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the two "ask about this" entry points below hand one
  // through to be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Spending Impact");

  /*
   * The item review, and the description it was written about.
   *
   * `reviewedItem` is what makes "look again" honest: the card stays on screen
   * while the owner edits the description — losing it on every keystroke would
   * be worse — but it says out loud that it is describing the older wording
   * rather than silently appearing to describe the new one.
   *
   * ASKED FOR, NOT AUTOMATIC. The category suggestion beside it fires from a
   * typing debounce because it fills one field the owner can overrule at a
   * glance. This is several paragraphs of AI prose and a billed call per press
   * — putting it behind a button means it arrives when someone wants it,
   * rather than three times while they finish typing "display fridge".
   */
  const [review, setReview] = useState<PurchaseReview | null>(null);
  /*
   * Kept beside the review but NOT part of it: these are the owner's own
   * figures, calculated server-side over their records, and they survive the
   * model being unreachable. A card can show this half alone.
   */
  const [price, setPrice] = useState<PurchasePriceContext | null>(null);
  const [reviewedItem, setReviewedItem] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function fetchImpact(amount: number) {
    if (!selected) return;
    setIsCalculating(true);
    try {
      const { data } = await api.get<SpendingImpactData>("/insights/spending-impact", {
        params: { businessProfileId: selected.id, plannedAmount: amount, ...periodParams(selection) },
      });
      setData(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsCalculating(false);
    }
  }

  /*
   * Nothing here is saved and nothing is recorded against the business — this
   * asks what the ITEM is, and the only things it sends are the words the
   * owner typed and the amount. The server adds the business TYPE and stops
   * there; the figures on this page stay structural.
   */
  async function fetchReview() {
    if (!selected) return;
    const item = description.trim();
    if (item.length < 3) return;

    setReviewing(true);
    setReviewError(null);
    try {
      const { data } = await api.post<{
        review: PurchaseReview | null;
        priceContext: PurchasePriceContext | null;
      }>("/ai/purchase-review", {
        businessProfileId: selected.id,
        description: item,
        ...(plannedAmount === "" ? {} : { plannedAmount }),
        /*
         * Only to choose WHICH of the owner's records the amount is compared
         * against. It still plays no part in the impact calculation — the
         * category on this page has always been reference-only.
         */
        ...(categoryId === "" ? {} : { categoryId }),
      });
      setReview(data.review);
      setPrice(data.priceContext ?? null);
      setReviewedItem(item);
      if (!data.review) {
        // The AI is unreachable, or said something the server would not pass
        // on. Named rather than left as an empty space where a card was
        // expected — and the page's own figures are untouched either way.
        setReviewError(
          "Couldn’t describe this item: the AI is unreachable. Your figures are calculated by FinSight, not by AI, so they are unaffected.",
        );
      }
    } catch (err) {
      setReviewError(getErrorMessage(err));
    } finally {
      setReviewing(false);
    }
  }

  useEffect(() => {
    if (!selected || plannedAmount === "") {
      setData(null);
      return;
    }
    if (!periodReady) return;
    const timeout = setTimeout(() => fetchImpact(plannedAmount), 200);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, plannedAmount, periodKey, periodReady]);

  // Suggests a category from the description text, against this business's
  // OWN categories only (see suggestCategoryForDescription on the backend —
  // it never invents a category that isn't already one of the owner's own).
  // Debounced longer than the amount effect above: this is a real AI round
  // trip, not a local calculation, so firing it on every keystroke would be
  // both slow and wasteful.
  useEffect(() => {
    if (!selected || categoryTouched || description.trim().length < 3) return;
    const timeout = setTimeout(async () => {
      setSuggesting(true);
      try {
        const { data } = await api.post<{ suggestion: CategorySuggestion | null }>("/ai/suggest-category", {
          businessProfileId: selected.id,
          description: description.trim(),
        });
        setCategoryId(data.suggestion?.categoryId ?? "");
      } catch {
        // A missing suggestion just means the owner picks one themselves —
        // not worth surfacing as a page-level error for a purely optional hint.
      } finally {
        setSuggesting(false);
      }
    }, 500);
    return () => clearTimeout(timeout);
  }, [selected, description, categoryTouched]);

  /*
   * No `if (!selected) return <NoBusinessProfile />` any more. Nothing on this
   * page is ever saved — it is a what-if calculator — so with no business it
   * keeps its form and sits in its own "enter an amount" state, with the two
   * things that genuinely need a profile (the funds line and the AI item
   * review) standing down. Both effects above already no-op without one, so
   * no request is fired.
   */

  const fundsCalculation = data?.availableFundsCalculation;
  const displayedAvailableFunds =
    fundsCalculation?.calculatedAmount ??
    data?.funds.before ??
    selected?.availableFunds ??
    0;
  const availableFundsLabel = fundsCalculation
    ? "Recorded available funds"
    : data
      ? "Available funds"
      : "Starting available funds";
  const availableFundsProvenance = fundsCalculation
    ? `Starting ${formatMoney(fundsCalculation.baselineAmount)}, plus ${formatMoney(fundsCalculation.confirmedSalesAdded)} sales, less ${formatMoney(fundsCalculation.confirmedExpensesDeducted)} expenses.`
    : null;

  // Before the first simulation, the stored starting amount is the only v1
  // value available for sizing the control. The response replaces it.
  const sliderMaximum = Math.max(
    50000,
    Math.ceil((displayedAvailableFunds * 1.25) / 1000) * 1000,
  );

  // Names the exact scenario the card above just described — the planned
  // amount and its impact band — rather than a generic "tell me more".
  const expandQuestion = data
    ? `Why is spending ${formatMoney(data.plannedAmount)}${description ? ` on ${description}` : ""} a ${data.impactBand.toLowerCase()}?`
    : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Spending impact"
        subtitle="What-if check. Nothing is saved."
      />

      <InsightsTabs />

      <section className="overflow-hidden rounded-2xl bg-paper shadow-sm ring-1 ring-paper-200">
        <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          {/* ============ The question, written as a sentence ============ */}
          <div className="flex flex-col p-5 sm:p-8">
            <h2 className="eyebrow">Spending scenario</h2>
            {/*
              The two inputs sit inside the sentence they answer, so the form
              reads as the question the owner is actually asking. Each keeps
              its own label for assistive tech; the sentence is the visual one.
            */}
            <p className="mt-4 font-display text-[1.6rem] font-semibold leading-[1.75] tracking-[-0.015em] text-ink-900 sm:text-[2rem]">
              If I buy{" "}
              <label htmlFor="description" className="sr-only">
                What are you planning to buy? (optional)
              </label>
              <input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Display fridge"
                style={{ width: `${description ? Math.max(description.length, 4) + 1 : 17}ch` }}
                className="max-w-full border-0 border-b-2 border-dashed border-ink-300 bg-transparent px-1 text-tone-brand placeholder:font-normal placeholder:text-ink-300 focus:border-solid focus:border-brand-600 focus:outline-none"
              />{" "}
              for{" "}
              <span className="inline-flex items-baseline whitespace-nowrap">
                <span aria-hidden className="figure mr-1.5 text-[0.7em] text-ink-400">PHP</span>
                <label htmlFor="plannedAmount" className="sr-only">
                  Planned amount
                </label>
                <input
                  id="plannedAmount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={plannedAmount}
                  onChange={(e) => setPlannedAmount(e.target.value === "" ? "" : Number(e.target.value))}
                  // A focused number box would otherwise change its value
                  // when the owner scrolls the page past it.
                  onWheel={(e) => e.currentTarget.blur()}
                  placeholder="11000"
                  style={{ width: `${Math.max(String(plannedAmount).length, 5) + 1}ch` }}
                  className="figure border-0 border-b-2 border-dashed border-ink-300 bg-transparent px-1 text-tone-brand [appearance:textfield] placeholder:font-normal placeholder:text-ink-300 focus:border-solid focus:border-brand-600 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
              </span>
              , what is left?
            </p>

            {/*
              The description used to be a field that changed nothing — a note
              to yourself that the page never read back. This is what makes it
              worth typing into: FinSight looks at the ITEM, not just the
              amount, and hands back the questions the owner is the only person
              who can answer.
            */}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                type="button"
                onClick={fetchReview}
                disabled={!selected || description.trim().length < 3 || reviewing}
                className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-brand-800 px-4 text-sm font-semibold text-brand-50 shadow-sm transition-colors hover:bg-brand-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles aria-hidden size={16} />
                {reviewing ? "Looking at it…" : review ? "Look at this item again" : "What am I buying?"}
              </button>
              <p className="text-xs leading-relaxed text-ink-500">
                {!selected
                  ? "Set up your business first."
                  : description.trim().length < 3
                    ? "Name the item first."
                    : "Describes the item. Doesn't decide for you."}
              </p>
            </div>

            <div className="mt-8">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="amount-slider" className="text-xs font-semibold text-ink-700">
                  Adjust amount
                </label>
                <span className="figure text-xs font-medium text-ink-500">Up to {formatMoney(sliderMaximum)}</span>
              </div>
              <input
                id="amount-slider"
                type="range"
                min={0}
                max={sliderMaximum}
                step={500}
                value={plannedAmount === "" ? 0 : Math.min(plannedAmount, sliderMaximum)}
                onChange={(e) => setPlannedAmount(Number(e.target.value))}
                className="spending-range mt-1 w-full"
                aria-label="Explore planned spending amount"
              />
              {data ? (
                <ZoneBand
                  max={sliderMaximum}
                  noticeableAmount={data.thresholdAmount * 0.4}
                  highAmount={data.thresholdAmount}
                />
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {QUICK_AMOUNTS.filter((amount) => amount <= sliderMaximum).map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => setPlannedAmount(amount)}
                    aria-pressed={plannedAmount === amount}
                    className="figure min-h-tap rounded-full bg-paper-100 px-4 text-xs font-semibold text-ink-700 ring-1 ring-paper-200 transition-colors hover:bg-tint-brand hover:text-tone-brand aria-pressed:bg-brand-700 aria-pressed:text-white aria-pressed:ring-brand-700"
                  >
                    {formatMoney(amount)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setPlannedAmount("");
                    setDescription("");
                    setData(null);
                    setReview(null);
                    setPrice(null);
                    setReviewedItem(null);
                    setReviewError(null);
                  }}
                  className="inline-flex min-h-tap items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-ink-500 hover:bg-paper-100 hover:text-ink-900"
                >
                  <RotateCcw aria-hidden size={14} /> Reset
                </button>
              </div>
            </div>

            <div className="mt-auto pt-8">
            <div className="grid gap-4 border-t border-paper-200 pt-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-end">
              <Field
                label="Reference category"
                htmlFor="category"
                optional
                labelAction={suggesting ? <span className="text-xs text-ink-500">Suggesting…</span> : null}
              >
                <SelectInput
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryTouched(true);
                    setCategoryId(e.target.value === "" ? "" : Number(e.target.value));
                  }}
                >
                  <option value="">No category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </SelectInput>
              </Field>
              <div className="min-w-0 text-xs text-ink-500 sm:text-right">
                {selected ? (
                  <>
                    <span>{availableFundsLabel}</span>:{" "}
                    <b className="figure text-ink-700">
                      {formatMoney(displayedAvailableFunds)}
                    </b>
                    {availableFundsProvenance ? (
                      <span className="mt-1 block leading-relaxed text-ink-500">
                        {availableFundsProvenance}
                      </span>
                    ) : null}
                    <Link
                      to={`/business-profiles/${selected.id}/edit`}
                      className="tap-inline mt-1 inline-block link-action"
                    >
                      Edit starting funds
                    </Link>
                  </>
                ) : (
                  <>
                    {/* No funds figure to work against, so the scenario cannot
                        be calculated — the link goes where that gets fixed
                        rather than to a business-profile edit page that does
                        not exist yet. */}
                    <span>Set up your business to add available funds.</span>{" "}
                    <Link to="/onboarding" className="tap-inline link-action">
                      Finish setup
                    </Link>
                  </>
                )}
              </div>
            </div>
            </div>
          </div>

          {/* ============ The answer, as a receipt ============ */}
          <div
            className="relative border-t border-paper-200 bg-paper-100 px-5 py-8 sm:px-8 lg:border-l lg:border-t-0"
            aria-live="polite"
            aria-busy={isCalculating}
          >
            {isCalculating ? (
              <span className="absolute right-5 top-3 text-xs font-semibold text-tone-brand">Updating…</span>
            ) : null}
            <div className="receipt-slip-shadow mx-auto w-full max-w-md">
              <div className="receipt-slip relative px-6 pt-6 sm:px-7">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-[11rem]">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-500">
                      What-if slip
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {periodLabel(selection)} · not saved
                    </p>
                  </div>
                  {data ? (
                    <span
                      className={`impact-stamp inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-display text-[11px] font-bold uppercase tracking-[0.08em] ${STAMP_INK[data.impactBand]}`}
                    >
                      <span aria-hidden>{BAND_GLYPH[data.impactBand]}</span>
                      {data.impactBand}
                    </span>
                  ) : null}
                </div>

                {!data ? (
                  <div className="py-10 text-center">
                    <IconTile icon={CircleDollarSign} size="lg" />
                    <h2 className="mt-4 font-display text-lg font-bold text-ink-900">
                      {selected ? "Enter a planned amount" : "Set up your business first"}
                    </h2>
                    <div aria-hidden className="mx-auto mt-6 max-w-[16rem] space-y-2.5">
                      {[100, 80, 92].map((w) => (
                        <div key={w} className="flex justify-between gap-4">
                          <span className="h-2 rounded-full bg-paper-200" style={{ width: `${w / 2}%` }} />
                          <span className="h-2 w-16 rounded-full bg-paper-200" />
                        </div>
                      ))}
                    </div>
                    {!selected ? (
                      <ButtonLink to="/onboarding" variant="primary" className="mt-6">
                        Finish business setup
                      </ButtonLink>
                    ) : null}
                  </div>
                ) : (
                  <div className={`transition-opacity duration-200 ${isCalculating ? "opacity-60" : "opacity-100"}`}>
                    <div className={SLIP_RULE} />
                    <dl className="space-y-2 text-sm">
                      <SlipLine label="Available funds" value={formatMoney(data.funds.before)} />
                      <SlipLine
                        label={description.trim() || "Planned purchase"}
                        value={`−${formatMoney(data.plannedAmount)}`}
                      />
                    </dl>
                    <div className="my-3 border-t-[3px] border-double border-ink-300" />
                    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
                      <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink-700">Funds after</p>
                      <p
                        className={`figure break-words text-[2.5rem] font-semibold leading-none tracking-[-0.03em] ${data.funds.after < 0 ? "text-tone-danger" : "text-ink-900"}`}
                      >
                        {formatMoney(data.funds.after)}
                      </p>
                    </div>
                    {data.exceedsFunds ? (
                      <p className="mt-2 text-right text-xs font-semibold text-tone-danger">
                        Exceeds your available funds.
                      </p>
                    ) : null}

                    <div className={SLIP_RULE} />
                    <ImpactGauge data={data} />

                    <div className={SLIP_RULE} />
                    <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-700">
                      <WalletCards aria-hidden className="text-tone-brand" size={14} />
                      Expenses · {periodLabel(selection)}
                    </p>
                    <dl className="space-y-1.5 text-sm">
                      <SlipLine muted label="Now" value={formatMoney(data.periodExpenses.before)} />
                      <SlipLine label="With this purchase" value={formatMoney(data.periodExpenses.after)} />
                    </dl>
                    {data.periodExpenses.before === 0 ? (
                      <p className="mt-2 text-xs text-ink-500">No expenses {periodPhrase(selection)}.</p>
                    ) : null}

                    <div className={SLIP_RULE} />
                    <button
                      type="button"
                      onClick={() => askFinSight(expandQuestion)}
                      aria-label="Ask FinSight about this scenario"
                      className="tap-inline mx-auto flex items-center gap-2 text-sm link-action"
                    >
                      <MessageCircle aria-hidden size={16} />
                      Ask FinSight about this
                    </button>
                  </div>
                )}
              </div>
            </div>

            {error ? <p role="alert" className="mx-auto mt-4 max-w-md text-sm text-tone-danger">{error}</p> : null}
          </div>
        </div>
      </section>

      {/*
        Placed between the scenario and the money summary on purpose: "what am
        I buying" is the question an owner asks BEFORE "and what does it do to
        my funds", and the summary below reads as the closing line either way.
      */}
      {reviewing && !review ? (
        <div className="mt-5 rounded-2xl bg-paper p-5 shadow-md ring-1 ring-paper-200">
          {/* Shaped like the card that is coming, so the page does not jump. */}
          <div className="flex items-center gap-3">
            <span className="h-11 w-11 shrink-0 animate-pulse rounded-xl bg-paper-100" />
            <div className="w-full">
              <span className="block h-4 w-40 animate-pulse rounded bg-paper-100" />
              <span className="mt-2 block h-3 w-64 animate-pulse rounded bg-paper-100" />
            </div>
          </div>
          <span className="mt-4 block h-3 w-full animate-pulse rounded bg-paper-100" />
          <span className="mt-2 block h-3 w-4/5 animate-pulse rounded bg-paper-100" />
          <p className="sr-only" role="status">
            FinSight is describing this item.
          </p>
        </div>
      ) : null}

      {/*
        THE HALVES COME APART CLEANLY. The paragraphs need a model; the price
        comparison needs only the owner's records. When the AI is unreachable
        the second half is still a real answer to "is this normal for me", so
        it is shown on its own rather than thrown away with the card that
        usually carries it.
      */}
      {!review && price ? (
        <div className="mt-5 rounded-2xl bg-paper p-5 shadow-md ring-1 ring-paper-200 sm:p-6">
          <PriceContextPanel price={price} plannedAmount={plannedAmount} />
        </div>
      ) : null}

      {review ? (
        <div className="mt-5">
          <PurchaseReviewCard
            review={review}
            price={price}
            plannedAmount={plannedAmount}
            item={reviewedItem ?? description.trim()}
            stale={!!reviewedItem && reviewedItem !== description.trim()}
            onRefresh={fetchReview}
            onDiscuss={() =>
              askFinSight(discussionPrompt(reviewedItem ?? description.trim(), review, plannedAmount))
            }
            busy={reviewing}
          />
        </div>
      ) : null}

      {reviewError ? (
        <p role="alert" className="mt-4 rounded-xl bg-tint-danger p-3 text-sm text-tone-danger">
          {reviewError}
        </p>
      ) : null}

      <AskFinSightButton originModule="Spending Impact" />
    </div>
  );
}
