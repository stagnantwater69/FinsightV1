import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CircleDollarSign,
  HelpCircle,
  MessageCircle,
  Package,
  RefreshCw,
  Repeat,
  RotateCcw,
  Sparkles,
  Tag as Tag_,
  TrendingDown,
  WalletCards,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { AskFinSightButton, AskFinSightDrawer } from "../components/AskFinSightDrawer";
import type {
  CategorySuggestion,
  ImpactBand,
  PriceComparison,
  PurchaseKind,
  PurchasePriceContext,
  PurchaseReview,
  SpendingImpact as SpendingImpactData,
} from "../lib/types";
import { AiCard, Callout, InfoNote, Kw, PageHead, Pill, type PillTone } from "../components/ui";
import { Field, MoneyInput, SelectInput, TextInput } from "../components/Field";
import { Money, formatMoney } from "../components/Money";
import { discussionPrompt } from "../lib/purchaseConversation";

const PERIOD_OPTIONS = [
  { label: "Today", days: 1 },
  { label: "This week", days: 7 },
  { label: "This month", days: 30 },
];

// The impact band as a themed Pill rather than a white-on-solid chip painted
// with an inline style. The band glyphs stay: severity must survive greyscale
// and colourblindness, so the shape carries it as well as the colour.
const BAND_TONE: Record<ImpactBand, PillTone> = {
  "Low Impact": "ok",
  "Noticeable Impact": "warn",
  "High Impact": "danger",
};

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
  const position = Math.min(100, (data.percentOfFunds / displayCeiling) * 100);
  const noticeablePosition = Math.min(100, ((data.thresholdPercent * 0.4) / displayCeiling) * 100);
  const thresholdPosition = Math.min(100, (data.thresholdPercent / displayCeiling) * 100);

  return (
    <div className="mt-5">
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink-900">Share of available funds</p>
          <p className="text-xs text-ink-500">The marker moves as you change the amount.</p>
        </div>
        <strong className="figure text-xl text-ink-900">{percentText(data)}</strong>
      </div>
      <div
        className="relative pt-7"
        role="meter"
        aria-label="Planned expense as a percentage of available funds"
        aria-valuemin={0}
        aria-valuemax={Math.ceil(displayCeiling)}
        aria-valuenow={Math.min(Math.ceil(displayCeiling), Math.round(data.percentOfFunds))}
        aria-valuetext={`${percentText(data)} of available funds; ${data.impactBand}`}
      >
        <div
          className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink-900 px-2 py-1 text-[11px] font-semibold text-paper shadow-sm transition-[left] duration-300 ease-out"
          style={{ left: `${position}%` }}
        >
          Your scenario
        </div>
        <div className="relative flex h-4 overflow-hidden rounded-full ring-1 ring-paper-200">
          <div className="bg-tint-brand" style={{ width: `${noticeablePosition}%` }} />
          <div className="bg-tint-accent" style={{ width: `${thresholdPosition - noticeablePosition}%` }} />
          <div className="flex-1 bg-tint-danger" />
          <span
            aria-hidden
            className="absolute inset-y-[-4px] w-0.5 bg-ink-900 transition-[left] duration-300 ease-out"
            style={{ left: `${position}%` }}
          />
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-tone-danger/70"
            style={{ left: `${thresholdPosition}%` }}
          />
        </div>
        <div className="mt-2 grid grid-cols-3 text-[11px] font-semibold">
          <span className="text-tone-brand">Low</span>
          <span className="text-center text-tone-accent">Noticeable</span>
          <span className="text-right text-tone-danger">High</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          Your configured high-impact point is {data.thresholdPercent}% (
          <Money value={data.thresholdAmount} />). This is an awareness signal, not purchasing advice.
        </p>
      </div>
    </div>
  );
}

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
    <div className="rounded-xl border border-paper-200 bg-paper-100 p-4">
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
          <p className="mt-0.5 text-xs text-ink-500">
            Counted from your own records — not written by AI
          </p>
        </div>
        {badge ? <Pill tone={badge.tone}>{badge.label}</Pill> : null}
      </div>

      {!hasHistory ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          Nothing in your last {Math.round(price.windowDays / 30)} months looks like this purchase, so
          FinSight has nothing of your own to compare it against yet. The checks above are the ones to
          take to the seller.
        </p>
      ) : (
        <>
          {price.similar.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
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
                      <span className="ml-1.5 text-xs text-ink-500">
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
                  {" "}
                  — this one is about{" "}
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

  return (
    <div className="rounded-2xl bg-paper p-5 shadow-md ring-1 ring-paper-200 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
            <KindIcon aria-hidden size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-ink-900">
              About {item}
            </h2>
            {/*
              Says who wrote these words, in the same language the rest of the
              app uses for the distinction. The figures on this page are
              calculated; this paragraph is not, and an owner is entitled to
              know which is which before weighing it.
            */}
            <p className="mt-0.5 text-xs text-ink-500">
              Written by AI from what you typed — your figures above are calculated, not written
            </p>
          </div>
        </div>
        <Pill tone={PURCHASE_KIND_TONE[review.kind]}>{PURCHASE_KIND_LABEL[review.kind]}</Pill>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-ink-700">{review.kindReason}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-paper-100 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            What it is usually for
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-700">{review.businessUse}</p>
        </div>
        <div className="rounded-xl bg-paper-100 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            What it costs to keep
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-700">
            {review.ongoingCosts ?? "Nothing ongoing that FinSight can name from this description."}
          </p>
        </div>
      </div>

      {/*
        What to CHECK about the amount — never what the amount should be. The
        server refuses any answer that names a figure or calls the price fair,
        cheap or steep, because FinSight has no price feed and a guess sitting
        beside the real figures below would be indistinguishable from them.
      */}
      {review.priceCheck ? (
        <div className="mt-3 flex gap-3 rounded-xl bg-tint-brand p-4">
          <Tag_ aria-hidden className="mt-0.5 shrink-0 text-tone-brand" size={18} />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-tone-brand">
              What to check about the price
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-700">{review.priceCheck}</p>
          </div>
        </div>
      ) : null}

      {price ? (
        <div className="mt-5">
          <PriceContextPanel price={price} plannedAmount={plannedAmount} />
        </div>
      ) : null}

      <div className="mt-5">
        <p className="text-sm font-semibold text-ink-900">Before you decide, answer these yourself</p>
        <ul className="mt-2.5 space-y-2">
          {review.questions.map((question) => (
            <li key={question} className="flex gap-2.5 text-sm leading-relaxed text-ink-700">
              <span
                aria-hidden
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500"
              />
              {question}
            </li>
          ))}
        </ul>
      </div>

      {/*
        The card is one turn, not the end of the subject. This carries what was
        just said into the drawer as a written-out opening question — the owner
        reads it and presses send themselves, the same contract the "expand on
        this" link elsewhere on the page honours. Nothing is asked on their
        behalf.
      */}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-paper-200 pt-4">
        <button
          type="button"
          onClick={onDiscuss}
          className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-brand-800 px-4 text-sm font-semibold text-brand-50 shadow-sm transition-colors hover:bg-brand-900"
        >
          <MessageCircle aria-hidden size={16} />
          Talk this through with FinSight
        </button>
        {stale ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex min-h-tap shrink-0 items-center gap-1.5 rounded-xl bg-paper-100 px-3 text-xs font-semibold text-ink-700 ring-1 ring-paper-200 transition-colors hover:bg-tint-brand hover:text-tone-brand disabled:opacity-60"
          >
            <RefreshCw aria-hidden size={14} /> {busy ? "Looking…" : "Item changed — look again"}
          </button>
        ) : null}
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        FinSight describes and asks. Whether to buy this is your call — it does not know your
        suppliers, your season, or what broke last week.
      </p>
    </div>
  );
}

export function SpendingImpact() {
  const { selected } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  const [plannedAmount, setPlannedAmount] = useState<number | "">("");
  const [description, setDescription] = useState("");
  const [periodDays, setPeriodDays] = useState(30);
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set only by the "expand on this" link — the plain header button opens
  // the drawer with this left undefined, same as always.
  const [drawerQuestion, setDrawerQuestion] = useState<string | undefined>(undefined);

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
        params: { businessProfileId: selected.id, plannedAmount: amount, periodDays },
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
          data.priceContext
            ? "FinSight could not describe this item right now — the AI is unreachable. Your own figures are unaffected: they are calculated by FinSight, not written by AI."
            : "FinSight could not describe this item right now. Your figures above are calculated by FinSight, not by AI, so they are unaffected.",
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
    const timeout = setTimeout(() => fetchImpact(plannedAmount), 200);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, plannedAmount, periodDays]);

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

  if (!selected) return null;

  const sliderMaximum = Math.max(50000, Math.ceil((selected.availableFunds * 1.25) / 1000) * 1000);

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
        subtitle={
          <>
            Spending-Impact Assessment — answers "What may happen if I spend this amount?" This is a
            what-if check; nothing is saved.
          </>
        }
      />

      <InsightsTabs />

      <section className="overflow-hidden rounded-2xl bg-paper shadow-md ring-1 ring-paper-200">
        <div className="grid lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
          <div className="p-5 sm:p-7">
            <div className="mb-6 flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
                <Sparkles aria-hidden size={20} />
              </span>
              <div>
                <h2 className="font-display text-xl font-bold tracking-[-0.02em] text-ink-900">
                  Build your spending scenario
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">
                  Change the amount and watch the impact update. Nothing here is saved.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Field label="What are you planning to buy?" htmlFor="description" optional>
                <TextInput
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Display fridge"
                />
              </Field>
              <Field label="Planned amount" htmlFor="plannedAmount">
                <MoneyInput
                  min={0}
                  value={plannedAmount}
                  onChange={(e) => setPlannedAmount(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="11000"
                />
              </Field>
            </div>

            {/*
              The description used to be a field that changed nothing — a note
              to yourself that the page never read back. This is what makes it
              worth typing into: FinSight looks at the ITEM, not just the
              amount, and hands back the questions the owner is the only person
              who can answer.
            */}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                type="button"
                onClick={fetchReview}
                disabled={description.trim().length < 3 || reviewing}
                className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-brand-800 px-4 text-sm font-semibold text-brand-50 shadow-sm transition-colors hover:bg-brand-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles aria-hidden size={16} />
                {reviewing ? "Looking at it…" : review ? "Look at this item again" : "What am I buying?"}
              </button>
              <p className="text-xs leading-relaxed text-ink-500">
                {description.trim().length < 3
                  ? "Name the item above and FinSight will describe it."
                  : "FinSight describes the item and what to ask — it won't tell you whether to buy it."}
              </p>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="amount-slider" className="text-xs font-semibold text-ink-700">
                  Explore a different amount
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
                className="spending-range mt-3 w-full"
                aria-label="Explore planned spending amount"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {QUICK_AMOUNTS.filter((amount) => amount <= sliderMaximum).map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => setPlannedAmount(amount)}
                    aria-pressed={plannedAmount === amount}
                    className="min-h-tap rounded-xl bg-paper-100 px-3 text-xs font-semibold text-ink-700 ring-1 ring-paper-200 transition-colors hover:bg-tint-brand hover:text-tone-brand aria-pressed:bg-brand-700 aria-pressed:text-white"
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
                  className="inline-flex min-h-tap items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-ink-500 hover:bg-paper-100 hover:text-ink-900"
                >
                  <RotateCcw aria-hidden size={14} /> Reset
                </button>
              </div>
            </div>

            <details className="mt-6 border-t border-paper-200 pt-4">
              <summary className="cursor-pointer text-sm font-semibold text-ink-700 marker:text-brand-600">
                Scenario details
              </summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Compare against" htmlFor="periodDays">
                  <SelectInput value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))}>
                    {PERIOD_OPTIONS.map((o) => (
                      <option key={o.days} value={o.days}>{o.label}</option>
                    ))}
                  </SelectInput>
                </Field>
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
                    <option value="">— No category —</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </SelectInput>
                </Field>
              </div>
            </details>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
              <span>Using {selected.name}'s available funds: <b className="figure text-ink-700">{formatMoney(selected.availableFunds)}</b></span>
              <Link to={`/business-profiles/${selected.id}/edit`} className="font-semibold text-brand-700 hover:text-brand-800">
                Update funds
              </Link>
            </div>
          </div>

          <div className="relative bg-paper-100 p-5 sm:p-7" aria-live="polite" aria-busy={isCalculating}>
            {isCalculating ? (
              <span className="absolute right-5 top-5 text-xs font-semibold text-tone-brand">Updating…</span>
            ) : null}
            {!data ? (
              <div className="flex min-h-[24rem] flex-col items-center justify-center text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-paper text-tone-brand shadow-sm">
                  <CircleDollarSign aria-hidden size={30} />
                </span>
                <h2 className="mt-5 font-display text-xl font-bold text-ink-900">See the money move before you spend it</h2>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-500">
                  Enter an amount or choose a quick scenario. FinSight will show what changes without recording an expense.
                </p>
              </div>
            ) : (
              <div className={`transition-opacity duration-200 ${isCalculating ? "opacity-60" : "opacity-100"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-500">After this {description ? "purchase" : "spending"}, you may have</p>
                    <p className={`figure mt-1 break-words text-4xl font-semibold tracking-[-0.03em] sm:text-5xl ${data.funds.after < 0 ? "text-tone-danger" : "text-ink-900"}`}>
                      {formatMoney(data.funds.after)}
                    </p>
                    <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-500">
                      <TrendingDown aria-hidden size={16} /> {formatMoney(data.plannedAmount)} less than your current funds
                    </p>
                  </div>
                  <Pill tone={BAND_TONE[data.impactBand]}>
                    <span aria-hidden>{BAND_GLYPH[data.impactBand]}</span>
                    {data.impactBand}
                  </Pill>
                </div>

                {data.exceedsFunds ? (
                  <div className="mt-5"><Callout tone="warn"><b>This scenario exceeds your available funds.</b> The remaining amount would be below zero.</Callout></div>
                ) : null}

                <div className="mt-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-paper p-4 shadow-sm">
                  <div>
                    <p className="text-xs font-medium text-ink-500">Before</p>
                    <p className="figure mt-1 text-lg font-semibold text-ink-900">{formatMoney(data.funds.before)}</p>
                  </div>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-brand text-tone-brand"><ArrowRight aria-hidden size={18} /></span>
                  <div className="text-right">
                    <p className="text-xs font-medium text-ink-500">After</p>
                    <p className={`figure mt-1 text-lg font-semibold ${data.funds.after < 0 ? "text-tone-danger" : "text-ink-900"}`}>{formatMoney(data.funds.after)}</p>
                  </div>
                </div>

                <ImpactGauge data={data} />

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="flex gap-3 rounded-xl bg-paper p-3.5 ring-1 ring-paper-200">
                    <WalletCards aria-hidden className="mt-0.5 shrink-0 text-tone-brand" size={18} />
                    <div><p className="text-xs text-ink-500">Expenses this period</p><p className="figure mt-1 text-sm font-semibold text-ink-900">{formatMoney(data.periodExpenses.before)} <span className="mx-1 text-ink-400">→</span> {formatMoney(data.periodExpenses.after)}</p></div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setDrawerQuestion(expandQuestion); setDrawerOpen(true); }}
                    className="flex min-h-tap items-center justify-between gap-3 rounded-xl bg-brand-800 p-3.5 text-left text-brand-50 shadow-sm transition-colors hover:bg-brand-900"
                  >
                    <span><span className="block text-xs text-brand-200">Need more context?</span><span className="mt-1 block text-sm font-semibold">Ask FinSight about this</span></span>
                    <Sparkles aria-hidden size={18} />
                  </button>
                </div>

                {data.periodExpenses.before === 0 ? (
                  <div className="mt-4"><InfoNote>No expenses are recorded for this period yet, so the period comparison becomes more useful after you add records.</InfoNote></div>
                ) : null}
              </div>
            )}

            {error ? <p role="alert" className="mt-4 text-sm text-tone-danger">{error}</p> : null}
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
            onDiscuss={() => {
              setDrawerQuestion(discussionPrompt(reviewedItem ?? description.trim(), review, plannedAmount));
              setDrawerOpen(true);
            }}
            busy={reviewing}
          />
        </div>
      ) : null}

      {reviewError ? (
        <p role="alert" className="mt-4 rounded-xl bg-tint-danger p-3 text-sm text-tone-danger">
          {reviewError}
        </p>
      ) : null}

      {data ? (
        <div className="mt-5">
          <AiCard
            title="What this scenario means"
            subtitle="Built from your figures and FinSight's structured calculation"
            footer="This simulation supports spending awareness and does not tell you whether to proceed with the purchase."
          >
            Spending <Kw><span className="figure">{formatMoney(data.plannedAmount)}</span></Kw>{description ? ` on ${description}` : ""} would move available funds from <Kw><span className="figure">{formatMoney(data.funds.before)}</span></Kw> to <Kw><span className="figure">{formatMoney(data.funds.after)}</span></Kw>. That uses <Kw>{percentText(data)}</Kw> of available funds and falls in your <Kw>{data.impactBand}</Kw> range.
          </AiCard>
        </div>
      ) : null}

      <AskFinSightButton
        onClick={() => {
          setDrawerQuestion(undefined);
          setDrawerOpen(true);
        }}
      />

      <AskFinSightDrawer
        businessProfileId={selected.id}
        module="Spending Impact"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        initialQuestion={drawerQuestion}
      />
    </div>
  );
}
