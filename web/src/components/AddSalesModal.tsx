import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { Field, FormError, MoneyInput, TextInput } from "./Field";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordItem } from "../lib/types";

function today() {
  return new Date().toISOString().slice(0, 10);
}

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
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("Daily sales");
  const [amount, setAmount] = useState<number | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setDate(today());
    setDescription("Daily sales");
    setAmount("");
    setError(null);
  }

  // See AddExpenseModal's identical effect — the modal stays mounted across
  // opens (Modal.tsx), so this is what re-seeds it for whichever of the
  // three modes it was opened in.
  useEffect(() => {
    if (!open) return;
    reset();
    if (editing && recordId !== undefined) {
      setLoading(true);
      api
        .get<RecordItem>(`/records/sales/${recordId}`)
        .then(({ data }) => {
          setDate(data.date.slice(0, 10));
          setDescription(data.description);
          setAmount(data.amount);
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
    if (amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      if (editing && recordId !== undefined) {
        await api.patch(`/records/sales/${recordId}`, { date, description, amount });
        toast("Changes saved");
      } else {
        await api.post("/records/sales", { businessProfileId, date, description, amount });
        toast("Sales reference saved");
      }
      reset();
      onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={editing ? "Edit sales reference" : "Add sales reference"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {loading ? <p className="text-sm text-ink-500">Loading…</p> : null}
        <Field label="Date" htmlFor="modal-sales-date" required>
          <TextInput type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="modal-sales-description" required>
          <TextInput required value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Amount" htmlFor="modal-sales-amount" required>
          <MoneyInput
            min={0.01}
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting || loading}>
          {submitting ? "Saving…" : editing ? "Save changes" : "Save sales reference"}
        </Button>
      </form>
    </Modal>
  );
}
