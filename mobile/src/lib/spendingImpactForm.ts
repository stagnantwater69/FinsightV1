/**
 * The Spending Impact form's input handling, out of the screen and into a
 * file a test can reach.
 *
 * WHY IT LIVES HERE: this repo has no render harness for mobile, so anything
 * that stays inside SpendingImpactScreen.tsx is untestable by construction.
 * The rules below — what counts as a valid peso amount, what to say when it
 * is not, and when an AI purchase review stops describing what is on screen —
 * are exactly the ones that were getting silently wrong before the screen was
 * hardened, so they are the ones worth pinning.
 *
 * The request-sequencing (latest-request-wins) guard stays in the screen: it
 * is two lines around a ref and inseparable from React's lifecycle, which no
 * unit here could exercise honestly.
 */

import { FIELD_LIMITS } from "./fieldLimits";
import { formatMoney } from "./money";
import type { ImpactBand, SpendingImpact } from "./types";

/**
 * What a peso amount is allowed to look like: digits, at most one decimal
 * point, and an optional leading minus.
 *
 * WHY A SHAPE CHECK AND NOT JUST `Number()`. `Number("0x10")` is 16 and
 * `Number("1e5")` is 100000 — so a pasted "0x10" used to become sixteen pesos
 * with no sign to the owner that the app had read something other than what
 * they pasted. The decimal-pad keyboard cannot type either, but paste and a
 * hardware keyboard can, and a currency field silently reinterpreting its own
 * input is the kind of thing that reaches a total.
 *
 * The minus is ADMITTED here rather than rejected, so `amountValidationError`
 * can answer "-500" with "greater than zero" — which names the mistake —
 * instead of the blunter "not a number".
 */
const AMOUNT_SHAPE = /^-?\d*(\.\d*)?$/;

/**
 * The server's ceiling, mirrored rather than invented: `plannedAmount` on
 * backend/src/controllers/ai.controller.ts is `z.number().positive().max(999_999_999)`.
 * Above it the impact endpoint still answers (its own schema is only
 * nonnegative), so the screen would draw a perfectly ordinary impact card and
 * then fail the review call with a raw Zod message — one request accepted and
 * one rejected for the same number.
 */
export const MAX_AMOUNT = 999_999_999;

/**
 * Turns whatever the owner typed into a number, or null if it isn't one.
 *
 * Commas are stripped rather than rejected — "11,000" is how most people
 * write eleven thousand, and a currency field that calls that invalid is
 * arguing with correct input.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  if (!AMOUNT_SHAPE.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * What is wrong with the typed amount, or null when nothing is.
 *
 * Four distinct messages on purpose. "Enter a valid amount" for all of them
 * would tell someone who typed nothing the same thing as someone who typed
 * "-500", and only one of them knows what they did.
 */
export function amountValidationError(raw: string): string | null {
  const value = parseAmount(raw);
  if (value === null) {
    return raw.trim() === "" ? "Enter an amount to check." : "Enter a valid number.";
  }
  if (value <= 0) return "Enter an amount greater than zero.";
  if (value > MAX_AMOUNT) return "That's larger than FinSight can check. Enter ₱999,999,999 or less.";
  return null;
}

/**
 * Whether the impact card on screen still describes the amount in the field.
 *
 * THE CALCULATED HALF NEEDS THIS MORE THAN THE AI HALF DOES. The card is
 * arithmetic over the owner's real funds, so it is the half they trust — and
 * it was the half that lied: editing 11,000 down to 200 left "High Impact"
 * and "uses 84% of your available funds" fully rendered against a field
 * reading 200, because `data` only ever cleared on a business switch.
 *
 * Stale rather than cleared, deliberately, for the same reason the review
 * card stays up: the figures are still a true answer to the last amount
 * CHECKED, and blanking the screen on every keystroke is worse than labelling
 * it. `data.plannedAmount` is what the server actually computed against, so
 * this compares the answer's own amount rather than a remembered copy of the
 * request.
 */
export function isImpactStale(
  computedAmount: number | null,
  currentAmount: number | null,
  /**
   * The comparison window, optional so the two-argument call sites this
   * started with keep working. Passed as a pair or not at all: a card computed
   * over the last 7 days does not describe a screen now set to 30, even when
   * the amount has not moved a peso.
   */
  computedPeriodDays: number | null = null,
  currentPeriodDays: number | null = null,
): boolean {
  if (computedAmount === null) return false;
  if (computedAmount !== currentAmount) return true;
  if (computedPeriodDays === null || currentPeriodDays === null) return false;
  return computedPeriodDays !== currentPeriodDays;
}

/**
 * WHY the result is stale, not merely that it is.
 *
 * "Amount changed — check again" over a card that went stale because the
 * owner switched from This week to This month is a false statement about
 * their own screen, and the refresh affordance is the one place the screen
 * explains itself. Three answers, so the banner can name what actually moved.
 */
export type ImpactStaleReason = "amount" | "period" | "both";

export function impactStaleReason(
  computed: { amount: number | null; periodDays: number | null },
  current: { amount: number | null; periodDays: number | null },
): ImpactStaleReason | null {
  if (computed.amount === null) return null;
  const amountMoved = computed.amount !== current.amount;
  const periodMoved =
    computed.periodDays !== null && current.periodDays !== null && computed.periodDays !== current.periodDays;
  if (amountMoved && periodMoved) return "both";
  if (amountMoved) return "amount";
  if (periodMoved) return "period";
  return null;
}

/** What the stale banner says, per reason. */
export const IMPACT_STALE_COPY: Record<ImpactStaleReason, string> = {
  amount: "Amount changed — check again",
  period: "Period changed — check again",
  both: "Scenario changed — check again",
};

/**
 * Whether the purchase review on screen still describes the current inputs.
 *
 * The card deliberately STAYS on screen while the owner edits — losing
 * several paragraphs on every keystroke would be worse — but it has to say
 * out loud that it describes the older wording or the older amount rather
 * than silently appearing to describe the new one. Web pins the same rule for
 * the item (web/src/pages/SpendingImpact.tsx); mobile also tracks the amount,
 * because the review's price-check paragraph is written against it.
 *
 * `reviewedItem === null` means no review has been fetched, which is not
 * "stale" — there is nothing to be stale.
 */
export function isReviewStale(
  reviewed: { item: string | null; amount: number | null; categoryId?: number | null },
  current: { item: string; amount: number | null; categoryId?: number | null },
): boolean {
  if (reviewed.item === null) return false;
  if (reviewed.item !== current.item.trim() || reviewed.amount !== current.amount) return true;
  /*
   * The reference category travels with the request now (it chooses which of
   * the owner's own records the price context is drawn from), so changing it
   * changes the answer — the "Is this normal for you?" badge in particular.
   * `?? null` on both sides so a call site that does not track a category at
   * all reads as "no category" rather than as a change from undefined to null.
   */
  return (reviewed.categoryId ?? null) !== (current.categoryId ?? null);
}

/** The item field must name something before a review is worth a model call. */
export const MIN_ITEM_LENGTH = 3;

/**
 * The server's own ceiling on the description — `z.string().min(3).max(255)`,
 * the same 255 the record descriptions this mirrors carry. Enforced on the
 * field as `maxLength` so the 256th character cannot be typed, rather than
 * discovered as a 400 after a round trip.
 *
 * The figure itself lives in FIELD_LIMITS, mirrored key-for-key with web's and
 * pinned to the schema by the backend contract suite; this name stays as the
 * screen's enforcement point.
 */
export const MAX_ITEM_LENGTH = FIELD_LIMITS.purchaseDescription;

export function canRequestReview(itemDescription: string): boolean {
  const length = itemDescription.trim().length;
  return length >= MIN_ITEM_LENGTH && length <= MAX_ITEM_LENGTH;
}

/**
 * Whether the item names enough for a category guess to be worth a round trip.
 *
 * The same floor as the review, and for the same reason web uses it
 * (`description.trim().length < 3` in web/src/pages/SpendingImpact.tsx): two
 * characters cannot distinguish one of the owner's categories from another,
 * so the call would spend a model round trip to return noise.
 */
export function canSuggestCategory(itemDescription: string): boolean {
  return itemDescription.trim().length >= MIN_ITEM_LENGTH;
}

/**
 * Whether the category shown was suggested for the words currently typed.
 *
 * The suggestion is a HINT ABOUT THE ITEM, so once the item changes it is a
 * hint about something else. It is not cleared — the owner may have accepted
 * it, and yanking a picker's value out from under someone mid-scenario is
 * worse than labelling it — but the screen stops calling it "suggested".
 */
export function isCategorySuggestionStale(suggestedFor: string | null, currentItem: string): boolean {
  if (suggestedFor === null) return false;
  return suggestedFor !== currentItem.trim();
}

// ------------------------------------------------------------- the scenario

/**
 * The comparison windows, mirroring web's PERIOD_OPTIONS
 * (web/src/pages/SpendingImpact.tsx) day-for-day.
 *
 * The LABELS differ on purpose and only in wording: web renders these in a
 * `<select>` where "Today / This week / This month" reads as a list of
 * choices, and the app renders them in a segmented control three across on a
 * 360dp screen, where the two-word labels wrap. The days are what the server
 * is asked for, and those must not differ — a period the two clients name the
 * same but count differently is the drift this mirrors against.
 */
export const PERIOD_OPTIONS = [
  { label: "Today", days: 1 },
  { label: "Week", days: 7 },
  { label: "Month", days: 30 },
] as const;

export type PeriodDays = (typeof PERIOD_OPTIONS)[number]["days"];

/** What the screen opens on, and what the endpoint itself defaults to. */
export const DEFAULT_PERIOD_DAYS: PeriodDays = 30;

/** The window as a clause inside a sentence, for copy and for the AI prompt. */
export function periodPhrase(days: number): string {
  if (days === 1) return "today's records";
  if (days === 7) return "this week's records";
  return "this month's records";
}

/**
 * The preset amounts beside the field, mirroring web's QUICK_AMOUNTS.
 *
 * NO SLIDER on the phone, deliberately. Web pairs these with a range input;
 * a range control tuned to ₱500 steps up to six figures is roughly forty
 * pesos per pixel on a phone, which is neither precise nor operable with a
 * screen reader or a shaking hand. The presets are the accessible half of the
 * pair, so the app ships that half only.
 */
export const QUICK_AMOUNTS = [5000, 10000, 25000] as const;

/**
 * A preset, as the text field's own value.
 *
 * The field holds a string (that is what a TextInput has), and the presets
 * are numbers, so the conversion is the one place a preset could arrive with
 * a currency symbol or a thousands separator baked into it and then fail
 * `parseAmount` on the very next render.
 */
export function quickAmountValue(amount: number): string {
  return String(amount);
}

/** Whether a preset chip should read as the current selection. */
export function isQuickAmountSelected(amount: number, raw: string): boolean {
  return parseAmount(raw) === amount;
}

/** A blank scenario — what Reset restores. */
export interface ScenarioInput {
  amount: string;
  itemDescription: string;
  categoryId: number | null;
  periodDays: PeriodDays;
}

/**
 * Reset clears the AMOUNT, THE ITEM AND THE CATEGORY, and keeps the period.
 *
 * The period is a way of looking rather than part of the scenario: an owner
 * comparing against this week is still comparing against this week when they
 * price up a different purchase, and resetting it would make them re-choose it
 * every time. Web resets the same three and leaves its period select alone.
 */
export function resetScenario(periodDays: PeriodDays): ScenarioInput {
  return { amount: "", itemDescription: "", categoryId: null, periodDays };
}

// ----------------------------------------------------------------- the gauge

/**
 * The share-of-funds figure as words.
 *
 * The server sends 999999 as "the funds are zero, so any purchase is
 * infinitely large a share of them" — printed literally that is "999999.0% of
 * your available funds", which is not a fact about anybody's business. Mirrors
 * web's `percentText`.
 */
export function percentOfFundsText(percentOfFunds: number): string {
  return percentOfFunds >= 999999 ? "more than 100%" : `${percentOfFunds.toFixed(1)}%`;
}

/**
 * The severity of a band, as a name the theme's status families already use.
 *
 * Web maps the same three bands onto its Pill tones (ok / warn / danger).
 * Kept as a function of the band rather than as three colours, because the
 * point of the mapping is that the two clients agree about which band is
 * which — the colours themselves are per-platform.
 */
export type BandTone = "good" | "warning" | "critical";

export const BAND_TONE: Record<ImpactBand, BandTone> = {
  "Low Impact": "good",
  "Noticeable Impact": "warning",
  "High Impact": "critical",
};

/**
 * A written label for each band, for the places the band is spoken rather
 * than shown as a pill — the gauge's screen-reader value, the prepared
 * question, the thin-data note.
 */
export const BAND_SENTENCE: Record<ImpactBand, string> = {
  "Low Impact": "low impact",
  "Noticeable Impact": "noticeable impact",
  "High Impact": "high impact",
};

/**
 * Where the marker and the two zone boundaries sit on the gauge, as
 * percentages of its width.
 *
 * Lifted from web's ImpactGauge unchanged, so the same scenario puts the
 * marker in the same place on both clients:
 *   - the ceiling is 35% past the owner's own high-impact threshold, or the
 *     scenario itself when that is larger, so the marker never pins to the end
 *     and stops moving;
 *   - "noticeable" starts at 40% of the threshold;
 *   - "high" starts at the threshold the owner configured.
 *
 * A threshold of zero would divide by zero, so the ceiling has a floor of 1.
 */
export interface GaugeGeometry {
  displayCeiling: number;
  markerPercent: number;
  noticeablePercent: number;
  thresholdPercent: number;
}

export function gaugeGeometry(percentOfFunds: number, thresholdPercent: number): GaugeGeometry {
  const displayCeiling = Math.max(thresholdPercent * 1.35, percentOfFunds, 1);
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  return {
    displayCeiling,
    markerPercent: clamp((percentOfFunds / displayCeiling) * 100),
    noticeablePercent: clamp(((thresholdPercent * 0.4) / displayCeiling) * 100),
    thresholdPercent: clamp((thresholdPercent / displayCeiling) * 100),
  };
}

/**
 * What a screen reader is told the gauge reads.
 *
 * A meter announced as "62" is a number with no unit and no verdict. This is
 * the whole statement — the share, what it is a share of, and the band in
 * words — because the band's colour and the band's glyph are both unavailable
 * to the person hearing this.
 */
export function gaugeAccessibilityText(data: Pick<SpendingImpact, "percentOfFunds" | "impactBand">): string {
  return `${percentOfFundsText(data.percentOfFunds)} of your available funds — ${BAND_SENTENCE[data.impactBand]}.`;
}

// ------------------------------------------------------------- thin evidence

/**
 * How much recorded evidence the comparison window actually has behind it.
 *
 * WHY THIS EXISTS: the period comparison is the one figure on the screen that
 * silently degrades. "Recorded expenses: PHP 0 → PHP 11,000" is arithmetic on
 * an empty window, and it looks exactly like arithmetic on a full one — an
 * owner who has not recorded anything today sees a scenario that appears to
 * multiply their spending by infinity, and nothing on screen says the zero is
 * an absence of records rather than an absence of spending.
 *
 * WEB ONLY HANDLES THE ZERO CASE (`data.periodExpenses.before === 0`). The
 * "thin" band below is a deliberate mobile addition, not drift: it changes
 * WORDING ONLY and never a figure, and a phone is where short windows get
 * chosen most, because the segmented control makes "Today" one tap away.
 *
 * The threshold is relative to the owner's own funds rather than absolute:
 * ₱200 of recorded expenses is a normal quiet day for a sari-sari store and
 * an obviously empty window for a business holding half a million.
 */
export type PeriodEvidence = "none" | "thin" | "normal";

/** Below this share of available funds, a whole window's expenses read as empty. */
const THIN_PERIOD_SHARE = 0.01;

export function periodEvidence(
  periodExpensesBefore: number,
  availableFunds: number,
): PeriodEvidence {
  if (periodExpensesBefore <= 0) return "none";
  if (availableFunds > 0 && periodExpensesBefore < availableFunds * THIN_PERIOD_SHARE) return "thin";
  return "normal";
}

/**
 * What is missing and what it does to the estimate — or null when the window
 * has enough in it that saying anything would be noise.
 *
 * Names the FUNDS HALF as unaffected in both messages. That is the half the
 * headline figure comes from, it is computed from the business profile rather
 * than from the window, and an owner told "there is not much data" without
 * that sentence has no way to know which of the numbers in front of them to
 * stop trusting.
 */
export function periodEvidenceNote(evidence: PeriodEvidence, periodDays: number): string | null {
  if (evidence === "normal") return null;
  const window = periodPhrase(periodDays);
  if (evidence === "none") {
    return (
      `No expenses are recorded in ${window}, so the period comparison below is measuring against nothing yet. ` +
      `Your available funds and the impact band do not depend on it — they come from your business profile.`
    );
  }
  return (
    `Very little is recorded in ${window}, so the period comparison rests on almost no history. ` +
    `Your available funds and the impact band do not depend on it — they come from your business profile.`
  );
}

// ------------------------------------------------------ the prepared question

/**
 * The question the "Ask FinSight about this" action hands to the chat sheet.
 *
 * NEVER SENT AUTOMATICALLY. The screen shows this sentence to the owner and
 * puts it in the composer for them to edit or delete; §2 of the mobile plan
 * makes that a rule rather than a preference, and it is the difference between
 * a prepared question and a question asked on somebody's behalf.
 *
 * WHY THE CONTEXT TRAVELS IN THE WORDS rather than in the API's `context`
 * field: that field replaces the server-built context and turns the call into
 * a one-shot with no history. Web's purchaseConversation.ts carries the same
 * note. Everything here is already on the owner's screen — the amount, the
 * item, the window and the band — so nothing is disclosed that they have not
 * just read.
 *
 * CAPPED at the same 500 characters the composer and the API enforce, by
 * dropping the item first: a truncated question is one the owner did not
 * write, and the field's own maxLength would silently cut it.
 */
export function scenarioQuestion(scenario: {
  amount: number;
  item: string;
  periodDays: number;
  band: ImpactBand;
}): string {
  const item = scenario.item.trim();
  const money = formatMoney(scenario.amount);
  const band = BAND_SENTENCE[scenario.band];
  const window = periodPhrase(scenario.periodDays);

  const withItem = `Why is spending ${money} on ${item} a ${band} for my business, compared with ${window}?`;
  const withoutItem = `Why is spending ${money} a ${band} for my business, compared with ${window}?`;

  if (item && withItem.length <= FIELD_LIMITS.aiQuestion) return withItem;
  if (withoutItem.length <= FIELD_LIMITS.aiQuestion) return withoutItem;
  // A pathological amount and window cannot both be dropped — it still has to
  // be a question, and this one is answerable from the server's own context.
  return "What should I weigh before making this purchase?";
}
