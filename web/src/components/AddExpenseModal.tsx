import { useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { Field, FormError, MoneyInput, TextInput } from "./Field";
import { CategorySelect } from "./CategorySelect";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";

function today() {
  return new Date().toISOString().slice(0, 10);
}

interface FieldErrors {
  category?: string;
  date?: string;
  description?: string;
  amount?: string;
}

/**
 * Messages name the fix, not the rule — "Enter an amount greater than 0"
 * rather than "Invalid amount", so the owner knows what to do next.
 */
function validate(values: {
  categoryId: number | "";
  date: string;
  description: string;
  amount: number | "";
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.categoryId) errors.category = "Choose a category for this expense.";
  if (!values.date) errors.date = "Enter the date of this expense.";
  if (!values.description.trim()) errors.description = "Describe what this expense was for.";
  if (values.amount === "" || Number.isNaN(values.amount)) errors.amount = "Enter the amount.";
  else if (values.amount <= 0) errors.amount = "Enter an amount greater than 0.";
  return errors;
}

/**
 * "Add expense" as a popup on the Records page — see AddSalesModal for why
 * this doesn't reuse the full-page AddExpense.tsx. That page's first-expense
 * celebration doesn't come along either: a full-screen "you did it" moment
 * doesn't fit inside a modal that's about to close, and it still fires the
 * first time an owner uses the full-page route (Quick Add, Dashboard's empty
 * state) if they never happen to use this popup first.
 */
export function AddExpenseModal({
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
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // Errors appear on blur only for fields the owner has already left, so the
  // form doesn't turn red under a cursor that is still on the first input.
  const [touched, setTouched] = useState<Partial<Record<keyof FieldErrors, boolean>>>({});

  const errors = validate({ categoryId, date, description, amount });
  const shownErrors: FieldErrors = {
    category: touched.category || fieldErrors.category ? errors.category : undefined,
    date: touched.date || fieldErrors.date ? errors.date : undefined,
    description: touched.description || fieldErrors.description ? errors.description : undefined,
    amount: touched.amount || fieldErrors.amount ? errors.amount : undefined,
  };

  function markTouched(key: keyof FieldErrors) {
    setTouched((t) => ({ ...t, [key]: true }));
  }

  function reset() {
    setCategoryId("");
    setDate(today());
    setDescription("");
    setVendor("");
    setAmount("");
    setError(null);
    setFieldErrors({});
    setTouched({});
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    /*
     * This used to `return` silently on an invalid category or amount, so the
     * Save button did nothing at all and said nothing about why. Anything the
     * browser would have caught is now caught here instead, because the native
     * tooltip is unstyled, untranslated, and vanishes on the next keystroke.
     */
    if (Object.values(errors).some(Boolean)) {
      setFieldErrors(errors);
      setTouched({ category: true, date: true, description: true, amount: true });
      return;
    }
    setFieldErrors({});
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/records/expenses", {
        businessProfileId,
        categoryId,
        date,
        description,
        vendor: vendor || undefined,
        amount,
      });
      toast("Expense saved");
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
    <Modal open={open} onClose={onClose} title="Add expense">
      {/* noValidate hands validation to the code above; see handleSubmit. */}
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field label="Category" htmlFor="modal-expense-category" required error={shownErrors.category}>
          <CategorySelect
            id="modal-expense-category"
            value={categoryId}
            onChange={setCategoryId}
            onBlur={() => markTouched("category")}
          />
        </Field>
        <Field label="Date" htmlFor="modal-expense-date" required error={shownErrors.date}>
          <TextInput
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onBlur={() => markTouched("date")}
          />
        </Field>
        <Field label="Description" htmlFor="modal-expense-description" required error={shownErrors.description}>
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => markTouched("description")}
            placeholder="e.g. Rice sacks"
          />
        </Field>
        <Field label="Vendor" htmlFor="modal-expense-vendor" optional>
          <TextInput value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <Field label="Amount" htmlFor="modal-expense-amount" required error={shownErrors.amount}>
          <MoneyInput
            min={0.01}
            value={amount}
            onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
            onBlur={() => markTouched("amount")}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save expense"}
        </Button>
      </form>
    </Modal>
  );
}
