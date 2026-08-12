import { useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { Field, FormError, MoneyInput, TextInput } from "./Field";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "Add sales" as a popup on the Records page, rather than a navigation to
 * /records/sales/new. Deliberately doesn't reuse AddSalesRecord.tsx's JSX —
 * that page owns a route, a FormPage shell, and a `navigate()` call none of
 * which apply here, and a modal closes + refreshes the list in place instead.
 * The full-page route stays for Quick Add and every other entry point that
 * isn't already looking at this table.
 */
export function AddSalesModal({
  businessProfileId,
  open,
  onClose,
  onSaved,
}: {
  businessProfileId: number;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("Daily sales");
  const [amount, setAmount] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setDate(today());
    setDescription("Daily sales");
    setAmount("");
    setError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/records/sales", { businessProfileId, date, description, amount });
      toast("Sales reference saved");
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
    <Modal open={open} onClose={onClose} title="Add sales reference">
      <form onSubmit={handleSubmit} className="space-y-4">
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
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save sales reference"}
        </Button>
      </form>
    </Modal>
  );
}
