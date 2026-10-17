import { useCallback, useEffect, useId, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { FUTURE_DATE_MESSAGE, futureDateError, todayIso } from "../lib/dates";
import { isFutureDateError } from "../lib/errors";
import { captureServerStateAccount, serverStateAccountMatches, type ServerStateAccount } from "../lib/serverStateCache";
import { Field, TextInput } from "./Field";

/**
 * The date of an expense or sale: today or earlier, never later.
 *
 * `max` stops the picker at today, but a typed date ignores `max`, so the value
 * is also checked on every change. A future date shows the error under the
 * field and the form keeps its submit button disabled until it is fixed. The
 * server applies the same rule (`FUTURE_DATE`); `absorb` puts that answer on
 * the field too, for the rare case where the two disagree about today.
 *
 * "Today" is the business's calendar day when its timezone is known, and the
 * device's otherwise. Both are `YYYY-MM-DD`, compared as strings.
 */
export function useTransactionDate(initial?: string) {
  // Per instance: several record forms can be mounted at once (the Records
  // page keeps its add and edit dialogs mounted), and ids must not repeat.
  const id = useId();
  const { selected } = useBusinessProfiles();
  const today = todayIso(selected?.timezone);
  const [date, setDateValue] = useState(initial ?? today);
  const [serverError, setServerError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ businessProfileId: number | undefined; account: ServerStateAccount | null } | null>(null);
  const error = futureDateError(date, today) ?? serverError;

  // Stable, so a page can call it from an effect that loads the record.
  const setDate = useCallback((value: string) => {
    setDateValue(value);
    setServerError(null);
    setFocusRequest(null);
  }, []);

  function focus() {
    document.getElementById(id)?.focus();
  }

  // A refused save must focus after the submitting fieldset becomes enabled.
  useEffect(() => {
    if (!focusRequest) return;
    const sameAccount = focusRequest.account
      ? serverStateAccountMatches(focusRequest.account)
      : captureServerStateAccount() === null;
    if (!sameAccount || focusRequest.businessProfileId !== selected?.id) {
      setFocusRequest(null);
      return;
    }
    const input = document.getElementById(id);
    if (input?.matches(":disabled")) return;
    input?.focus();
    setFocusRequest(null);
  });

  return {
    id,
    date,
    today,
    error,
    invalid: error !== null,
    setDate,
    /** For submit: false (with focus moved to the field) when the date is not allowed. */
    check(): boolean {
      if (futureDateError(date, today)) {
        focus();
        return false;
      }
      return true;
    },
    /** True when `err` was the server refusing the date; the field then shows it. */
    absorb(err: unknown): boolean {
      if (!isFutureDateError(err)) return false;
      setServerError(FUTURE_DATE_MESSAGE);
      setFocusRequest({ businessProfileId: selected?.id, account: captureServerStateAccount() });
      return true;
    },
  };
}

export type TransactionDate = ReturnType<typeof useTransactionDate>;

export function TransactionDateField({ field, label = "Date", disabled }: { field: TransactionDate; label?: string; disabled?: boolean }) {
  return (
    <Field label={label} htmlFor={field.id} required error={field.error}>
      <TextInput
        type="date"
        required
        value={field.date}
        max={field.today}
        disabled={disabled}
        onChange={(event) => field.setDate(event.target.value)}
      />
    </Field>
  );
}
