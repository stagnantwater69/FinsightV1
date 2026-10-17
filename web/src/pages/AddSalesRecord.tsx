import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { getErrorMessage } from "../lib/errors";
import { FormPage } from "../components/ui";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { TransactionDateField, useTransactionDate } from "../components/TransactionDateField";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../components/AvailableFundsBaselineChoice";
import { useAuth } from "../context/AuthContext";
import { useManualRecordCreate } from "../lib/useManualRecordCreate";
import { ManualCreateRecovery } from "../components/ManualCreateRecovery";

interface DuplicateSalesState {
  description: string;
  amount: number;
}

export function AddSalesRecord() {
  const { selected } = useBusinessProfiles();
  const { profile } = useAuth();
  return <AddSalesRecordForm key={`${profile?.id}:${selected?.id}`} />;
}

function AddSalesRecordForm() {
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
  const recovery = useManualRecordCreate(selected?.id, "sales");
  const savePending = useRef(false);
  const confirmedSave = useRef(false);
  const formScope = `${recovery.ownerId}:${selected?.id}`;
  const currentScope = useRef(formScope);
  currentScope.current = formScope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const frozenBody = recovery.pending?.body ?? recovery.deferredDraft;
  const setTransactionDate = dateField.setDate;
  useEffect(() => {
    if (!frozenBody) return;
    setTransactionDate(frozenBody.date); setDescription(frozenBody.description); setAmount(frozenBody.amount);
  }, [frozenBody, setTransactionDate]);

  if (!selected) return <NoBusinessProfile />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (confirmedSave.current || savePending.current || recovery.busy || recovery.loading) return;
    if (!recovery.pending && (amount === "" || !dateField.check() || !baselineChoice.check())) return;
    savePending.current = true;
    const requestScope = formScope;
    const isCurrent = () => mounted.current && currentScope.current === requestScope;
    setError(null);
    setSubmitting(true);
    try {
      const data = await recovery.save(recovery.pending?.body ?? {
        businessProfileId: selected!.id,
        date: dateField.date,
        description,
        amount: Number(amount),
        ...baselineChoice.requestFields(),
      });
      if (!data || !isCurrent()) return;
      confirmedSave.current = true;
      toast("Sales reference saved");
      navigate("/records");
    } catch (err) {
      if (!isCurrent()) return;
      if (confirmedSave.current) { setError("Your sales reference is saved. Open Records to see it."); return; }
      if (recovery.pending || (!dateField.absorb(err) && !(await baselineChoice.absorb(err, isCurrent)))) {
        if (isCurrent()) setError(getErrorMessage(err));
      }
    } finally {
      savePending.current = false;
      if (isCurrent()) setSubmitting(false);
    }
  }

  return (
    <FormPage eyebrow="Records" title="Add sales reference">
      <form onSubmit={handleSubmit} className="space-y-4">
        <ManualCreateRecovery recovery={recovery} />
        <fieldset className="min-w-0 space-y-4" disabled={submitting || recovery.loading || recovery.frozen}>
        <TransactionDateField field={dateField} />
        {!recovery.pending ? <AvailableFundsBaselineChoice choice={baselineChoice} disabled={submitting} /> : null}
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
        </fieldset>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={confirmedSave.current || submitting || recovery.busy || recovery.loading || recovery.corrupt || (!recovery.pending && dateField.invalid)}>
          {submitting ? "Saving…" : recovery.pending?.confirmedRecord ? "Finish recovery" : recovery.pending ? "Retry original save" : "Save sales reference"}
        </Button>
      </form>
    </FormPage>
  );
}
