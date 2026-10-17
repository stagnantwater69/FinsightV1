import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import {
  availableFundsBaselineRequest,
  isAvailableFundsBaselineRecoveryError,
  type AvailableFundsBaselineDecision,
} from "../lib/availableFundsBaseline";

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
  const groupId = useId();
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

  function focus() {
    document.getElementById(`${groupId}-yes`)?.focus();
  }

  const setFromRecord = useCallback((value: AvailableFundsBaselineDecision, baselineAt?: string | null) => {
    setDecisionValue(
      baselineAt && baselineAt === selectedBaselineAt.current ? value : null,
    );
    setError(null);
  }, []);

  return {
    decision,
    error,
    groupId,
    required,
    setDecision,
    check(): boolean {
      if (!required || decision !== null) return true;
      setError(REQUIRED_MESSAGE);
      window.setTimeout(focus, 0);
      return false;
    },
    requestFields() {
      return availableFundsBaselineRequest(baseline, date, decision);
    },
    setFromRecord,
    async absorb(errorValue: unknown, isCurrent: () => boolean = () => true): Promise<boolean> {
      if (!isAvailableFundsBaselineRecoveryError(errorValue)) return false;
      if (!isCurrent()) return true;
      setDecisionValue(null);
      setError(CHANGED_MESSAGE);
      try {
        await refresh();
        if (!isCurrent()) return true;
        setError(CHANGED_MESSAGE);
      } catch {
        if (!isCurrent()) return true;
        setError("The recorded balance changed, but its latest details could not be loaded. Try again before saving.");
      }
      window.setTimeout(() => { if (isCurrent()) focus(); }, 0);
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
  if (!choice.required) {
    return choice.error ? (
      <p role="alert" className="text-sm text-tone-danger">
        {choice.error}
      </p>
    ) : null;
  }

  return (
    <fieldset
      className="rounded-xl border border-paper-200 bg-paper-50 p-4"
      aria-describedby={`${choice.groupId}-help${choice.error ? ` ${choice.groupId}-error` : ""}`}
    >
      <legend className="px-1 text-sm font-semibold text-ink-900">
        {question}
      </legend>
      <p id={`${choice.groupId}-help`} className="mt-1 text-sm leading-relaxed text-ink-600">
        {help}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Recorded balance inclusion">
        {(
          [
            [true, "Yes, it was already included"],
            [false, "No, apply it after the balance"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={String(value)}
            className={`tap flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              choice.decision === value
                ? "border-brand-500 bg-paper text-tone-brand"
                : "border-paper-200 bg-paper text-ink-700 hover:border-paper-300"
            }`}
          >
            <input
              id={`${choice.groupId}-${value ? "yes" : "no"}`}
              type="radio"
              name={choice.groupId}
              checked={choice.decision === value}
              disabled={disabled}
              onChange={() => choice.setDecision(value)}
              className="shrink-0 accent-brand-700"
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {choice.error ? (
        <p id={`${choice.groupId}-error`} role="alert" className="mt-2 text-sm text-tone-danger">
          {choice.error}
        </p>
      ) : null}
    </fieldset>
  );
}
