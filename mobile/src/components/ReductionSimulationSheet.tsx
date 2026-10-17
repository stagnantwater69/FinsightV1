import { useEffect, useRef, useState } from "react";
import { periodLabel, periodParams, type PeriodSelection } from "../lib/reportingPeriod";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, ErrorNote, SegmentedControl, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";
import { api, errorMessage } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useReducedMotion } from "../lib/useReducedMotion";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { parseSimNumber, percentValidationError, simAmountValidationError } from "../lib/reductionSimulationForm";
import type { ReductionOpportunity, ReductionSimulation, ReductionSpec } from "../lib/types";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";

/**
 * "Simulate reduction" — Expense Reduction Opportunities plan §12, Phase 4.
 *
 * A modal launched from a reduction-opportunity card, scoped to that card's
 * category. It answers one question — "if this category's expenses were
 * lower by an owner-chosen amount or percentage, what would the category and
 * total recorded expenses look like?" — and nothing it shows is saved,
 * predictive, or a verdict: see plan §4.2 and §12.1.
 *
 * NEVER SHOWS THE BUSINESS'S AVAILABLE FUNDS FIGURE. The endpoint this calls
 * (`POST /insights/reduction-simulation`) never touches it — see
 * `simulateReductionOpportunity` in
 * backend/src/services/reductionOpportunity.service.ts — and implying
 * otherwise here would misrepresent what was actually calculated.
 *
 * Built as a plain centred `Modal` rather than AskFinSight's animated
 * bottom sheet: that sheet's drag-to-dismiss and slide animation exist for a
 * scrolling conversation the owner returns to repeatedly, which this is not
 * — a single form-and-result surface that opens, answers one question, and
 * closes. `ConfirmSheet` in ui.tsx is the nearer relative in spirit (a
 * transparent `Modal` with a backdrop that swallows touches) but its layout
 * is a title/body/two-buttons shape with no room for a form and a result
 * panel, so this is its own file rather than a forced fit.
 */

const KIND_OPTIONS = [
  { label: "Percent", value: "percent" as const },
  { label: "Peso amount", value: "amount" as const },
];

export function ReductionSimulationSheet({
  visible,
  opportunity,
  businessProfileId,
  period,
  onClose,
}: {
  visible: boolean;
  /** The opportunity this simulation is scoped to. Null closes the sheet content, not just hides it — see the reset effect below. */
  opportunity: ReductionOpportunity | null;
  businessProfileId: number;
  /**
   * The SAME period the reduction-opportunities list was fetched for, so the
   * category baseline this simulates against matches the evidence figure on
   * the card the owner tapped from.
   */
  period: PeriodSelection;
  onClose: () => void;
}) {
  const t = useTheme();
  const { brand, ink, statusText } = t;
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  const [kind, setKind] = useState<"percent" | "amount">("percent");
  const [rawValue, setRawValue] = useState("");
  const [valueError, setValueError] = useState<string | null>(null);
  const [valueFocused, setValueFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ReductionSimulation | null>(null);
  const seq = useRef(0);

  /*
   * Every field resets on a NEW opportunity — not just on close — because
   * the modal is intentionally kept mounted by its caller (visible toggles,
   * the component does not) and a stale percentage from the last card would
   * otherwise carry over onto a category it was never entered for.
   */
  const opportunityId = opportunity?.id ?? null;
  useEffect(() => {
    seq.current += 1;
    setKind("percent");
    setRawValue("");
    setValueError(null);
    setSubmitting(false);
    setSubmitError(null);
    setResult(null);
  }, [opportunityId]);

  if (!opportunity) return null;
  // Captured into a local const so TypeScript's narrowing survives into the
  // `submit` closure below — a destructured prop is not narrowed there on
  // its own.
  const opp = opportunity;

  /*
   * The current-period category total already sitting on the card that
   * opened this sheet. A COURTESY figure for the inline max-amount check —
   * not resent as an authoritative baseline (the request never carries it;
   * the server derives its own from the owner's records) and not trusted
   * over the server's own 400 if the two have drifted apart since the card
   * was fetched.
   */
  const evidenceBaseline = opp.evidence.currentAmount;

  function currentError(): string | null {
    return kind === "percent" ? percentValidationError(rawValue) : simAmountValidationError(rawValue, evidenceBaseline);
  }

  async function submit() {
    if (submitting) return;
    const invalid = currentError();
    if (invalid) {
      setValueError(invalid);
      haptics.failed();
      return;
    }
    setValueError(null);
    const value = parseSimNumber(rawValue)!;
    const reduction: ReductionSpec = kind === "percent" ? { kind: "percent", value } : { kind: "amount", value };

    const mySeq = (seq.current += 1);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: Record<string, unknown> = {
        businessProfileId,
        categoryId: opp.categoryId,
        ...periodParams(period),
        reduction,
      };
      const response = await api.post<ReductionSimulation>("/insights/reduction-simulation", body);
      if (seq.current !== mySeq) return;
      setResult(response);
    } catch (err) {
      if (seq.current !== mySeq) return;
      setSubmitError(errorMessage(err));
      setResult(null);
    } finally {
      if (seq.current === mySeq) setSubmitting(false);
    }
  }

  function close() {
    haptics.tapped();
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? "none" : "slide"} statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.scrim, justifyContent: "flex-end" }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      />
        <View
          style={{
            backgroundColor: t.surfaceRaised,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            maxHeight: "92%",
            flexShrink: 1,
          }}
          accessibilityViewIsModal
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              justifyContent: "space-between",
              paddingHorizontal: space.lg,
              paddingTop: space.lg,
              paddingBottom: space.sm,
            }}
          >
            <View style={{ flex: 1 }}>
              <T variant="heading" accessibilityRole="header" style={{ color: t.brandHeading }}>
                Simulate a reduction
              </T>
              <T variant="caption" style={{ marginTop: 2 }}>
                {opportunity.categoryName}
              </T>
            </View>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close simulate reduction"
              hitSlop={10}
              style={{ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="close" size={20} color={ink[500]} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{
              paddingHorizontal: space.lg,
              paddingBottom: insets.bottom + space.lg,
              gap: space.md,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <View style={{ gap: space.xs, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <T style={{ color: t.textSecondary }}>{opportunity.categoryName} · {periodLabel(period)}</T>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.titleLg, lineHeight: 32, fontVariant: ["tabular-nums"] }}>{formatMoney(evidenceBaseline, { decimals: true })}</T>
              <T variant="caption">Recorded category expenses</T>
            </View>
            <T style={{ color: t.textSecondary }}>Try a lower expense amount. This is a hypothetical check; your records stay unchanged.</T>

            <View>
              <T variant="label" style={{ marginBottom: 6 }}>
                Reduce by
              </T>
              <SegmentedControl
                options={KIND_OPTIONS}
                value={kind}
                onChange={(v) => {
                  setKind(v);
                  setValueError(null);
                }}
                accessibilityLabel="Reduce by"
              />
            </View>

            <View>
              <T variant="label" style={{ marginBottom: 4 }}>
                {kind === "percent" ? "Percentage" : "Amount (PHP)"}
              </T>
              <TextInput
                value={rawValue}
                onChangeText={(v) => {
                  setRawValue(v);
                  if (valueError) setValueError(null);
                }}
                onFocus={() => setValueFocused(true)}
                onBlur={() => setValueFocused(false)}
                onSubmitEditing={submit}
                keyboardType="decimal-pad"
                placeholder={kind === "percent" ? "e.g. 15" : "e.g. 1000"}
                placeholderTextColor={ink[400]}
                accessibilityLabel={kind === "percent" ? "Reduction percentage" : "Reduction amount, in Philippine pesos"}
                style={{
                  minHeight: TAP_FLOOR,
                  borderWidth: 1,
                  borderColor: valueError ? statusText.critical : valueFocused ? brand[600] : ink[200],
                  borderRadius: radius.md,
                  paddingHorizontal: space.md,
                  fontSize: typeScale.title, lineHeight: 28,
                  fontFamily: font.sans,
                  fontVariant: ["tabular-nums"],
                  color: ink[900],
                }}
              />
              {kind === "amount" && evidenceBaseline > 0 ? (
                <T variant="caption" style={{ marginTop: 4 }}>
                  Maximum reduction: {formatMoney(evidenceBaseline, { decimals: true })}.
                </T>
              ) : null}
              {valueError ? (
                <View
                  accessibilityLiveRegion="polite"
                  style={{ flexDirection: "row", gap: 5, marginTop: space.sm, alignItems: "flex-start" }}
                >
                  <Ionicons name="alert-circle-outline" size={18} color={statusText.critical} />
                  <T style={{ flex: 1, fontSize: typeScale.caption, lineHeight: 17, color: statusText.critical }}>
                    {valueError}
                  </T>
                </View>
              ) : null}
            </View>

            <Button title={submitting ? "Simulating…" : "Simulate"} onPress={submit} disabled={submitting} loading={submitting} />

            {submitError ? <ErrorNote>{submitError}</ErrorNote> : null}

            {result ? <ReductionSimulationResult result={result} periodText={periodLabel(period)} /> : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * The answer — labelled as hypothetical throughout, per plan §4.2's "review,
 * not verdict" language rules. Category expenses first, then total expenses,
 * because the category is what the owner just chose to simulate and the
 * total is the wider context it sits inside.
 */
function ReductionSimulationResult({ result, periodText }: { result: ReductionSimulation; periodText: string }) {
  const t = useTheme();
  const [showAssumptions, setShowAssumptions] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.lg, gap: space.lg }}>
      <View accessibilityLiveRegion="polite" style={{ gap: space.xs }}>
        <T accessibilityRole="header" style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>Hypothetical result</T>
        <T style={{ color: t.statusText.good, fontSize: typeScale.titleLg, lineHeight: 32, fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{formatMoney(result.hypotheticalReduction, { decimals: true })} lower</T>
        <T variant="caption">{result.requestedReductionPercent}% of this category's period total. Nothing was changed or saved.</T>
      </View>
      <BeforeAfterRow label={`${result.categoryName} (${periodText})`} before={result.categoryExpenses.before} after={result.categoryExpenses.after} />
      <BeforeAfterRow label="Total recorded expenses" before={result.totalExpenses.before} after={result.totalExpenses.after} />
      {result.assumptions.length > 0 ? (
        <View>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAssumptions }} accessibilityLabel="Simulation assumptions" onPress={() => setShowAssumptions(!showAssumptions)} style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
            <T style={{ color: t.brand[700], flex: 1 }}>{showAssumptions ? "Hide assumptions" : "View assumptions"}</T>
            <Ionicons name={showAssumptions ? "chevron-up" : "chevron-down"} size={18} color={t.brand[700]} />
          </Pressable>
          {showAssumptions ? <View style={{ gap: space.sm }}>{result.assumptions.map((assumption, index) => <T key={index} style={{ color: t.textSecondary }}>{assumption}</T>)}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

function BeforeAfterRow({ label, before, after }: { label: string; before: number; after: number }) {
  const t = useTheme();
  const maximum = Math.max(before, after);
  const comparisonData: ChartDatum[] = [{ key: label, label, values: [{ label: "Before", value: before, color: t.textMuted }, { label: "After (hypothetical)", value: after, color: t.brandFill }], note: "Hypothetical reduction. Nothing has been saved or changed in your records." }];
  const comparisonSelection = useChartSelection(comparisonData);
  return (
    <View style={{ gap: space.sm }}>
      <T style={{ fontFamily: font.sansSemibold }}>{label}</T>
      {[
        { label: "Before", amount: before, color: t.textMuted },
        { label: "After (hypothetical)", amount: after, color: t.brand[600] },
      ].map((row) => (
        <View key={row.label} style={{ gap: space.xs }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}>
            <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>{row.label}</T>
            <T style={{ fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{formatMoney(row.amount, { decimals: true })}</T>
          </View>
          <ChartPlotPressArea selection={comparisonSelection} count={1} chartLabel={`${label} reduction simulation`}>
          <View accessible={false} style={{ height: 8, backgroundColor: t.surfaceMuted }}>
            <View style={{ height: 8, width: `${maximum > 0 ? Math.max(0, row.amount / maximum * 100) : 0}%`, backgroundColor: row.color }} />
          </View>
          </ChartPlotPressArea>
        </View>
      ))}
      <ChartValueReadout data={comparisonData} selection={comparisonSelection} chartLabel={`${label} reduction simulation`} />
    </View>
  );
}
