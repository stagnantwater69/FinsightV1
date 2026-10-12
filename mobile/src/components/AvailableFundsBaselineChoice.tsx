import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import {
  availableFundsBaselineRequest,
  isAvailableFundsBaselineRecoveryError,
  type AvailableFundsBaselineDecision,
} from "../lib/availableFundsBaseline";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { T } from "./ui";
import { useTheme } from "../context/ThemeContext";

const REQUIRED_MESSAGE = "Choose whether this transaction was already included in the recorded balance.";
const CHANGED_MESSAGE = "The recorded balance changed while this form was open. Choose again using the latest balance.";

type BaselineIdentity = {
  availableFundsBaselineAt: string;
  availableFundsBaselineDate: string;
};

export function useAvailableFundsBaselineChoice(date: string, baselineIdentity?: BaselineIdentity) {
  const { selected, refresh } = useBusinessProfiles();
  const baseline = baselineIdentity ?? selected;
  const baselineAt = baseline?.availableFundsBaselineAt;
  const baselineDate = baseline?.availableFundsBaselineDate;
  const [decision, setDecisionValue] = useState<AvailableFundsBaselineDecision>(null);
  const [error, setError] = useState<string | null>(null);
  const previousBaselineAt = useRef(baselineAt);
  const selectedBaselineAt = useRef(selected?.availableFundsBaselineAt);
  selectedBaselineAt.current = selected?.availableFundsBaselineAt;
  const required = Boolean(baselineAt && baselineDate && date === baselineDate);

  useEffect(() => {
    const previous = previousBaselineAt.current;
    const current = baselineAt;
    previousBaselineAt.current = current;
    if (previous !== undefined && current !== previous) {
      setDecisionValue(null);
      if (current && baselineDate === date) setError(CHANGED_MESSAGE);
    }
  }, [baselineAt, baselineDate, date]);

  useEffect(() => {
    if (!required) setError(null);
  }, [required]);

  const setDecision = useCallback((value: AvailableFundsBaselineDecision) => {
    setDecisionValue(value);
    setError(null);
  }, []);

  const setFromRecord = useCallback((value: AvailableFundsBaselineDecision, baselineAt?: string | null) => {
    setDecisionValue(
      baselineAt && baselineAt === selectedBaselineAt.current ? value : null,
    );
    setError(null);
  }, []);

  return {
    decision,
    error,
    required,
    setDecision,
    check(): boolean {
      if (!required || decision !== null) return true;
      setError(REQUIRED_MESSAGE);
      return false;
    },
    requestFields() {
      return availableFundsBaselineRequest(baseline, date, decision);
    },
    setFromRecord,
    async absorb(errorValue: unknown): Promise<boolean> {
      if (!isAvailableFundsBaselineRecoveryError(errorValue)) return false;
      setDecisionValue(null);
      setError(CHANGED_MESSAGE);
      try {
        await refresh();
        setError(CHANGED_MESSAGE);
      } catch {
        setError("The recorded balance changed, but its latest details could not be loaded. Try again before saving.");
      }
      return true;
    },
  };
}

export type AvailableFundsBaselineChoiceState = ReturnType<typeof useAvailableFundsBaselineChoice>;

export function AvailableFundsBaselineChoice({
  choice,
  disabled = false,
  question = "Was this already included in the recorded balance?",
  help = "This transaction is on the same date as the latest balance you recorded. Choose Yes if that balance already counted it. Choose No if it happened afterwards.",
}: {
  choice: AvailableFundsBaselineChoiceState;
  disabled?: boolean;
  question?: string;
  help?: string;
}) {
  const t = useTheme();
  if (!choice.required) {
    return choice.error ? (
      <T accessibilityRole="alert" style={{ color: t.statusText.critical, fontSize: typeScale.bodySm }}>
        {choice.error}
      </T>
    ) : null;
  }

  const option = (value: boolean, label: string) => {
    const selected = choice.decision === value;
    return (
      <Pressable
        key={String(value)}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={{ checked: selected, disabled }}
        disabled={disabled}
        onPress={() => choice.setDecision(value)}
        style={({ pressed }) => ({
          minHeight: TAP_FLOOR,
          justifyContent: "center",
          borderWidth: 1,
          borderColor: selected ? t.brandFill : t.border,
          backgroundColor: selected ? t.brand[50] : t.surface,
          borderRadius: radius.md,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        })}
      >
        <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansMedium, color: selected ? t.brandHeading : t.textSecondary }}>
          {label}
        </T>
      </Pressable>
    );
  };

  return (
    <View
      accessible={false}
      style={{ gap: space.sm, marginBottom: space.md }}
    >
      <T variant="label">{question}</T>
      <T variant="caption">
        {help}
      </T>
      {option(true, "Yes, it was already included")}
      {option(false, "No, apply it after the balance")}
      {choice.error ? (
        <T accessibilityRole="alert" style={{ color: t.statusText.critical, fontSize: typeScale.bodySm }}>
          {choice.error}
        </T>
      ) : null}
    </View>
  );
}
