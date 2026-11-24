import { ContentScrollView } from "../components/ContentScrollView";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  Alert as AlertBanner,
  Callout,
  Card,
  CategorySelect,
  Disclosure,
  ErrorNote,
  Money,
  Screen,
  SelectChip,
  T,
} from "../components/ui";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { InsightHeader } from "../components/InsightsShared";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useAiChat } from "../context/AiChatContext";
import { api, errorMessage } from "../lib/api";
import { availableFundsProvenance } from "../lib/financialPosition";
import * as haptics from "../lib/haptics";
import { formatMoney } from "../lib/money";
import { useDebounced } from "../lib/useDebounced";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "../components/ChartInteraction";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { PeriodSelector } from "../components/PeriodSelector";
import { periodKey, periodLabel, periodParams, windowKey } from "../lib/reportingPeriod";
import {
  BAND_TONE,
  IMPACT_STALE_COPY,
  MAX_ITEM_LENGTH,
  QUICK_AMOUNTS,
  amountValidationError,
  canRequestReview,
  canSuggestCategory,
  gaugeAccessibilityText,
  gaugeGeometry,
  impactStaleReason,
  isCategorySuggestionStale,
  isQuickAmountSelected,
  isReviewStale,
  parseAmount,
  percentOfFundsText,
  periodEvidence,
  periodEvidenceNote,
  quickAmountValue,
  resetScenario,
  scenarioQuestion,
} from "../lib/spendingImpactForm";
import type {
  CategorySuggestion,
  PurchaseKind,
  PurchasePriceContext,
  PurchaseReview,
  SpendingImpact,
} from "../lib/types";
import type { InsightsScreenProps } from "../navigation/types";

// ---------------------------------------------------------------- Spending impact

export function SpendingImpactScreen(props: InsightsScreenProps<"SpendingImpact">) {
  return (
    <ReportingPeriodScope scope="spending-impact">
      <SpendingImpactContent {...props} />
    </ReportingPeriodScope>
  );
}

function SpendingImpactContent({ navigation, route }: InsightsScreenProps<"SpendingImpact">) {
  const t = useTheme();
  const { ACCENT, ink, paper, statusText } = t;
  const { selected, categories } = useBusinessProfiles();

  // ---- the base calculation ----
  const [amount, setAmount] = useState("");

  /*
   * Ask FinSight's "Open this in Spending Impact" arrives with the amount it
   * parsed from the owner's question. It only fills the box — the owner still
   * presses Calculate — and the param is cleared once read, so returning to
   * this screen later does not refill it. An effect rather than the initial
   * state because the screen may already be mounted in the Insights stack.
   */
  const prefillAmount: unknown = route?.params?.plannedAmount;
  useEffect(() => {
    if (typeof prefillAmount !== "number" || !Number.isFinite(prefillAmount) || prefillAmount <= 0) return;
    setAmount(String(prefillAmount));
    navigation.setParams({ plannedAmount: undefined });
  }, [prefillAmount, navigation]);
  /**
   * What is wrong with the typed amount, if anything.
   *
   * A bad amount used to just clear whatever result was already on screen,
   * with nothing said about why. It now stays under the field instead — the
   * old result stays up too, since it is still a true answer to the last
   * VALID amount typed.
   */
  const [amountError, setAmountError] = useState<string | null>(null);
  const [data, setData] = useState<SpendingImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True from the moment Check is pressed to the moment its answer lands. */
  const [checking, setChecking] = useState(false);
  /**
   * The race guard. Every call to `run()` takes the next number; a response
   * is only applied if it is still the most recent one asked for. Without
   * this, a slow answer to an earlier amount could land after a fast answer
   * to a later one and silently overwrite it.
   */
  const checkSeq = useRef(0);
  // This input is drawn by hand rather than through `Field` — it shares a row
  // with the Check button, which `Field`'s own label-above-input layout cannot
  // express. It gets `Field`'s focus border anyway so the app has one focus
  // treatment, not two.
  const [amountFocused, setAmountFocused] = useState(false);

  /**
   * The period the recorded-expenses half is compared against: the shared
   * one (This week, a month, All time) that Home and Expense Insights use.
   * The server counts a different set of records for each, so a card computed
   * for August does not describe a screen set to This week (see
   * `impactStaleReason`).
   */
  const { selection } = useReportingPeriod();
  const currentPeriodKey = periodKey(selection);

  // ---- the item, and what FinSight makes of it ----
  const [itemDescription, setItemDescription] = useState("");
  /**
   * The reference category — which of the owner's OWN records the price
   * context is drawn from.
   *
   * It changes nothing that is saved and nothing that is recorded: no record
   * is filed under it, and no historical record moves. It is sent with the
   * purchase-review call so mobile compares against the same slice of history
   * web does — without it, the app's price context was matched on the
   * description alone while web's was category-scoped, so the same purchase
   * could carry a different "Is this normal for you?" badge on the two
   * clients.
   */
  const [categoryId, setCategoryId] = useState<number | null>(null);
  /** True once the owner has chosen a category themselves — suggestions stop. */
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  /** The exact wording a suggestion was made for, so it can be called stale. */
  const [suggestedFor, setSuggestedFor] = useState<string | null>(null);
  const [suggestFailed, setSuggestFailed] = useState(false);
  const suggestSeq = useRef(0);
  const [review, setReview] = useState<PurchaseReview | null>(null);
  /**
   * Kept beside the review but NOT part of it: these are the owner's own
   * figures, calculated server-side from their records, and they survive the
   * model being unreachable.
   */
  const [price, setPrice] = useState<PurchasePriceContext | null>(null);
  /** What the review on screen was actually written about, so "stale" can be told apart from "wrong". */
  const [reviewedItem, setReviewedItem] = useState<string | null>(null);
  const [reviewedAmount, setReviewedAmount] = useState<number | null>(null);
  /** And which category the price context beside it was drawn from. */
  const [reviewedCategoryId, setReviewedCategoryId] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewSeq = useRef(0);

  const [askOpen, setAskOpen] = useState(false);
  const chat = useAiChat();

  /*
   * A scenario belongs to one business. Switching business voids whatever is
   * on screen and anything still in flight for the business just left — a
   * slow response landing after the switch would otherwise present another
   * business's funds, or another business's purchase review, as this one's.
   */
  useEffect(() => {
    checkSeq.current += 1;
    reviewSeq.current += 1;
    // The category suggestion is voided too, and for the sharpest version of
    // the same reason: category ids are per-business, so an id kept across a
    // switch would name a DIFFERENT category — or none — in the business now
    // on screen, and be sent as the slice of history to compare against.
    suggestSeq.current += 1;
    setData(null);
    setChecking(false);
    setError(null);
    setAmountError(null);
    setReview(null);
    setPrice(null);
    setReviewedItem(null);
    setReviewedAmount(null);
    setReviewedCategoryId(null);
    setReviewing(false);
    setReviewError(null);
    setCategoryId(null);
    setCategoryTouched(false);
    setSuggesting(false);
    setSuggestedFor(null);
    setSuggestFailed(false);
  }, [selected?.id]);

  async function run() {
    if (!selected || checking) return;

    const invalid = amountValidationError(amount);
    if (invalid) {
      setAmountError(invalid);
      haptics.failed();
      return;
    }
    const value = parseAmount(amount)!;
    setAmountError(null);

    const seq = (checkSeq.current += 1);
    setChecking(true);
    try {
      const result = await api.get<SpendingImpact>("/insights/spending-impact", {
        businessProfileId: selected.id,
        plannedAmount: value,
        ...periodParams(selection),
      });
      if (checkSeq.current !== seq) return; // superseded by a request started after this one
      setData(result);
      setError(null);
    } catch (err) {
      if (checkSeq.current !== seq) return;
      setError(errorMessage(err));
    } finally {
      if (checkSeq.current === seq) setChecking(false);
    }
  }

  /*
   * Nothing here is saved and nothing is recorded against the business — this
   * asks what the ITEM is, and the only things it sends are the words the
   * owner typed and the amount, if there is a valid one.
   */
  async function fetchReview() {
    if (!selected || reviewing) return;
    if (!canRequestReview(itemDescription)) return;
    const item = itemDescription.trim();

    const seq = (reviewSeq.current += 1);
    setReviewing(true);
    setReviewError(null);
    try {
      const value = parseAmount(amount);
      const body: Record<string, unknown> = { businessProfileId: selected.id, description: item };
      if (value !== null && value > 0) body.plannedAmount = value;
      // Only ever narrows which of the owner's own records the price half is
      // counted from. The server does not file anything under it, and the
      // impact figures above do not consult it at all.
      if (categoryId !== null) body.categoryId = categoryId;

      const result = await api.post<{ review: PurchaseReview | null; priceContext: PurchasePriceContext | null }>(
        "/ai/purchase-review",
        body,
      );
      if (reviewSeq.current !== seq) return;
      setReview(result.review);
      setPrice(result.priceContext ?? null);
      setReviewedItem(item);
      setReviewedAmount(value);
      setReviewedCategoryId(categoryId);
      if (!result.review) {
        // The AI is unreachable, or said something the server would not pass
        // on. The base calculation and the price context are untouched
        // either way — this only ever explains the missing half.
        setReviewError(
          result.priceContext
            ? "FinSight couldn't describe this item right now — the AI is unreachable. Your figures above are calculated, not written by AI, so they are unaffected."
            : "FinSight couldn't describe this item right now. Your figures above are calculated, not written by AI, so they are unaffected.",
        );
      }
    } catch (err) {
      if (reviewSeq.current !== seq) return;
      setReviewError(errorMessage(err));
    } finally {
      if (reviewSeq.current === seq) setReviewing(false);
    }
  }

  /*
   * `run` reaches for state that changes on every keystroke, so it cannot be
   * a dependency of the effects below without re-running them constantly.
   * Held in a ref and refreshed each render instead: the effects fire on the
   * thing that actually changed, and call the current version.
   */
  const runRef = useRef(run);
  runRef.current = run;

  /**
   * Changing the period re-asks the question rather than only marking the
   * answer stale.
   *
   * The owner has just told the screen which window they mean; leaving them
   * with a figure computed for the old one and a banner asking them to press
   * a button is making them ask twice. The recalculation goes through `run`,
   * so it takes the next sequence number and cannot be overtaken by the
   * in-flight answer for the window they left. When there is nothing on
   * screen yet there is nothing to refresh — the period is simply the one the
   * first Check will use.
   */
  const periodMounted = useRef(false);
  useEffect(() => {
    if (!periodMounted.current) {
      periodMounted.current = true;
      return;
    }
    if (data === null) return;
    void runRef.current();
    // Deliberately keyed on the period alone: `data` is in the condition, not
    // in the dependencies, or every landing answer would trigger another call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPeriodKey]);

  /*
   * The category guess.
   *
   * Debounced at 500ms — the same figure web uses, and for the same reason:
   * this is a model round trip rather than a local calculation, so firing it
   * per keystroke would be slow, wasteful and mostly wrong (a half-typed word
   * classifies to whatever it happens to look like).
   *
   * It stops the moment the owner picks a category themselves. A suggestion
   * that keeps overwriting a deliberate choice is not a suggestion.
   */
  const debouncedItem = useDebounced(itemDescription, 500);
  // The id rather than the profile object: the object's identity changes on
  // every refresh of the business list, and depending on it would re-ask for a
  // suggestion each time something unrelated to this screen was refetched.
  const profileId = selected?.id ?? null;
  useEffect(() => {
    if (profileId === null || categoryTouched) return;
    if (!canSuggestCategory(debouncedItem)) return;
    const item = debouncedItem.trim();
    const seq = (suggestSeq.current += 1);
    let cancelled = false;

    (async () => {
      setSuggesting(true);
      try {
        const result = await api.post<{ suggestion: CategorySuggestion | null }>("/ai/suggest-category", {
          businessProfileId: profileId,
          description: item,
        });
        if (cancelled || suggestSeq.current !== seq) return; // a later wording won
        setCategoryId(result.suggestion?.categoryId ?? null);
        setSuggestedFor(item);
        setSuggestFailed(false);
      } catch {
        if (cancelled || suggestSeq.current !== seq) return;
        /*
         * Not an error banner. Nothing on the screen is broken and no figure
         * is affected — the owner picks a category themselves, exactly as
         * they would have without the guess. It is said quietly beside the
         * picker rather than swallowed entirely, because a control that
         * silently did nothing is its own small mystery.
         */
        setSuggestFailed(true);
      } finally {
        if (!cancelled && suggestSeq.current === seq) setSuggesting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profileId, debouncedItem, categoryTouched]);

  if (!selected) return null;

  const bandTone = data ? BAND_TONE[data.impactBand] : null;
  const bandColor = bandTone ? statusText[bandTone] : ink[400];
  /*
    The band as a tinted pill rather than a solid fill. Solid critical red on
    a white card reads as an error the owner has made; "High Impact" is a
    description of size, and the purchase may still be the right call. The
    text keeps the full-strength colour, so contrast is unchanged.
  */
  const bandSurface = bandTone ? t.statusSurface[bandTone] : paper[100];
  /*
    NEVER COLOUR ALONE. The pill's tint is one of three cues and the least
    reliable of them: it is unavailable in greyscale, to most colourblind
    owners, and to anyone listening. The glyph and the band's own words carry
    the same meaning without it.
  */
  const bandIcon: keyof typeof Ionicons.glyphMap = !bandTone
    ? "ellipse-outline"
    : bandTone === "critical"
      ? "warning-outline"
      : bandTone === "warning"
        ? "alert-circle-outline"
        : "checkmark-circle-outline";

  const currentAmount = parseAmount(amount);
  const reviewStale =
    review !== null &&
    isReviewStale(
      { item: reviewedItem, amount: reviewedAmount, categoryId: reviewedCategoryId },
      { item: itemDescription, amount: currentAmount, categoryId },
    );
  const reviewReady = canRequestReview(itemDescription);
  /*
   * The figures on screen were computed for `data.plannedAmount` over
   * `data.period`; either may since have moved. Same treatment as the
   * review card above, because the dishonesty is the same and this half is
   * the half owners trust — and the banner names WHICH one moved, because
   * "Amount changed" over a card that went stale on a period switch is itself
   * a false statement.
   */
  const staleReason = impactStaleReason(
    { amount: data?.plannedAmount ?? null, period: windowKey(data?.period) },
    { amount: currentAmount, period: currentPeriodKey },
  );

  const suggestionStale = isCategorySuggestionStale(suggestedFor, itemDescription);
  const categoryName = categories.find((c) => c.id === categoryId)?.name ?? null;
  /*
   * "No category" as a real option rather than an absent one. The picker is
   * for narrowing the owner's own history, and "compare against everything"
   * is a legitimate answer to that — with no entry for it, the only way back
   * out of a wrong guess would be to pick a different wrong category.
   */
  const NO_CATEGORY_ID = -1;
  const categoryOptions = [{ id: NO_CATEGORY_ID, name: "No category — compare everything" }, ...categories];

  const evidence = data ? periodEvidence(data.periodExpenses.before, data.funds.before) : "normal";
  const evidenceNote = data ? periodEvidenceNote(evidence, selection) : null;

  /** The prepared question — shown to the owner, never sent for them. */
  const preparedQuestion = data
    ? scenarioQuestion({
        amount: data.plannedAmount,
        item: reviewedItem ?? itemDescription,
        period: selection,
        band: data.impactBand,
      })
    : null;
  const fundsCalculation = data?.availableFundsCalculation ?? null;

  function resetAll() {
    haptics.tapped();
    // Both in-flight halves are voided as well as the visible ones: an answer
    // to the scenario just cleared has nothing to describe, and landing after
    // the reset it would look like an answer to the blank form.
    checkSeq.current += 1;
    reviewSeq.current += 1;
    suggestSeq.current += 1;
    const fresh = resetScenario();
    setAmount(fresh.amount);
    setItemDescription(fresh.itemDescription);
    setCategoryId(fresh.categoryId);
    setCategoryTouched(false);
    setSuggestedFor(null);
    setSuggestFailed(false);
    setSuggesting(false);
    setData(null);
    setChecking(false);
    setError(null);
    setAmountError(null);
    setReview(null);
    setPrice(null);
    setReviewedItem(null);
    setReviewedAmount(null);
    setReviewedCategoryId(null);
    setReviewing(false);
    setReviewError(null);
  }

  /**
   * Hands the prepared question to Ask FinSight — into the composer, NOT into
   * the model.
   *
   * `setInput` puts it where a question the owner typed themselves would be,
   * so the send button is theirs to press, the words are theirs to edit, and
   * deleting the lot is one press of backspace. §2 of the mobile plan makes
   * this a rule: a contextual question may be prepared and must never be sent
   * automatically.
   */
  function askAboutScenario() {
    if (!preparedQuestion) return;
    haptics.tapped();
    chat.setInput(preparedQuestion);
    setAskOpen(true);
  }

  return (
    <Screen safeTop>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ContentScrollView
          // The FAB floats over this list, so the scroll has to end far enough
          // up that it can never cover the last card.
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
        >
          <InsightHeader navigation={navigation} active="SpendingImpact" title="Spending impact" />

          {/* Web's subtitle, word for word: the page is a what-if, and says so once. */}
          <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.lg }}>
            What-if check. Nothing is saved.
          </T>

          {/* The question as a sentence, as on web: each input keeps its own label; the sentence is the visual one. */}
          <Card style={{ marginBottom: space.lg }}>
            <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.brandText, letterSpacing: 1.2, textTransform: "uppercase" }}>
              Spending scenario
            </T>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6, rowGap: space.xs, marginTop: space.md }}>
              <T style={[SENTENCE, { color: t.textPrimary }]}>If I buy</T>
              <TextInput
                value={itemDescription}
                onChangeText={setItemDescription}
                placeholder="e.g. Display fridge"
                placeholderTextColor={t.textMuted}
                accessibilityLabel="What are you planning to buy? (optional)"
                returnKeyType="done"
                // The server's own ceiling, so a long name is stopped here rather than refused there.
                maxLength={MAX_ITEM_LENGTH}
                style={[SENTENCE, sentenceInput(t.border), { minWidth: 170, color: t.brandText }]}
              />
              <T style={[SENTENCE, { color: t.textPrimary }]}>for</T>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                <T style={{ fontSize: typeScale.bodySm, color: t.textMuted, fontFamily: font.mono }} accessibilityElementsHidden importantForAccessibility="no">PHP</T>
                <TextInput
                  value={amount}
                  onChangeText={(v) => {
                    setAmount(v);
                    if (amountError) setAmountError(null);
                  }}
                  onSubmitEditing={run}
                  onFocus={() => setAmountFocused(true)}
                  onBlur={() => setAmountFocused(false)}
                  keyboardType="decimal-pad"
                  placeholder="11000"
                  placeholderTextColor={t.textMuted}
                  accessibilityLabel="Planned amount, in Philippine pesos"
                  style={[
                    SENTENCE,
                    sentenceInput(amountError ? statusText.critical : amountFocused ? t.brandText : t.border),
                    { minWidth: 110, color: t.brandText, fontFamily: font.monoSemibold },
                  ]}
                />
              </View>
              <T style={[SENTENCE, { color: t.textPrimary }]}>what is left?</T>
            </View>

            {/* Explicit, unlike web's live recalculation: a phone keyboard covers the answer, so the owner says when. */}
            <Pressable
              onPress={run}
              disabled={checking}
              accessibilityRole="button"
              accessibilityLabel={checking ? "Checking this planned amount" : "Check this planned amount"}
              accessibilityState={{ disabled: checking, busy: checking }}
              style={({ pressed }) => ({
                marginTop: space.lg,
                minHeight: TAP_FLOOR,
                borderRadius: radius.md,
                backgroundColor: ACCENT.fill,
                alignItems: "center",
                justifyContent: "center",
                opacity: checking ? 0.7 : pressed ? 0.9 : 1,
              })}
            >
              {checking ? (
                <ActivityIndicator color={ACCENT.onFill} />
              ) : (
                <T style={{ color: ACCENT.onFill, fontFamily: font.sansSemibold }}>Check what is left</T>
              )}
            </Pressable>
            {checking ? (
              <View accessibilityLiveRegion="polite" accessibilityLabel="Updating the estimate" style={{ marginTop: space.sm }}>
                <T variant="caption" style={{ color: t.brandText, fontFamily: font.sansSemibold }}>Updating…</T>
              </View>
            ) : null}
            {amountError ? (
              <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", gap: 5, marginTop: space.sm, alignItems: "flex-start" }}>
                <Ionicons name="warning-outline" size={14} color={statusText.critical} style={{ marginTop: 1 }} accessibilityElementsHidden importantForAccessibility="no" />
                <T style={{ flex: 1, fontSize: typeScale.caption, lineHeight: 17, color: statusText.critical }}>{amountError}</T>
              </View>
            ) : null}
            {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}

            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, marginTop: space.md }}>
              <Pressable
                onPress={fetchReview}
                disabled={!reviewReady || reviewing}
                accessibilityRole="button"
                accessibilityLabel={reviewing ? "Looking at this item" : review ? "Look at this item again" : "What am I buying? Ask FinSight to describe this item."}
                accessibilityState={{ disabled: !reviewReady || reviewing, busy: reviewing }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  minHeight: TAP_FLOOR,
                  paddingHorizontal: space.md,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: t.border,
                  backgroundColor: t.surface,
                  opacity: !reviewReady || reviewing ? 0.5 : pressed ? 0.85 : 1,
                })}
              >
                {reviewing ? <ActivityIndicator color={t.brandText} size="small" /> : <Ionicons name="search-outline" size={16} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />}
                <T style={{ fontSize: typeScale.caption, color: t.brandText, fontFamily: font.sansSemibold }}>
                  {reviewing ? "Looking at it…" : review ? "Look at this item again" : "What am I buying?"}
                </T>
              </Pressable>
              {!reviewReady ? <T variant="caption" style={{ flexShrink: 1 }}>Name the item first.</T> : null}
            </View>

            {/* Presets, not web's slider: PHP 500 steps across six figures are too fine for a thumb or a screen reader. */}
            <T variant="label" style={{ marginTop: space.lg, marginBottom: space.sm }}>Adjust amount</T>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
              {QUICK_AMOUNTS.map((preset) => (
                <SelectChip
                  key={preset}
                  label={formatMoney(preset)}
                  selected={isQuickAmountSelected(preset, amount)}
                  accessibilityLabel={`Use ${formatMoney(preset)} as the planned amount`}
                  onPress={() => {
                    setAmount(quickAmountValue(preset));
                    setAmountError(null);
                  }}
                />
              ))}
              <Pressable
                onPress={resetAll}
                accessibilityRole="button"
                accessibilityLabel="Start a fresh scenario"
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: TAP_FLOOR, paddingHorizontal: space.sm, opacity: pressed ? 0.6 : 1 })}
              >
                <Ionicons name="refresh" size={14} color={t.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
                <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textMuted }}>Reset</T>
              </Pressable>
            </View>

            {/* Shared with Home and Expense Insights; changing it re-asks the question. */}
            <View style={{ marginTop: space.lg }}>
              <T variant="label" style={{ marginBottom: 6 }}>Compare against</T>
              <PeriodSelector />
            </View>

            <View style={{ marginTop: space.lg, borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.xs }}>
              <Disclosure
                title="Reference category"
                summary={
                  suggesting
                    ? "Suggesting…"
                    : categoryName
                      ? suggestionStale
                        ? `${categoryName}, suggested for earlier wording`
                        : `${categoryName}${suggestedFor && !categoryTouched ? " (suggested)" : ""}`
                      : "No category, compare everything"
                }
              >
                <View style={{ gap: space.sm, paddingTop: space.xs }}>
                  <CategorySelect
                    options={categoryOptions}
                    value={categoryId ?? NO_CATEGORY_ID}
                    onChange={(id) => {
                      // Touching it ends the guessing for this scenario.
                      setCategoryTouched(true);
                      setCategoryId(id === NO_CATEGORY_ID ? null : id);
                    }}
                    accessibilityContext="comparing this purchase"
                    sheetTitle="Compare against which category?"
                    placeholder="No category, compare everything"
                  />
                  {/* Says what it does not do: a picker beside the owner's figures looks like filing. */}
                  <T variant="caption" style={{ lineHeight: 17 }}>
                    Only used to choose which of your own past records this purchase is compared against. It does not
                    file anything and does not change any record you have saved.
                  </T>
                  {suggesting ? (
                    <T variant="caption" accessibilityLiveRegion="polite" style={{ color: t.brandText }}>Suggesting a category…</T>
                  ) : null}
                  {suggestFailed && !suggesting ? (
                    <T variant="caption">FinSight couldn't suggest one just now. Choose a category yourself if you want one.</T>
                  ) : null}
                  {suggestionStale && categoryName ? (
                    <T variant="caption">Suggested for "{suggestedFor}". Check it still fits what you typed.</T>
                  ) : null}
                </View>
              </Disclosure>
            </View>

            {/* What the check works against, as web's footer line under the scenario. */}
            <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md, marginTop: space.xs }}>
              {fundsCalculation || data ? (
                <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
                  <T variant="caption">{fundsCalculation ? `${selected.name}'s recorded available funds:` : "Funds used in this check:"}</T>
                  <Money value={fundsCalculation ? fundsCalculation.calculatedAmount : data!.availableFunds} size={typeScale.caption} weight="semibold" />
                </View>
              ) : (
                <T variant="caption">Checked against your recorded available funds.</T>
              )}
              {fundsCalculation || data ? (
                <Disclosure title="Where this figure comes from">
                  <T variant="caption" style={{ lineHeight: 17 }}>
                    {fundsCalculation ? availableFundsProvenance(fundsCalculation) : "Source details are not available for this result. Run the check again after FinSight updates."}
                  </T>
                </Disclosure>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit opening balance"
                onPress={() => {
                  haptics.tapped();
                  navigation.navigate("More", { screen: "BusinessProfileForm", params: { profile: selected } });
                }}
                style={({ pressed }) => ({ minHeight: TAP_FLOOR, justifyContent: "center", alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 })}
              >
                <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.brandText }}>Edit opening balance</T>
              </Pressable>
            </View>
          </Card>

          {/* The answer, as a receipt: web's "What-if slip". */}
          <View style={{ backgroundColor: t.surfaceMuted, borderRadius: radius.lg, padding: space.md, marginBottom: space.lg }}>
            <View style={{ backgroundColor: t.surface, borderRadius: radius.md, padding: space.lg, borderWidth: 1, borderColor: t.border }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <T accessibilityRole="header" style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textMuted, letterSpacing: 1.8, textTransform: "uppercase" }}>
                    What-if slip
                  </T>
                  <T variant="caption" style={{ marginTop: 2 }}>{periodLabel(selection)}</T>
                </View>
                {data ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1.5, borderColor: bandColor, backgroundColor: bandSurface, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 3, transform: [{ rotate: "-2deg" }] }}>
                    {/* The glyph repeats the words beside it, for the eye that cannot use the tint. */}
                    <Ionicons name={bandIcon} size={13} color={bandColor} accessibilityElementsHidden importantForAccessibility="no" />
                    <T style={{ color: bandColor, fontSize: typeScale.micro, fontFamily: font.sansSemibold, letterSpacing: 0.8, textTransform: "uppercase" }}>{data.impactBand} impact</T>
                  </View>
                ) : null}
              </View>

              {!data ? (
                <View style={{ alignItems: "center", paddingVertical: space.xxl }}>
                  <View style={{ width: 64, height: 64, alignItems: "center", justifyContent: "center", marginBottom: space.md }}>
                    <Ionicons name="cash-outline" size={30} color={t.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
                  </View>
                  <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>Enter a planned amount</T>
                  <T variant="caption" style={{ textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 260 }}>
                    See what a planned purchase would do to your funds before you spend it.
                  </T>
                </View>
              ) : (
                <View accessibilityLiveRegion="polite" style={{ opacity: checking ? 0.6 : 1 }}>
                  {/* The scenario has moved on since these were computed; rechecking is one tap. */}
                  {staleReason ? (
                    <Pressable
                      onPress={run}
                      disabled={checking}
                      accessibilityRole="button"
                      accessibilityLabel={checking ? "Rechecking this scenario" : `${IMPACT_STALE_COPY[staleReason]}. These figures describe the previous scenario.`}
                      accessibilityState={{ disabled: checking, busy: checking }}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        alignSelf: "flex-start",
                        minHeight: TAP_FLOOR,
                        paddingHorizontal: space.md,
                        borderRadius: radius.md,
                        backgroundColor: t.statusSurface.warning,
                        marginTop: space.md,
                        opacity: checking ? 0.6 : pressed ? 0.85 : 1,
                      })}
                    >
                      <Ionicons name="refresh" size={14} color={statusText.warning} accessibilityElementsHidden importantForAccessibility="no" />
                      <T style={{ fontSize: typeScale.caption, color: statusText.warning, fontFamily: font.sansSemibold }}>
                        {checking ? "Checking…" : IMPACT_STALE_COPY[staleReason]}
                      </T>
                    </Pressable>
                  ) : null}

                  <SlipRule />
                  <SlipLine label="Available funds" value={formatMoney(data.funds.before, { decimals: true })} />
                  <SlipLine label={(reviewedItem ?? itemDescription).trim() || "Planned purchase"} value={`−${formatMoney(data.plannedAmount, { decimals: true })}`} />
                  {/* The double rule a receipt draws above its total. */}
                  <View style={{ marginVertical: space.md, height: 4, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.textMuted }} />
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", columnGap: space.md }}>
                    <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textSecondary, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 4 }}>
                      Funds after
                    </T>
                    <Money
                      value={data.funds.after}
                      size={typeScale.titleLg + 4}
                      weight="semibold"
                      color={data.funds.after < 0 ? statusText.critical : t.textPrimary}
                    />
                  </View>
                  {data.exceedsFunds ? (
                    <View style={{ marginTop: space.md }}>
                      <AlertBanner kind="needs-review" label="Exceeds your funds">
                        This is more than your recorded available funds.
                      </AlertBanner>
                    </View>
                  ) : null}

                  <SlipRule />
                  <ImpactGauge data={data} />

                  <SlipRule />
                  <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textSecondary, marginBottom: space.sm }}>
                    Expenses · {periodLabel(selection)}
                  </T>
                  <SlipLine muted label="Now" value={formatMoney(data.periodExpenses.before, { decimals: true })} />
                  <SlipLine label="With this purchase" value={formatMoney(data.periodExpenses.after, { decimals: true })} />
                  <Disclosure title="How impact is judged">
                    <T variant="caption" style={{ lineHeight: 17 }}>
                      That uses {percentOfFundsText(data.percentOfFunds)} of your available funds. You treat anything
                      above {data.thresholdPercent}% as high impact.
                    </T>
                  </Disclosure>
                  {/* Thin evidence, explained rather than left to look like a result. */}
                  {evidenceNote ? (
                    <View style={{ marginTop: space.md }}>
                      <Callout tone="warn">{evidenceNote}</Callout>
                    </View>
                  ) : null}

                  {/* Fills the Ask FinSight composer only; the owner sends it, as on web. */}
                  {preparedQuestion ? (<>
                  <SlipRule />
                  <Pressable
                    onPress={askAboutScenario}
                    accessibilityRole="button"
                    accessibilityLabel="Ask FinSight about this scenario"
                    accessibilityHint="Opens Ask FinSight with this question ready. Nothing is sent until you send it."
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: TAP_FLOOR, opacity: pressed ? 0.6 : 1 })}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={16} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
                    <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.brandText }}>Ask FinSight about this</T>
                  </Pressable>
                  </>) : null}
                </View>
              )}
            </View>
          </View>

          {reviewing && !review ? (
            <Card style={{ marginBottom: space.lg }}>
              <T variant="caption" accessibilityRole="text">FinSight is describing this item…</T>
            </Card>
          ) : null}

          {!review && price ? (
            <View style={{ marginBottom: space.lg }}>
              <PriceContextPanel price={price} plannedAmount={currentAmount} />
            </View>
          ) : null}

          {review ? (
            <PurchaseReviewCard
              review={review}
              price={price}
              plannedAmount={currentAmount}
              item={reviewedItem ?? itemDescription.trim()}
              stale={reviewStale}
              refreshing={reviewing}
              onRefresh={fetchReview}
            />
          ) : null}

          {reviewError ? (
            <View style={{ marginBottom: space.lg }}>
              <ErrorNote>{reviewError}</ErrorNote>
            </View>
          ) : null}
        </ContentScrollView>
      </KeyboardAvoidingView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Spending Impact" />
    </Screen>
  );
}

/** Height of the gauge track. Its corner radius is derived from this. */
const GAUGE_HEIGHT = 12;

/**
 * Where this scenario falls between "low", "noticeable" and the owner's own
 * high-impact threshold.
 *
 * SEVERITY IS NEVER THE COLOUR ALONE — a hard requirement of the mobile plan
 * (§2), and the reason this is a meter rather than a coloured bar:
 *   - the three zones are LABELLED in words underneath, not only tinted;
 *   - the marker carries a caret and a figure, so its position is readable
 *     without distinguishing the zone tints at all;
 *   - the whole control announces one sentence — the share, what it is a
 *     share of, and the band in words — so a screen reader user is told the
 *     verdict rather than a number;
 *   - the band's own pill above repeats it a fourth time, with a glyph.
 *
 * The geometry is web's, unchanged (see `gaugeGeometry`), so the same
 * scenario puts the marker in the same place on both clients.
 */
/** The sentence's type: web's display question, at a phone's size. */
const SENTENCE = { fontFamily: font.display, fontSize: typeScale.subpageTitle, lineHeight: 34, letterSpacing: -0.3 } as const;

/** An input set inside the sentence: underlined like a blank on a form, not boxed. */
function sentenceInput(lineColor: string) {
  return { borderBottomWidth: 2, borderBottomColor: lineColor, paddingVertical: 0, paddingHorizontal: 2, minHeight: TAP_FLOOR } as const;
}

/** A dashed rule across the slip, as web's SLIP_RULE. */
function SlipRule() {
  const t = useTheme();
  return <View style={{ height: 1, marginVertical: space.lg, borderWidth: 1, borderStyle: "dashed", borderColor: t.border, borderRadius: 1 }} />;
}

/** One line of the slip: a name on the left, its figure on the right. */
function SlipLine({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.md, paddingVertical: 3 }}>
      <T numberOfLines={2} style={{ flex: 1, fontSize: typeScale.bodySm, color: muted ? t.textMuted : t.textSecondary }}>{label}</T>
      <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoMedium, color: muted ? t.textMuted : t.textPrimary }}>{value}</T>
    </View>
  );
}

function ImpactGauge({ data }: { data: SpendingImpact }) {
  const t = useTheme();
  const geometry = gaugeGeometry(data.percentOfFunds, data.thresholdPercent);
  const impactData: ChartDatum[] = [{ key: "impact", label: "This purchase as a share of available funds", values: [{ label: "Planned purchase", value: data.plannedAmount }, { label: "Available funds before", value: data.funds.before }, { label: "Available funds after", value: data.funds.after }, { label: "Share of funds", value: data.percentOfFunds, display: `${data.percentOfFunds.toFixed(1)}%` }, { label: "High-impact threshold", value: data.thresholdAmount }, { label: "Threshold share", value: data.thresholdPercent, display: `${data.thresholdPercent.toFixed(1)}%` }], note: `${data.impactBand}. Hypothetical purchase; no records are changed.` }];
  const impactSelection = useChartSelection(impactData, `${data.periodStart}:${data.periodEnd}`);
  const zones = [
    { key: "low", label: "Low", width: geometry.noticeablePercent, fill: t.statusSurface.good, ink: t.statusText.good },
    {
      key: "noticeable",
      label: "Noticeable",
      width: Math.max(0, geometry.thresholdPercent - geometry.noticeablePercent),
      fill: t.statusSurface.warning,
      ink: t.statusText.warning,
    },
    {
      key: "high",
      label: "High",
      width: Math.max(0, 100 - geometry.thresholdPercent),
      fill: t.statusSurface.critical,
      ink: t.statusText.critical,
    },
  ];

  return (
    <View style={{ marginTop: space.lg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: space.sm }}>
        <T variant="label" style={{ color: t.ink[700] }}>Share of available funds</T>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>
          {percentOfFundsText(data.percentOfFunds)}
        </T>
      </View>

      <ChartPlotPressArea selection={impactSelection} count={1} chartLabel="Spending impact">
      <View
        /*
         * `accessible` is what makes the three coloured zone views below read
         * as ONE progressbar instead of three unnamed rectangles. Without it
         * the role and the value text below are set on a view the platform
         * never surfaces — RN maps `accessible` straight onto
         * `isAccessibilityElement`, which defaults to false — so the gauge was
         * announced as nothing at all. Caught by
         * tests/render/spendingImpact.test.tsx.
         */
        accessible
        /*
         * "progressbar", not "meter". React Native has no meter role, and an
         * invented one is announced as nothing at all — progressbar is the
         * role both platforms actually read, and `text` is what carries the
         * meaning either way.
         */
        accessibilityRole="progressbar"
        accessibilityLabel="This purchase as a share of your available funds"
        accessibilityValue={{
          min: 0,
          max: Math.ceil(geometry.displayCeiling),
          now: Math.min(Math.ceil(geometry.displayCeiling), Math.round(data.percentOfFunds)),
          text: gaugeAccessibilityText(data),
        }}
        style={{
          flexDirection: "row",
          height: GAUGE_HEIGHT,
          borderRadius: GAUGE_HEIGHT / 2,
          overflow: "hidden",
          marginTop: space.sm,
          backgroundColor: t.surfaceMuted,
        }}
      >
        {zones.map((zone) => (
          <View key={zone.key} style={{ width: `${zone.width}%`, height: "100%", backgroundColor: zone.fill }} />
        ))}
      </View>
      </ChartPlotPressArea>

      {/*
        The marker under the track rather than on it: a caret plus the word
        "You" survives greyscale, a colourblind palette and a low-contrast
        screen in daylight, none of which a coloured notch inside a coloured
        bar does. `left` is a percentage of the row, and it is nudged back by
        its own half-width so the caret points AT the position rather than
        starting from it.
      */}
      <View style={{ height: 26, marginTop: 2 }}>
        <View
          style={{
            position: "absolute",
            left: `${geometry.markerPercent}%`,
            alignItems: "center",
            marginLeft: -22,
            width: 44,
          }}
        >
          <Ionicons name="caret-up" size={12} color={t.textPrimary} />
          <T style={{ fontSize: typeScale.micro, color: t.textPrimary, fontFamily: font.sansSemibold }}>You</T>
        </View>
      </View>

      {/* The zones in words. This is the row that makes the tints redundant. */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {zones.map((zone) => (
          <T key={zone.key} style={{ fontSize: typeScale.micro, color: zone.ink, fontFamily: font.sansSemibold }}>
            {zone.label}
          </T>
        ))}
      </View>
      <ChartValueReadout data={impactData} selection={impactSelection} chartLabel="Spending impact" />

      <T variant="caption" style={{ marginTop: space.sm, lineHeight: 17 }}>
        You treat anything above {data.thresholdPercent}% of your funds (
        <Money value={data.thresholdAmount} bare size={typeScale.caption} weight="medium" />) as high impact. This is
        an awareness signal, not advice about whether to buy.
      </T>
    </View>
  );
}

/**
 * What "kind" of purchase this reads as, in the owner's language rather than
 * an accountant's — see the `PurchaseReview` type for why.
 */
const PURCHASE_KIND_LABEL: Record<PurchaseKind, string> = {
  asset: "Something you keep",
  "running-cost": "Something you use up",
  mixed: "A bit of both",
  unclear: "Hard to tell from this",
};

const PURCHASE_KIND_ICON: Record<PurchaseKind, keyof typeof Ionicons.glyphMap> = {
  asset: "cube-outline",
  "running-cost": "repeat-outline",
  mixed: "repeat-outline",
  unclear: "help-circle-outline",
};

/**
 * What FinSight's own records say about the price — never what the model
 * thinks the price should be. See `PurchasePriceContext` for why the two are
 * kept apart.
 */
function priceComparisonBadge(
  t: ReturnType<typeof useTheme>,
): Partial<Record<PurchasePriceContext["comparison"], { label: string; surface: string; ink: string }>> {
  return {
    below: { label: "Less than you usually spend here", surface: t.brandSurface, ink: t.brandText },
    "in-line": { label: "In line with what you usually spend here", surface: t.statusSurface.good, ink: t.statusText.good },
    above: { label: "More than you usually spend here", surface: t.statusSurface.warning, ink: t.statusText.warning },
    "far-above": { label: "Well beyond anything in your records", surface: t.statusSurface.warning, ink: t.statusText.warning },
  };
}

/**
 * The owner's own price history for this item, kept visually and textually
 * apart from anything the model wrote — "Counted from your own records" is
 * the whole reason this exists as its own panel rather than a paragraph
 * inside the AI card.
 */
function PriceContextPanel({
  price,
  plannedAmount,
  nested = false,
}: {
  price: PurchasePriceContext;
  plannedAmount: number | null;
  /**
   * True when this sits INSIDE the review card, which is already a Card.
   * A Card within a Card drew two borders and two lots of padding around one
   * panel; nested, it wears the muted inset the review card's other blocks
   * wear, which is what says "part of this card" rather than "a second card
   * that happens to be indented".
   */
  nested?: boolean;
}) {
  const t = useTheme();
  const badge = priceComparisonBadge(t)[price.comparison];
  const hasHistory = price.recordCount > 0 || price.similar.length > 0;
  const Frame = nested ? PriceContextInset : Card;

  return (
    <Frame>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <T variant="heading">
            {plannedAmount ? "Is this normal for you?" : "What you usually pay"}
          </T>
          {/*
            Says where these came from, in the same breath as the figures.
            Everything above this panel may have been written by a model;
            these numbers were not, and the difference is the whole reason
            the panel exists.
          */}
          <T variant="caption" style={{ marginTop: 2 }}>
            Counted from your own records — not written by AI
          </T>
        </View>
        {badge ? (
          <View style={{ backgroundColor: badge.surface, borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 3 }}>
            <T style={{ fontSize: typeScale.micro, color: badge.ink }}>{badge.label}</T>
          </View>
        ) : null}
      </View>

      {!hasHistory ? (
        <T style={{ fontSize: typeScale.bodySm, lineHeight: 20, marginTop: space.sm }}>
          Nothing in your last {Math.round(price.windowDays / 30)} months looks like this purchase, so FinSight has
          nothing of your own to compare it against yet.
        </T>
      ) : (
        <>
          {price.similar.length > 0 ? (
            <View style={{ marginTop: space.md }}>
              <T variant="label" style={{ textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                Last time you bought something like this
              </T>
              {price.similar.map((record) => (
                <View
                  key={`${record.description}-${record.date}-${record.amount}`}
                  style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.sm, marginBottom: 4 }}
                >
                  <T style={{ flex: 1, fontSize: typeScale.bodySm }}>
                    {record.description}
                  </T>
                  <Money value={record.amount} size={13} weight="medium" />
                </View>
              ))}
            </View>
          ) : null}

          {price.typicalAmount !== null && price.categoryName ? (
            <T style={{ fontSize: typeScale.bodySm, lineHeight: 20, marginTop: space.sm }}>
              Your {price.recordCount} {price.categoryName} {price.recordCount === 1 ? "record" : "records"} in the last
              year usually run <Money value={price.typicalAmount} bare size={typeScale.bodySm} weight="semibold" />
              {price.multipleOfTypical && price.multipleOfTypical >= 1.4
                ? ` — this one is about ${price.multipleOfTypical}× that.`
                : "."}
            </T>
          ) : null}

          {price.smallestAmount !== null && price.largestAmount !== null && price.typicalAmount !== null && price.recordCount > 1 ? (
            <PriceRangeStrip
              smallest={price.smallestAmount}
              largest={price.largestAmount}
              typical={price.typicalAmount}
              planned={plannedAmount}
            />
          ) : null}
        </>
      )}
    </Frame>
  );
}

/**
 * Where the planned amount sits among what this owner has actually paid: the
 * band is their smallest-to-largest range, the tick is the usual price, the dot
 * is this purchase. Drawn on its own scale so a far-above amount visibly leaves
 * the band. Every figure is also in the sentence above, so this is a picture,
 * not the only place a number appears.
 */
function PriceRangeStrip({
  smallest,
  largest,
  typical,
  planned,
}: {
  smallest: number;
  largest: number;
  typical: number;
  planned: number | null;
}) {
  const t = useTheme();
  const lo = Math.min(smallest, planned ?? smallest) * 0.9;
  const hi = Math.max(largest, planned ?? largest) * 1.05;
  const span = Math.max(hi - lo, 1);
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / span) * 100))}%` as const;
  const spoken = `Your usual price is ${formatMoney(typical)}, ranging from ${formatMoney(smallest)} to ${formatMoney(largest)}.${
    planned !== null ? ` This purchase is ${formatMoney(planned)}.` : ""
  }`;
  const pricePoints = [{ key: "smallest", label: "Smallest recorded purchase", value: smallest }, { key: "typical", label: "Usual price", value: typical }, { key: "largest", label: "Largest recorded purchase", value: largest }, ...(planned !== null ? [{ key: "planned", label: "This purchase", value: planned }] : [])];
  const priceData: ChartDatum[] = pricePoints.map((point) => ({ key: point.key, label: point.label, values: [{ label: point.label, value: point.value }], note: point.key === "planned" ? "Planned amount. This purchase has not been recorded." : point.key === "typical" ? "Median amount from your own expense records" : "From your own expense records" }));
  const priceSelection = useChartSelection(priceData);
  return (
    <View>
    <View accessible accessibilityRole="image" accessibilityLabel={spoken} style={{ marginTop: space.md }}>
      <T variant="caption" style={{ fontSize: typeScale.micro, marginBottom: 6 }}>Your price range</T>
      <ChartPlotPressArea selection={priceSelection} count={priceData.length} chartLabel="Purchase price range" indexAtPoint={({ x, width: plotWidth }) => {
        if (plotWidth <= 0) return null;
        const value = lo + Math.max(0, Math.min(1, x / plotWidth)) * span;
        return pricePoints.reduce((closest, point, index) => Math.abs(point.value - value) < Math.abs(pricePoints[closest]!.value - value) ? index : closest, 0);
      }}>
      <View style={{ height: 10, borderRadius: radius.full, backgroundColor: t.surfaceStrong }}>
        <View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: at(smallest),
            width: `${Math.max(((largest - smallest) / span) * 100, 1)}%`,
            borderRadius: radius.full,
            backgroundColor: t.brandSurface,
            borderWidth: 1,
            borderColor: t.brandBorder,
          }}
        />
        <View style={{ position: "absolute", top: -5, left: at(typical), marginLeft: -1, width: 2, height: 20, borderRadius: 1, backgroundColor: t.ink[700] }} />
        {planned !== null ? (
          <View
            style={{
              position: "absolute",
              top: -4,
              left: at(planned),
              marginLeft: -9,
              width: 18,
              height: 18,
              borderRadius: 9,
              backgroundColor: t.brandFill,
              borderWidth: 3,
              borderColor: t.surface,
            }}
          />
        ) : null}
      </View>
      </ChartPlotPressArea>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
        <T variant="caption" style={{ fontFamily: font.mono }}>{formatMoney(smallest)}</T>
        <T variant="caption" style={{ fontFamily: font.mono }}>{formatMoney(largest)}</T>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 2, height: 12, backgroundColor: t.ink[700] }} />
          <T variant="caption">Usual price</T>
        </View>
        {planned !== null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.brandFill }} />
            <T variant="caption">This purchase</T>
          </View>
        ) : null}
      </View>
    </View>
    <ChartValueReadout data={priceData} selection={priceSelection} chartLabel="Purchase price range" />
    </View>
  );
}

/** The panel's frame when it sits inside another card — see `nested` above. */
function PriceContextInset({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.surfaceMuted, borderRadius: radius.md, padding: space.md }}>{children}</View>
  );
}

/**
 * The optional, item-aware half of Spending Impact: what FinSight makes of
 * the thing the owner typed, alongside their own price history for it.
 *
 * NOT A VERDICT. FinSight monitors and describes; it never says whether to
 * buy — the questions at the bottom are for the owner to answer, and the
 * server itself refuses any answer that crosses from asking into advising
 * (see backend/src/services/ai.service.ts).
 */
function PurchaseReviewCard({
  review,
  price,
  plannedAmount,
  item,
  stale,
  refreshing,
  onRefresh,
}: {
  review: PurchaseReview;
  price: PurchasePriceContext | null;
  plannedAmount: number | null;
  item: string;
  /** The description or amount has moved on since this was written. */
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTheme();
  const kindIsPositive = review.kind === "asset" || review.kind === "mixed";
  const kindBadge = kindIsPositive
    ? { surface: t.brandSurface, ink: t.brandText }
    : { surface: t.surfaceMuted, ink: t.textMuted };

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: t.brandSurface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name={PURCHASE_KIND_ICON[review.kind]} size={20} color={t.textMuted} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="heading" accessibilityRole="header">About {item}</T>
          {/*
            Says who wrote these words, in the same language the rest of the
            app uses for the distinction. The figures on this screen are
            calculated; this paragraph is not, and an owner is entitled to
            know which is which before weighing it.
          */}
          <T variant="caption" style={{ marginTop: 2 }}>
            Written by AI from what you typed — your figures above are calculated, not written
          </T>
        </View>
        <View style={{ backgroundColor: kindBadge.surface, borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 3 }}>
          <T style={{ fontSize: typeScale.micro, color: kindBadge.ink }}>{PURCHASE_KIND_LABEL[review.kind]}</T>
        </View>
      </View>

      <T style={{ fontSize: typeScale.bodySm, lineHeight: 20, marginTop: space.md }}>{review.kindReason}</T>

      <View style={{ marginTop: space.md, gap: space.sm }}>
        <View style={{ backgroundColor: t.surfaceMuted, borderRadius: radius.md, padding: space.md }}>
          <T variant="label" style={{ textTransform: "uppercase", letterSpacing: 0.4 }}>What it is usually for</T>
          <T style={{ fontSize: typeScale.bodySm, lineHeight: 20, marginTop: 4 }}>{review.businessUse}</T>
        </View>
        <View style={{ backgroundColor: t.surfaceMuted, borderRadius: radius.md, padding: space.md }}>
          <T variant="label" style={{ textTransform: "uppercase", letterSpacing: 0.4 }}>What it costs to keep</T>
          <T style={{ fontSize: typeScale.bodySm, lineHeight: 20, marginTop: 4 }}>
            {review.ongoingCosts ?? "Nothing ongoing that FinSight can name from this description."}
          </T>
        </View>
      </View>

      {/*
        What to CHECK about the amount — never what the amount should be. The
        server refuses any answer that names a figure or calls the price fair,
        cheap or steep: FinSight has no price feed, and the price context
        panel below is the honest answer to "is this normal for me".
      */}
      {review.priceCheck ? (
        <View style={{ marginTop: space.sm, backgroundColor: t.brandSurface, borderRadius: radius.md, padding: space.md }}>
          <T variant="label" style={{ color: t.brandText, textTransform: "uppercase", letterSpacing: 0.4 }}>
            What to check about the price
          </T>
          <T style={{ fontSize: typeScale.bodySm, lineHeight: 20, marginTop: 4 }}>{review.priceCheck}</T>
        </View>
      ) : null}

      {price ? (
        <View style={{ marginTop: space.md }}>
          <PriceContextPanel price={price} plannedAmount={plannedAmount} nested />
        </View>
      ) : null}

      <View style={{ marginTop: space.md }}>
        <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>
          Before you decide, answer these yourself
        </T>
        <View style={{ marginTop: space.sm, gap: 6 }}>
          {review.questions.map((question) => (
            <View key={question} style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.brand[500], marginTop: 7 }} />
              <T style={{ flex: 1, fontSize: typeScale.bodySm, lineHeight: 20 }}>{question}</T>
            </View>
          ))}
        </View>
      </View>

      {stale ? (
        <Pressable
          onPress={onRefresh}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshing ? "Looking at this item again" : "Item changed. Look at it again."}
          accessibilityState={{ disabled: refreshing, busy: refreshing }}
          style={({ pressed }) => ({
            marginTop: space.md,
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            // Was 36; same case as the stale banner above — alone on its line,
            // so the height is raised rather than slopped.
            minHeight: TAP_FLOOR,
            paddingHorizontal: space.md,
            borderRadius: radius.full,
            backgroundColor: t.surfaceMuted,
            opacity: refreshing ? 0.6 : pressed ? 0.85 : 1,
          })}
        >
          <Ionicons name="refresh" size={14} color={t.textSecondary} />
          <T style={{ fontSize: typeScale.caption, color: t.textSecondary, fontFamily: font.sansSemibold }}>
            {refreshing ? "Looking…" : "Item changed — look again"}
          </T>
        </Pressable>
      ) : null}

      <T variant="caption" style={{ marginTop: space.md, lineHeight: 17 }}>
        FinSight describes and asks. Whether to buy this is your call — it does not know your suppliers, your season,
        or what broke last week.
      </T>
    </Card>
  );
}

