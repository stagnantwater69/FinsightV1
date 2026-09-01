import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Button, ErrorNote, Field, Money, T } from "./ui";
import { DateField } from "./DateField";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";
import { api, errorMessage } from "../lib/api";
import { formatMoney, formatPercent } from "../lib/money";
import { assumedExpensesValidationError, parseScenarioNumber } from "../lib/recoveryScenarioForm";
import { bufferPercentError, currentMonthKey, parsePlanNumber } from "../lib/recoveryPlanForm";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { RecoveryPlan, RecoveryScenario } from "../lib/types";

/**
 * "What would the Recovery Target be if expected monthly expenses were
 * different?" — Expense Reduction Opportunities plan §13.2/§15 Phase 5.
 *
 * The ONLY valid hypothetical here is an explicit, owner-typed change to
 * `expectedMonthlyExpenses` — never one derived from a reduction-opportunity
 * simulation or from actual category spending (plan §13.2, §5.5). This sheet
 * never writes to the business profile: `POST /insights/recovery-scenario`
 * is read-only (see `simulateRecoveryScenario` in
 * backend/src/services/insights.service.ts), and there is no button here
 * that could apply the hypothetical value — reaching that requires going to
 * the business profile form separately, as an explicit, unrelated edit.
 *
 * Same shape as ReductionSimulationSheet.tsx: a centred Modal, a form, a
 * result panel labelled as hypothetical throughout, and no persistence.
 */
export function RecoveryScenarioSheet({
  visible,
  businessProfileId,
  currentExpectedMonthlyExpenses,
  onClose,
}: {
  visible: boolean;
  businessProfileId: number;
  /** A courtesy starting point for the input — the real, currently-configured figure. */
  currentExpectedMonthlyExpenses: number;
  onClose: () => void;
}) {
  const t = useTheme();
  const { brand, ink, statusText } = t;
  const insets = useSafeAreaInsets();

  const [rawValue, setRawValue] = useState("");
  const [valueError, setValueError] = useState<string | null>(null);
  const [valueFocused, setValueFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<RecoveryScenario | null>(null);
  const seq = useRef(0);

  // Reset every time the sheet is opened fresh, same reasoning as
  // ReductionSimulationSheet's per-opportunity reset — a stale result from a
  // previous visit must not linger behind a newly reopened sheet.
  useEffect(() => {
    if (!visible) return;
    seq.current += 1;
    setRawValue("");
    setValueError(null);
    setSubmitting(false);
    setSubmitError(null);
    setResult(null);
  }, [visible]);

  async function submit() {
    if (submitting) return;
    const invalid = assumedExpensesValidationError(rawValue);
    if (invalid) {
      setValueError(invalid);
      haptics.failed();
      return;
    }
    setValueError(null);
    const value = parseScenarioNumber(rawValue)!;

    const mySeq = (seq.current += 1);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api.post<RecoveryScenario>("/insights/recovery-scenario", {
        businessProfileId,
        assumedExpectedMonthlyExpenses: value,
      });
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
        accessibilityLabel="Close hypothetical recovery scenario"
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
                Hypothetical recovery target
              </T>
              <T variant="caption" style={{ marginTop: 2 }}>
                What if expected monthly expenses were different?
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
              A what-if check — nothing is saved. Your real Recovery Target and your business profile stay exactly as
              they are; this only asks what the target would look like at a different assumed monthly expense figure.
            </T>

            <View>
              <T variant="label" style={{ marginBottom: 4 }}>
                Assumed expected monthly expenses (PHP)
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
                placeholder={`e.g. ${Math.round(currentExpectedMonthlyExpenses)}`}
                placeholderTextColor={ink[400]}
                accessibilityLabel="Assumed expected monthly expenses, in Philippine pesos"
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
              <T variant="caption" style={{ marginTop: 4 }}>
                Your currently configured figure is {formatPHP(currentExpectedMonthlyExpenses)}.
              </T>
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

            <Button title={submitting ? "Calculating…" : "See hypothetical target"} onPress={submit} disabled={submitting} loading={submitting} />

            {submitError ? <ErrorNote>{submitError}</ErrorNote> : null}

            {result ? <RecoveryScenarioResult result={result} /> : null}

            {/*
              §10.7 "Save as a plan" — small and secondary, deliberately not
              styled like the primary "See hypothetical target" button above.
              Persists only what was just typed in as the assumed expense
              figure, for the owner's own reference; never touches the real
              Recovery Target or the business profile. See SaveAsPlanAction.
            */}
            {result ? (
              <SaveAsPlanAction
                businessProfileId={businessProfileId}
                assumedExpectedMonthlyExpenses={result.assumedExpectedMonthlyExpenses}
              />
            ) : null}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

/** A plain PHP formatter local to this file — kept minimal since Money already exists for the panel below. */
function formatPHP(value: number): string {
  return `₱${Math.round(value).toLocaleString("en-PH")}`;
}

/**
 * The answer. The CURRENT column is unchanged, real data — the same figures
 * already on RecoveryTargetScreen behind this sheet — and the HYPOTHETICAL
 * column is explicitly labelled as such throughout, per plan §13.2's
 * "current remains visually primary… hypothetical is visually distinct and
 * labeled as not saved."
 */
function RecoveryScenarioResult({ result }: { result: RecoveryScenario }) {
  const t = useTheme();
  return (
    <View
      accessibilityLabel="Hypothetical recovery scenario result"
      style={{
        backgroundColor: t.surfaceMuted,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.md,
      }}
    >
      <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>
        Hypothetical result — your real target and profile are unchanged
      </T>

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        <T style={{ fontSize: typeScale.bodySm }}>Assumed expected monthly expenses:</T>
        <Money value={result.assumedExpectedMonthlyExpenses} size={typeScale.bodySm} weight="semibold" />
      </View>

      <ScenarioRow
        label="Expected monthly expenses"
        current={result.current.expectedMonthlyExpenses}
        hypothetical={result.hypothetical.expectedMonthlyExpenses}
        delta={result.delta?.totalCoverageGoal}
      />
      <ScenarioRow
        label="Remaining target this month"
        current={result.current.remainingTarget}
        hypothetical={result.hypothetical.remainingTarget}
        delta={result.delta?.remainingTarget}
      />
      <ScenarioRow
        label="Daily target"
        current={result.current.dailyNeededTarget}
        hypothetical={result.hypothetical.dailyNeededTarget}
      />
      <ScenarioRow
        label="Adjusted daily target (remaining days)"
        current={result.current.adjustedDailyTarget}
        hypothetical={result.hypothetical.adjustedDailyTarget}
        delta={result.delta?.adjustedDailyTarget}
      />

      {/*
        §10.7 — "estimated transaction delta only when valid". The server
        deliberately never guesses whether sales references are
        transaction-level or daily-aggregate imports (plan §19 #7), so this
        is always the explicit unavailable note, never a number, until that
        open question resolves. Only rendered once `delta` itself is present
        — an older server that predates Phase 4 simply omits this note.
      */}
      {result.delta ? (
        <View>
          <T variant="label" style={{ color: t.ink[700], marginBottom: 2 }}>
            Estimated transactions per day
          </T>
          <T variant="caption" style={{ lineHeight: 17 }}>
            Not available — can't tell if your sales records are per-transaction or daily totals.
          </T>
        </View>
      ) : null}

      <T variant="caption" style={{ lineHeight: 17 }}>
        Not saved anywhere. Changing your actual expected monthly expenses is a separate, explicit edit to your
        business profile.
      </T>
    </View>
  );
}

/**
 * "Save this as a plan" — plan §7.5/§10.7/§11 Phase 6.
 *
 * A SMALL, SECONDARY ACTION, not a second prominent feature. It starts as a
 * plain text link under the hypothetical result and only expands into a form
 * once tapped, so an owner who only wanted the what-if answer never sees a
 * form they didn't ask for. `deadline` and `bufferPercent` are both entirely
 * optional — the one thing this always persists is `ownerTargetAmount`, the
 * same assumed figure already on screen in the result above it.
 *
 * `PUT /business-profiles/:id/recovery-plans/:month` for the CURRENT month —
 * a plan is keyed by month, not by scenario, and this sheet has no other
 * month to offer. Writes only that one record; never reads or writes
 * anything the live Recovery Target calculation touches.
 */
function SaveAsPlanAction({
  businessProfileId,
  assumedExpectedMonthlyExpenses,
}: {
  businessProfileId: number;
  assumedExpectedMonthlyExpenses: number;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [bufferRaw, setBufferRaw] = useState("");
  const [bufferInputError, setBufferInputError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const err = bufferPercentError(bufferRaw);
    if (err) {
      setBufferInputError(err);
      return;
    }
    setBufferInputError(null);
    setSaveError(null);
    setSaving(true);
    try {
      await api.put<RecoveryPlan>(`/business-profiles/${businessProfileId}/recovery-plans/${currentMonthKey()}`, {
        ownerTargetAmount: assumedExpectedMonthlyExpenses,
        deadline: deadline.trim() === "" ? null : deadline,
        bufferPercent: bufferRaw.trim() === "" ? null : parsePlanNumber(bufferRaw),
      });
      setSaved(true);
    } catch (err2) {
      setSaveError(errorMessage(err2));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Save this as a plan"
        style={{ alignSelf: "flex-start", paddingVertical: space.xs }}
      >
        <T style={{ fontSize: typeScale.caption, color: t.brand[700], textDecorationLine: "underline" }}>
          Save this as a plan
        </T>
      </Pressable>
    );
  }

  return (
    <View
      style={{
        backgroundColor: t.surfaceMuted,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>
        Save this as a plan
      </T>
      <T variant="caption" style={{ lineHeight: 17 }}>
        Keeps {formatMoney(assumedExpectedMonthlyExpenses)} as your own reference for this month, alongside an
        optional deadline and buffer. This doesn't change your business profile or recorded sales.
      </T>

      {saved ? (
        <T variant="caption">Saved for reference — this doesn't change your business profile or recorded sales.</T>
      ) : (
        <>
          <DateField label="Deadline (optional)" value={deadline} onChange={setDeadline} allowFuture optional onClear={() => setDeadline("")} />
          <Field
            label="Buffer percent (optional)"
            value={bufferRaw}
            onChangeText={(v) => {
              setBufferRaw(v);
              setBufferInputError(null);
            }}
            keyboardType="decimal-pad"
            error={bufferInputError}
            placeholder="e.g. 10"
          />
          {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
          <Button title="Save plan" variant="secondary" onPress={save} loading={saving} />
        </>
      )}
    </View>
  );
}

/**
 * §10.7 — peso delta always shown; percentage delta only when `current` is
 * non-zero, guarded here rather than at each call site so no caller can
 * forget it and render "Infinity%"/"NaN%" off a zero baseline. Also
 * suppressed when `current` is under one peso in magnitude: a legitimate
 * near-zero baseline (e.g. `remainingTarget` close to fully covered) can
 * still produce a finite but meaningless percentage like "+99999900%".
 */
function ScenarioRow({
  label,
  current,
  hypothetical,
  delta,
}: {
  label: string;
  current: number;
  hypothetical: number;
  /** Server-computed `hypothetical - current`. Omitted (older server, or a metric the delta contract doesn't cover) skips the delta line entirely. */
  delta?: number;
}) {
  const t = useTheme();
  const percent =
    delta !== undefined && Math.abs(current) >= 1 ? formatPercent((delta / current) * 100) : null;
  return (
    <View>
      <T variant="label" style={{ color: t.ink[700], marginBottom: 2 }}>
        {label}
      </T>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <View>
          <T variant="caption">Current (unchanged)</T>
          <Money value={current} size={14} weight="medium" style={{ marginTop: 1 }} />
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T variant="caption">Hypothetical (not saved)</T>
          <Money value={hypothetical} size={14} weight="semibold" style={{ marginTop: 1 }} />
        </View>
      </View>
      {delta !== undefined ? (
        <T variant="caption" style={{ marginTop: 2, textAlign: "right" }}>
          {formatMoney(delta, { decimals: true, signed: true })}
          {percent ? ` (${delta >= 0 ? "+" : ""}${percent})` : ""}
        </T>
      ) : null}
    </View>
  );
}
