import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { FormPage } from "../components/ui";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { TransactionDateField, useTransactionDate } from "../components/TransactionDateField";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../components/AvailableFundsBaselineChoice";

interface DuplicateSalesState {
  description: string;
  amount: number;
}

export function AddSalesRecord() {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  // Prefilled by the "Duplicate" action on Records. The date starts at today.
  const duplicateFrom = (useLocation().state as { duplicateFrom?: DuplicateSalesState } | null)?.duplicateFrom;
  const dateField = useTransactionDate();
  const baselineChoice = useAvailableFundsBaselineChoice(dateField.date);
  const [description, setDescription] = useState(duplicateFrom?.description ?? "Daily sales");
  const [amount, setAmount] = useState<number | "">(duplicateFrom?.amount ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!selected) return <NoBusinessProfile />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dateField.check() || !baselineChoice.check()) return;
    if (amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/records/sales", {
        businessProfileId: selected!.id,
        date: dateField.date,
        description,
        amount,
        ...baselineChoice.requestFields(),
      });
      toast("Sales reference saved");
      navigate("/records");
    } catch (err) {
      if (!dateField.absorb(err) && !(await baselineChoice.absorb(err))) setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormPage eyebrow="Records" title="Add sales reference">
      <form onSubmit={handleSubmit} className="space-y-4">
        <TransactionDateField field={dateField} />
        <AvailableFundsBaselineChoice choice={baselineChoice} disabled={submitting} />
        <Field label="Description" htmlFor="description" required>
          <TextInput required value={description} onChange={(e) => setDescription(e.target.value)}
            maxLength={FIELD_LIMITS.recordDescription}
          />
        </Field>
        <Field label="Amount" htmlFor="amount" required>
          <MoneyInput
            min={0.01}
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting || dateField.invalid}>
          {submitting ? "Saving…" : "Save sales reference"}
        </Button>
      </form>
    </FormPage>
  );
}
