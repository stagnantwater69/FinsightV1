import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Button, ErrorNote, Money, SegmentedControl, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";
import { api, errorMessage } from "../lib/api";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { parseSimNumber, percentValidationError, simAmountValidationError } from "../lib/reductionSimulationForm";
import type { ReductionOpportunity, ReductionSimulation, ReductionSpec } from "../lib/types";

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
  periodDays,
  endDate,
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
  periodDays: number;
  endDate: string | null;
  onClose: () => void;
}) {
  const t = useTheme();
  const { brand, ink, statusText } = t;
  const insets = useSafeAreaInsets();

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
        periodDays,
        reduction,
      };
      if (endDate) body.endDate = endDate;
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
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={close}>
      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close simulate reduction"
        style={{ flex: 1, backgroundColor: t.scrim, justifyContent: "flex-end" }}
      >
        {/* Swallows touches — see OptionSheet's own note in ui.tsx for why this is a View, not a Pressable. */}
        <View
          onStartShouldSetResponder={() => true}
          style={{
            backgroundColor: t.surfaceRaised,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            maxHeight: "88%",
          }}
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
              accessibilityLabel="Close"
              hitSlop={10}
              style={{ padding: space.xs }}
            >
              <Ionicons name="close" size={20} color={ink[500]} />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: space.lg,
              paddingBottom: insets.bottom + space.lg,
              gap: space.md,
            }}
            keyboardShouldPersistTaps="handled"
          >
            <T variant="caption" style={{ lineHeight: 18 }}>
              A what-if check — nothing is saved, and no record is created, edited or deleted. This asks what your
              recorded expenses would look like if {opportunity.categoryName} were lower by the amount you choose.
            </T>

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
                accessibilityLabel="Reduce by percent or peso amount"
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
                  fontSize: typeScale.body,
                  color: ink[900],
                }}
              />
              {kind === "amount" && evidenceBaseline > 0 ? (
                <T variant="caption" style={{ marginTop: 4 }}>
                  This category's period total is {formatMoney(evidenceBaseline)} — the most you can simulate reducing
                  it by.
                </T>
              ) : null}
              {valueError ? (
                <View
                  accessibilityLiveRegion="polite"
                  style={{ flexDirection: "row", gap: 5, marginTop: space.sm, alignItems: "flex-start" }}
                >
                  <T style={{ fontSize: typeScale.micro, color: statusText.critical }}>⚠</T>
                  <T style={{ flex: 1, fontSize: typeScale.caption, lineHeight: 17, color: statusText.critical }}>
                    {valueError}
                  </T>
                </View>
              ) : null}
            </View>

            <Button title={submitting ? "Simulating…" : "Simulate"} onPress={submit} disabled={submitting} loading={submitting} />

            {submitError ? <ErrorNote>{submitError}</ErrorNote> : null}

            {result ? <ReductionSimulationResult result={result} /> : null}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * The answer — labelled as hypothetical throughout, per plan §4.2's "review,
 * not verdict" language rules. Category expenses first, then total expenses,
 * because the category is what the owner just chose to simulate and the
 * total is the wider context it sits inside.
 */
function ReductionSimulationResult({ result }: { result: ReductionSimulation }) {
  const t = useTheme();
  return (
    <View
      accessibilityLabel="Hypothetical simulation result"
      style={{
        backgroundColor: t.surfaceMuted,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.md,
      }}
    >
      <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>
        Hypothetical result — nothing was changed or saved
      </T>

      <BeforeAfterRow label={`${result.categoryName} (${result.period.days}-day period)`} before={result.categoryExpenses.before} after={result.categoryExpenses.after} />
      <BeforeAfterRow label="Total recorded expenses" before={result.totalExpenses.before} after={result.totalExpenses.after} />

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        <T style={{ fontSize: typeScale.bodySm }}>Hypothetical reduction:</T>
        <Money value={result.hypotheticalReduction} size={typeScale.bodySm} weight="semibold" />
        <T variant="caption">({result.requestedReductionPercent}% of this category's period total)</T>
      </View>

      {result.assumptions.length > 0 ? (
        <View>
          <T variant="caption" style={{ fontFamily: font.sansSemibold, color: t.ink[700] }}>
            Assumptions
          </T>
          {result.assumptions.map((assumption) => (
            <T key={assumption} variant="caption" style={{ marginTop: 2, lineHeight: 17 }}>
              • {assumption}
            </T>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function BeforeAfterRow({ label, before, after }: { label: string; before: number; after: number }) {
  const t = useTheme();
  return (
    <View>
      <T variant="label" style={{ color: t.ink[700], marginBottom: 2 }}>
        {label}
      </T>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <View>
          <T variant="caption">Before</T>
          <Money value={before} size={14} weight="medium" style={{ marginTop: 1 }} />
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T variant="caption">After (hypothetical)</T>
          <Money value={after} size={14} weight="semibold" style={{ marginTop: 1 }} />
        </View>
      </View>
    </View>
  );
}
