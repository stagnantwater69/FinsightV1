import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { FormPage } from "../components/ui";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { FIELD_LIMITS } from "../lib/fieldLimits";

function today() {
  return new Date().toISOString().slice(0, 10);
}

interface DuplicateSalesState {
  description: string;
  amount: number;
}

export function AddSalesRecord() {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  // Prefilled by the "Duplicate" action on Records — date is left at today().
  const duplicateFrom = (useLocation().state as { duplicateFrom?: DuplicateSalesState } | null)?.duplicateFrom;
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState(duplicateFrom?.description ?? "Daily sales");
  const [amount, setAmount] = useState<number | "">(duplicateFrom?.amount ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!selected) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/records/sales", {
        businessProfileId: selected!.id,
        date,
        description,
        amount,
      });
      toast("Sales reference saved");
      navigate("/records");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormPage eyebrow="Records" title="Add sales reference">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Date" htmlFor="date" required>
          <TextInput type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
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
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save sales reference"}
        </Button>
      </form>
    </FormPage>
  );
}
