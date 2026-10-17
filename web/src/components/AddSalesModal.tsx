import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { Field, FormError, MoneyInput, TextInput } from "./Field";
import { TransactionDateField, useTransactionDate } from "./TransactionDateField";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordItem } from "../lib/types";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "./AvailableFundsBaselineChoice";
import { useManualRecordCreate } from "../lib/useManualRecordCreate";
import { ManualCreateRecovery } from "./ManualCreateRecovery";

export interface DuplicateSalesSeed {
  description: string;
  amount: number | "";
}

/**
 * "Add sales" as a popup on the Records page, rather than a navigation to
 * /records/sales/new. Deliberately doesn't reuse AddSalesRecord.tsx's JSX —
 * that page owns a route, a FormPage shell, and a `navigate()` call none of
 * which apply here, and a modal closes + refreshes the list in place instead.
 * The full-page route stays for Quick Add and every other entry point that
 * isn't already looking at this table.
 *
 * Also doubles as Edit (`recordId` set → fetch-and-PATCH) and Duplicate
 * (`duplicateFrom` set → seed a fresh POST, no id or date carried over) — see
 * AddExpenseModal for why the three share one form and one submit path.
 */
export function AddSalesModal({
  businessProfileId,
  open,
  onClose,
  onSaved,
  recordId,
  duplicateFrom,
}: {
  businessProfileId: number;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  recordId?: number;
  duplicateFrom?: DuplicateSalesSeed;
}) {
  const toast = useToast();
  const editing = recordId !== undefined;
  const dateField = useTransactionDate();
  const date = dateField.date;
  const baselineChoice = useAvailableFundsBaselineChoice(date);
  const [description, setDescription] = useState("Daily sales");
  const [amount, setAmount] = useState<number | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const recovery = useManualRecordCreate(businessProfileId, "sales", open && !editing);
  const savePending = useRef(false);
  const confirmedSave = useRef(false);
  const formScope = `${recovery.ownerId}:${businessProfileId}:${open}:${recordId}`;
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

  function reset() {
    dateField.setDate(dateField.today);
    setDescription("Daily sales");
    setAmount("");
    setError(null);
    baselineChoice.setDecision(null);
  }

  // See AddExpenseModal's identical effect — the modal stays mounted across
  // opens (Modal.tsx), so this is what re-seeds it for whichever of the
  // three modes it was opened in.
  useEffect(() => {
    if (!open) return;
    confirmedSave.current = false;
    reset();
    if (editing && recordId !== undefined) {
      setLoading(true);
      api
        .get<RecordItem>(`/records/sales/${recordId}`)
        .then(({ data }) => {
          dateField.setDate(data.date.slice(0, 10));
          setDescription(data.description);
          setAmount(data.amount);
          baselineChoice.setFromRecord(
            data.includedInAvailableFundsBaseline ?? null,
            data.availableFundsDeltaBaselineAt,
          );
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false));
    } else if (duplicateFrom) {
      setDescription(duplicateFrom.description);
      setAmount(duplicateFrom.amount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recordId]);

  function handleClose() {
    onClose();
    reset();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (confirmedSave.current || savePending.current || recovery.busy || (!editing && recovery.loading)) return;
    if (!recovery.pending && (amount === "" || !dateField.check() || !baselineChoice.check())) return;
    savePending.current = true;
    const requestScope = formScope;
    const isCurrent = () => mounted.current && currentScope.current === requestScope;
    setError(null);
    setSubmitting(true);
    try {
      if (editing && recordId !== undefined) {
        await api.patch(
          `/records/sales/${recordId}`,
          { date, description, amount, ...baselineChoice.requestFields() },
          { serverStateScope: { businessProfileId } },
        );
        if (!isCurrent()) return;
        confirmedSave.current = true;
        toast("Changes saved");
      } else {
        const saved = await recovery.save(recovery.pending?.body ?? {
          businessProfileId,
          date,
          description,
          amount: Number(amount),
          ...baselineChoice.requestFields(),
        });
        if (!saved || !isCurrent()) return;
        confirmedSave.current = true;
        toast("Sales reference saved");
      }
      reset();
      try { onSaved(); } finally { onClose(); }
    } catch (err) {
      if (!isCurrent()) return;
      if (confirmedSave.current) { setError("Your record is saved. Close this form and refresh Records to see it."); return; }
      if (recovery.pending || (!dateField.absorb(err) && !(await baselineChoice.absorb(err, isCurrent)))) {
        if (isCurrent()) setError(getErrorMessage(err));
      }
    } finally {
      savePending.current = false;
      if (isCurrent()) setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={editing ? "Edit sales reference" : "Add sales reference"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {!editing ? <ManualCreateRecovery recovery={recovery} /> : null}
        {loading ? <p className="text-sm text-ink-500">Loading…</p> : null}
        <fieldset className="min-w-0 space-y-4" disabled={submitting || (!editing && (recovery.loading || recovery.frozen))}>
        <TransactionDateField field={dateField} />
        {!recovery.pending ? <AvailableFundsBaselineChoice choice={baselineChoice} disabled={submitting || loading} /> : null}
        <Field label="Description" required>
          <TextInput required value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Amount" required>
          <MoneyInput
            min={0.01}
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </Field>
        </fieldset>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={confirmedSave.current || submitting || recovery.busy || recovery.corrupt || loading || (!editing && recovery.loading) || (!recovery.pending && dateField.invalid)}>
          {submitting ? "Saving…" : editing ? "Save changes" : recovery.pending?.confirmedRecord ? "Finish recovery" : recovery.pending ? "Retry original save" : "Save sales reference"}
        </Button>
      </form>
    </Modal>
  );
}
