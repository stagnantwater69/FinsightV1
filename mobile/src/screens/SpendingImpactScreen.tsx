import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Alert as AlertBanner,
  Button,
  Callout,
  Card,
  CategorySelect,
  Disclosure,
  ErrorNote,
  Field,
  Money,
  Screen,
  SegmentedControl,
  SelectChip,
  T,
} from "../components/ui";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { InsightHeader } from "../components/InsightsShared";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useAiChat } from "../context/AiChatContext";
import { api, errorMessage } from "../lib/api";
import * as haptics from "../lib/haptics";
import { formatMoney } from "../lib/money";
import { useDebounced } from "../lib/useDebounced";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import {
  BAND_TONE,
  DEFAULT_PERIOD_DAYS,
  IMPACT_STALE_COPY,
  MAX_ITEM_LENGTH,
  PERIOD_OPTIONS,
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
  periodPhrase,
  quickAmountValue,
  resetScenario,
  scenarioQuestion,
  type PeriodDays,
} from "../lib/spendingImpactForm";
import type {
  CategorySuggestion,
  PurchaseKind,
  PurchasePriceContext,
  PurchaseReview,
  SpendingImpact,
} from "../lib/types";

// ---------------------------------------------------------------- Spending impact

export function SpendingImpactScreen({ navigation }: any) {
  const t = useTheme();
  const { ACCENT, brand, ink, paper, statusText } = t;
  const { selected, categories } = useBusinessProfiles();

  // ---- the base calculation ----
  const [amount, setAmount] = useState("");
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
   * The window the recorded-expenses half is compared against.
   *
   * The endpoint has always accepted this and the app has always sent 30. It
   * is part of the SCENARIO, not a display option: the server counts a
   * different set of records for each one, so a card computed for seven days
   * does not describe a screen set to thirty (see `impactStaleReason`).
   */
  const [periodDays, setPeriodDays] = useState<PeriodDays>(DEFAULT_PERIOD_DAYS);

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
        periodDays,
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
  }, [periodDays]);

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
      ? "warning"
      : bandTone === "warning"
        ? "alert-circle"
        : "checkmark-circle";

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
   * `data.periodDays`; either may since have moved. Same treatment as the
   * review card above, because the dishonesty is the same and this half is
   * the half owners trust — and the banner names WHICH one moved, because
   * "Amount changed" over a card that went stale on a period switch is itself
   * a false statement.
   */
  const staleReason = impactStaleReason(
    { amount: data?.plannedAmount ?? null, periodDays: data?.periodDays ?? null },
    { amount: currentAmount, periodDays },
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
  const evidenceNote = data ? periodEvidenceNote(evidence, data.periodDays) : null;

  /** The prepared question — shown to the owner, never sent for them. */
  const preparedQuestion = data
    ? scenarioQuestion({
        amount: data.plannedAmount,
        item: reviewedItem ?? itemDescription,
        periodDays: data.periodDays,
        band: data.impactBand,
      })
    : null;

  function resetAll() {
    haptics.tapped();
    // Both in-flight halves are voided as well as the visible ones: an answer
    // to the scenario just cleared has nothing to describe, and landing after
    // the reset it would look like an answer to the blank form.
    checkSeq.current += 1;
    reviewSeq.current += 1;
    suggestSeq.current += 1;
    const fresh = resetScenario(periodDays);
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
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="SpendingImpact" title="Spending impact" />

        <View style={{ marginBottom: space.lg }}>
          <Callout tone="info">
            A what-if check — nothing is saved, and FinSight won't tell you whether to buy it.
          </Callout>
        </View>

        <Card style={{ marginBottom: space.lg }}>
          <T variant="label" style={{ marginBottom: 4 }}>Planned amount (PHP)</T>
          <View style={{ flexDirection: "row", gap: space.sm }}>
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
              placeholder="e.g. 11000"
              placeholderTextColor={ink[400]}
              accessibilityLabel="Planned amount, in Philippine pesos"
              style={{
                flex: 1,
                // The floor, not the 44-point iOS token: the shared Field this
                // input is standing in for is laid out to TAP_FLOOR, and a
                // hand-rolled input beside it should not be four points shorter
                // on the platform most owners are on.
                minHeight: TAP_FLOOR,
                // Width held at 1 on both states so the row does not reflow
                // and shove the Check button sideways when focus lands.
                borderWidth: 1,
                borderColor: amountError ? statusText.critical : amountFocused ? brand[600] : ink[200],
                borderRadius: radius.md,
                paddingHorizontal: space.md,
                fontSize: typeScale.body,
                color: ink[900],
              }}
            />
            <Pressable
              onPress={run}
              disabled={checking}
              accessibilityRole="button"
              // "Check" alone says nothing about what is being checked once
              // the amount field beside it is out of view, which is exactly
              // the situation of anyone reading this one control at a time.
              accessibilityLabel={checking ? "Checking this planned amount" : "Check this planned amount"}
              accessibilityState={{ disabled: checking, busy: checking }}
              style={{
                minHeight: TAP_FLOOR,
                minWidth: 84,
                paddingHorizontal: space.lg,
                borderRadius: radius.md,
                backgroundColor: ACCENT.fill,
                alignItems: "center",
                justifyContent: "center",
                opacity: checking ? 0.7 : 1,
              }}
            >
              {checking ? (
                <ActivityIndicator color={ACCENT.onFill} />
              ) : (
                <T style={{ color: ACCENT.onFill, fontFamily: font.sansSemibold }}>Check</T>
              )}
            </Pressable>
          </View>
          {/*
            "Updating…" lives HERE, beside the field, rather than in the
            result card's header where it started. In the header it only ever
            existed inside the `data ?` branch, so the very FIRST check — the
            one with the longest wait and nothing on screen yet — announced
            nothing at all beyond the button's own busy state.
          */}
          {checking ? (
            <View
              accessibilityLiveRegion="polite"
              accessibilityLabel="Updating the estimate"
              style={{ marginTop: space.sm }}
            >
              <T variant="caption" style={{ color: t.brandText, fontFamily: font.sansSemibold }}>
                Updating…
              </T>
            </View>
          ) : null}
          {amountError ? (
            <View
              accessibilityLiveRegion="polite"
              style={{ flexDirection: "row", gap: 5, marginTop: space.sm, alignItems: "flex-start" }}
            >
              <T style={{ fontSize: typeScale.micro, color: statusText.critical }}>⚠</T>
              <T style={{ flex: 1, fontSize: typeScale.caption, lineHeight: 17, color: statusText.critical }}>
                {amountError}
              </T>
            </View>
          ) : null}
          {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}

          {/*
            Presets, not a slider.
            Web pairs these with a range input; on a phone a range tuned to
            ₱500 steps across six figures is tens of pesos per pixel, which is
            neither precise with a thumb nor operable with a screen reader.
            These are the accessible half of that pair, so the app ships that
            half — see QUICK_AMOUNTS for the full argument.
          */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: space.sm,
              marginTop: space.md,
            }}
          >
            <T variant="caption">Try:</T>
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
          </View>

          {/*
            The comparison window. It is part of the scenario rather than a
            view option — the server counts a different set of records for
            each one — so changing it re-asks the question (see the effect on
            `periodDays`) instead of quietly relabelling the old answer.
          */}
          <View style={{ marginTop: space.lg }}>
            <T variant="label" style={{ marginBottom: 6 }}>Compare against</T>
            <SegmentedControl
              options={PERIOD_OPTIONS.map((option) => ({ label: option.label, value: option.days }))}
              value={periodDays}
              onChange={(days) => setPeriodDays(days as PeriodDays)}
              accessibilityLabel="Comparison period for recorded expenses"
            />
            <T variant="caption" style={{ marginTop: 6 }}>
              Recorded expenses are compared against {periodPhrase(periodDays)}. Your available funds do not change
              with this.
            </T>
          </View>
        </Card>

        <Card style={{ marginBottom: space.lg }}>
          <Field
            label="What are you planning to buy? (optional)"
            value={itemDescription}
            onChangeText={setItemDescription}
            placeholder="e.g. Display fridge"
            returnKeyType="done"
            // The server's own ceiling. Stopping at 255 here is the difference
            // between a key that does nothing and a 400 carrying a Zod message
            // in place of FinSight's own words.
            maxLength={MAX_ITEM_LENGTH}
          />
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, marginTop: -space.sm }}>
            <Pressable
              onPress={fetchReview}
              disabled={!reviewReady || reviewing}
              accessibilityRole="button"
              accessibilityLabel={
                reviewing
                  ? "Looking at this item"
                  : review
                    ? "Look at this item again"
                    : "What am I buying? Ask FinSight to describe this item."
              }
              accessibilityState={{ disabled: !reviewReady || reviewing, busy: reviewing }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                // Was 38. This sits in a wrapping row beside other controls
                // with an 8-point gap, so a hitSlop would reach into its
                // neighbour and make which one you hit a question of stacking
                // order — the same reason the shared chip is laid out to the
                // floor rather than slopped.
                minHeight: TAP_FLOOR,
                paddingHorizontal: space.md,
                borderRadius: radius.full,
                backgroundColor: t.brandFill,
                opacity: !reviewReady || reviewing ? 0.5 : pressed ? 0.85 : 1,
              })}
            >
              {reviewing ? (
                <ActivityIndicator color={t.onBrandFill} size="small" />
              ) : (
                <Ionicons name="sparkles-outline" size={15} color={t.onBrandFill} />
              )}
              <T style={{ fontSize: typeScale.caption, color: t.onBrandFill, fontFamily: font.sansSemibold }}>
                {reviewing ? "Looking…" : review ? "Look at this item again" : "What am I buying?"}
              </T>
            </Pressable>
            <T variant="caption" style={{ flexShrink: 1 }}>
              {!reviewReady
                ? "Name the item above and FinSight will describe it."
                : "FinSight describes the item — it won't tell you whether to buy it."}
            </T>
          </View>

          {/*
            SECONDARY, so it is closed by default — the category changes which
            of the owner's own records the price half is counted from, and
            nothing else. The summary line carries the current value so the
            common case (a guess that is right, or no category at all) never
            costs a tap.
          */}
          <View style={{ marginTop: space.md, borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.xs }}>
            <Disclosure
              title="Reference category"
              summary={
                suggesting
                  ? "Suggesting…"
                  : categoryName
                    ? suggestionStale
                      ? `${categoryName} — suggested for earlier wording`
                      : `${categoryName}${suggestedFor && !categoryTouched ? " (suggested)" : ""}`
                    : "No category — compare everything"
              }
            >
              <View style={{ gap: space.sm, paddingTop: space.xs }}>
                <CategorySelect
                  options={categoryOptions}
                  value={categoryId ?? NO_CATEGORY_ID}
                  onChange={(id) => {
                    // Touching it ends the guessing for this scenario. A
                    // suggestion that keeps overwriting a deliberate choice is
                    // not a suggestion.
                    setCategoryTouched(true);
                    setCategoryId(id === NO_CATEGORY_ID ? null : id);
                  }}
                  accessibilityContext="comparing this purchase"
                  sheetTitle="Compare against which category?"
                  placeholder="No category — compare everything"
                />
                {/*
                  SAYS WHAT IT DOES NOT DO. A category picker on a screen full
                  of the owner's own figures looks like filing, and filing is
                  the one thing this cannot do: no record is created, no saved
                  record moves, and nothing here is written down at all.
                */}
                <T variant="caption" style={{ lineHeight: 17 }}>
                  Only used to choose which of your own past records this purchase is compared against. It does not
                  file anything and does not change any record you have saved.
                </T>
                {suggesting ? (
                  <T variant="caption" accessibilityLiveRegion="polite" style={{ color: t.brandText }}>
                    Suggesting a category…
                  </T>
                ) : null}
                {suggestFailed && !suggesting ? (
                  <T variant="caption">FinSight couldn't suggest one just now — choose a category yourself if you want one.</T>
                ) : null}
                {suggestionStale && categoryName ? (
                  <T variant="caption">
                    Suggested for "{suggestedFor}" — check it still fits what you typed.
                  </T>
                ) : null}
              </View>
            </Disclosure>
          </View>

          <View style={{ marginTop: space.sm, alignSelf: "flex-start" }}>
            <Button title="Start a fresh scenario" variant="ghost" onPress={resetAll} />
          </View>
        </Card>

        {data ? (
          <Card style={{ marginBottom: space.lg }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: space.md, gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="heading" accessibilityRole="header">Estimated impact</T>
                {/*
                  NAMES THE AMOUNT THESE FIGURES ARE ABOUT. Without it the
                  card was a set of numbers with nothing tying them to the
                  input they came from — which is exactly how "High Impact"
                  for ₱11,000 went on being read as an answer about the ₱200
                  now in the field.
                */}
                <T variant="caption" style={{ marginTop: 2 }}>
                  For a planned <Money value={data.plannedAmount} bare size={typeScale.caption} weight="medium" />
                  {" "}against {periodPhrase(data.periodDays)}
                </T>
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  backgroundColor: bandSurface,
                  borderRadius: radius.full,
                  paddingHorizontal: space.md,
                  paddingVertical: 4,
                }}
              >
                {/*
                  The glyph is hidden from the reader, not because it is
                  decorative but because the words beside it say the same
                  thing — it exists for the eye that cannot use the tint.
                */}
                <Ionicons name={bandIcon} size={13} color={bandColor} accessibilityElementsHidden importantForAccessibility="no" />
                <T style={{ color: bandColor, fontSize: typeScale.caption }}>{data.impactBand}</T>
              </View>
            </View>

            {/*
              The scenario has moved on since these were computed. Said out
              loud, and rechecking is one tap — the same treatment, and the
              same reasoning, as the review card's "Item changed" refresh.
            */}
            {staleReason ? (
              <Pressable
                onPress={run}
                disabled={checking}
                accessibilityRole="button"
                accessibilityLabel={
                  checking
                    ? "Rechecking this scenario"
                    : `${IMPACT_STALE_COPY[staleReason]}. These figures describe the previous scenario.`
                }
                accessibilityState={{ disabled: checking, busy: checking }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  alignSelf: "flex-start",
                  // Was 36. Nothing sits beside it — it is `flex-start` on its
                  // own line with a margin under it — so there is no dense
                  // layout to protect and it simply gets the real height.
                  minHeight: TAP_FLOOR,
                  paddingHorizontal: space.md,
                  borderRadius: radius.md,
                  backgroundColor: t.statusSurface.warning,
                  marginBottom: space.md,
                  opacity: checking ? 0.6 : pressed ? 0.85 : 1,
                })}
              >
                <Ionicons name="refresh" size={14} color={statusText.warning} />
                <T style={{ fontSize: typeScale.caption, color: statusText.warning, fontFamily: font.sansSemibold }}>
                  {checking ? "Checking…" : IMPACT_STALE_COPY[staleReason]}
                </T>
              </Pressable>
            ) : null}

            {/*
              THE HEADLINE, ABOVE THE FOLD. What is left afterwards is the one
              figure an owner came here for; everything under it explains how
              this got there. It was previously three cards down inside a
              before/after pair, which on a 360dp screen meant scrolling past
              two bars to reach the answer.
            */}
            <T variant="caption">After this spending, you may have</T>
            <Money
              value={data.funds.after}
              size={typeScale.titleLg}
              weight="semibold"
              color={data.funds.after < 0 ? statusText.critical : ink[900]}
              style={{ marginTop: 2 }}
            />

            <ImpactGauge data={data} />

            {/* A warning is never collapsed, and never below the detail. */}
            {data.exceedsFunds ? (
              <View style={{ marginTop: space.md }}>
                <AlertBanner kind="needs-review" label="Exceeds your funds">
                  This is more than the available business funds you have on record.
                </AlertBanner>
              </View>
            ) : null}

            {/*
              SECONDARY: the two before/after bars and the threshold sentence.
              They are the working, not the answer — closed by default so the
              answer, the gauge and any warning fit one small-phone viewport,
              and one tap away for anyone who wants to see the movement.
            */}
            <View style={{ marginTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
              <Disclosure
                title="Before and after, in detail"
                summary="Funds and recorded expenses, before and after"
              >
                <View style={{ paddingTop: space.sm }}>
                  <BeforeAfter label="Available business funds" before={data.funds.before} after={data.funds.after} />
                  <BeforeAfter
                    label={`Recorded expenses (last ${data.periodDays} ${data.periodDays === 1 ? "day" : "days"})`}
                    before={data.periodExpenses.before}
                    after={data.periodExpenses.after}
                  />
                  <T variant="caption">
                    That uses {percentOfFundsText(data.percentOfFunds)} of your available funds. You treat anything
                    above {data.thresholdPercent}% as high impact.
                  </T>
                </View>
              </Disclosure>
            </View>
          </Card>
        ) : (
          <Card style={{ marginBottom: space.lg }}>
            {/*
              A real illustration rather than EmptyState's text glyph. This is
              the whole screen until an amount is typed, and "◎" rendered at
              whatever weight the system font happened to give it — the one
              place the app asks someone to start, drawn in a character that
              varies by device.
            */}
            <View style={{ alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
              <View
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  backgroundColor: brand[50],
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: space.lg,
                }}
              >
                <Ionicons name="locate-outline" size={44} color={brand[600]} />
              </View>
              <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>
                Enter an amount to check
              </T>
              <T variant="caption" style={{ textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 260 }}>
                See what a planned purchase would do to your funds before you spend it.
              </T>
            </View>
          </Card>
        )}

        {/*
          WHOSE FUNDS THESE ARE, AND WHERE THEY CAME FROM.
          The estimate is arithmetic over one figure the owner typed into a
          business profile, possibly months ago, and every number above it is
          only as current as that. Naming the business also matters on a phone
          holding several: the active one is chosen elsewhere and nothing on
          this screen said which scenario belonged to whom.
        */}
        <Card style={{ marginBottom: space.lg }}>
          <T variant="heading" accessibilityRole="header">What this is based on</T>
          <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 6, marginTop: space.sm }}>
            <T style={{ fontSize: typeScale.bodySm }}>{selected.name}'s recorded available funds:</T>
            <Money value={selected.availableFunds} size={typeScale.bodySm} weight="semibold" />
          </View>
          <T variant="caption" style={{ marginTop: 4, lineHeight: 17 }}>
            Counted from your business profile, not from AI. If that figure is out of date, everything above it is
            too.
          </T>

          {/*
            Thin evidence, explained rather than left to look like a result.
            "Recorded expenses PHP 0 → PHP 11,000" is arithmetic over an empty
            window and looks exactly like arithmetic over a full one.
          */}
          {evidenceNote ? (
            <View style={{ marginTop: space.md }}>
              <Callout tone="warn">{evidenceNote}</Callout>
            </View>
          ) : null}

          <View style={{ marginTop: space.md, alignSelf: "flex-start" }}>
            <Button
              title="Update your recorded funds"
              variant="secondary"
              onPress={() => {
                haptics.tapped();
                navigation.navigate("More", { screen: "BusinessProfileForm", params: { profile: selected } });
              }}
            />
          </View>
        </Card>

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

        {/*
          THE NEXT ACTION, AND THE OWNER'S TO TAKE.
          The question is written out in full BEFORE anything is sent, because
          a button that quietly composes a sentence in someone's name and fires
          it at a model is not a shortcut, it is words put in their mouth. This
          only fills the composer; the send button is theirs.
        */}
        {preparedQuestion ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="heading" accessibilityRole="header">Talk this through</T>
            <T variant="caption" style={{ marginTop: 2 }}>
              FinSight will open with this question ready. Nothing is sent until you send it.
            </T>
            <View
              style={{
                marginTop: space.md,
                backgroundColor: t.surfaceMuted,
                borderRadius: radius.md,
                padding: space.md,
              }}
            >
              <T style={{ fontSize: typeScale.bodySm, lineHeight: 20 }}>"{preparedQuestion}"</T>
            </View>
            <View style={{ marginTop: space.md }}>
              <Button title="Open this question in Ask FinSight" variant="brand" onPress={askAboutScenario} />
            </View>
            <T variant="caption" style={{ marginTop: space.sm, lineHeight: 17 }}>
              You can edit or delete it before sending.
            </T>
          </Card>
        ) : null}
      </ScrollView>

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
function ImpactGauge({ data }: { data: SpendingImpact }) {
  const t = useTheme();
  const geometry = gaugeGeometry(data.percentOfFunds, data.thresholdPercent);
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
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.sm }}>
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
                  <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.bodySm }}>
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
        </>
      )}
    </Frame>
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
          <Ionicons name={PURCHASE_KIND_ICON[review.kind]} size={19} color={t.brandText} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="heading" accessibilityRole="header" numberOfLines={2}>About {item}</T>
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

/**
 * One figure before a planned purchase and after it.
 *
 * ONE BAR, NOT TWO. It was drawn as two stacked bars, one per state, which
 * made the reader compare two lengths in two places to answer a question
 * about a single quantity moving.
 *
 * WHAT THE BAR ENCODES: the solid part is the SMALLER of the two figures and
 * the tinted remainder is the change between them. That one rule reads
 * correctly in both directions without the caller having to say which way is
 * good — funds fall, so the solid part is what would be left and the
 * remainder is what the purchase eats; expenses rise, so the solid part is
 * what is already spent and the remainder is what would be added. Either
 * way, the light section is the purchase.
 *
 * The fill stays the brand colour rather than tracking the impact band. The
 * band already has a pill of its own, and colouring the "what remains"
 * section by severity would say the remaining funds were themselves alarming.
 * Only the REMAINDER turns red, and only when the purchase cannot be covered.
 */
/** Height of the before/after bar; its corner radius is derived from this. */
const BAR_HEIGHT = 10;

function BeforeAfter({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  const t = useTheme();
  const { brand, ink, paper, statusText } = t;
  /*
   * Overspending is the case this has to get right. A negative `after` means
   * the purchase consumed everything and more, so the solid part is what
   * existed and the whole remainder is red — there is no such thing as a
   * negative length, and clamping to zero would draw "nothing left"
   * identically to "exactly nothing left".
   */
  const overspent = after < 0;
  const span = overspent ? before + Math.abs(after) : Math.max(Math.abs(before), Math.abs(after), 1);
  const solid = overspent ? before : Math.min(Math.abs(before), Math.abs(after));
  const ratio = Math.max(0, Math.min(solid / span, 1));

  return (
    <View style={{ marginBottom: space.lg }}>
      <T variant="label" style={{ color: ink[700], marginBottom: space.sm }}>
        {label}
      </T>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: space.sm }}>
        <View>
          <T variant="caption">Before</T>
          <Money value={before} size={14} weight="medium" style={{ marginTop: 1 }} />
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T variant="caption">After</T>
          <Money
            value={after}
            size={14}
            weight="semibold"
            color={overspent ? statusText.critical : ink[900]}
            style={{ marginTop: 1 }}
          />
        </View>
      </View>
      <View
        // See the gauge above: the role and value are only surfaced if the
        // view is an accessibility element in its own right.
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        style={{
          height: BAR_HEIGHT,
          // The track IS the change: soft brand normally, alarm red when the
          // purchase runs past what there is.
          backgroundColor: overspent ? t.statusSurface.critical : brand[100],
          // Radius from the height, matching RecoveryMeter's own Bar. A bar
          // is not a chip, and `radius.full` on a brand-filled pill is the
          // marker chipConsistency looks for.
          borderRadius: BAR_HEIGHT / 2,
          overflow: "hidden",
          marginTop: space.sm,
          flexDirection: "row",
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            borderRadius: BAR_HEIGHT / 2,
            backgroundColor: brand[600],
          }}
        />
        {/*
          A hairline at the boundary. Where the two tints are close in value
          the join is hard to place exactly, and this is a chart whose whole
          point is where that join falls.
        */}
        {ratio > 0.02 && ratio < 0.98 ? (
          <View style={{ width: 1.5, height: "100%", backgroundColor: paper.DEFAULT, opacity: 0.9 }} />
        ) : null}
      </View>
    </View>
  );
}
