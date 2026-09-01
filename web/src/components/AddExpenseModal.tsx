import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { Callout } from "./ui";
import { Field, FormError, MoneyInput, TextInput } from "./Field";
import { CategorySelect } from "./CategorySelect";
import { Money } from "./Money";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordDetail } from "../lib/types";

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

export interface DuplicateExpenseSeed {
  description: string;
  vendor: string;
  categoryId: number | "";
  amount: number | "";
}

/**
 * "Add expense" as a popup on the Records page — see AddSalesModal for why
 * this doesn't reuse the full-page AddExpense.tsx. That page's first-expense
 * celebration doesn't come along either: a full-screen "you did it" moment
 * doesn't fit inside a modal that's about to close, and it still fires the
 * first time an owner uses the full-page route (Quick Add, Dashboard's empty
 * state) if they never happen to use this popup first.
 *
 * The same modal doubles as Edit and Duplicate: passing `recordId` switches
 * it to fetch-and-PATCH an existing record; passing `duplicateFrom` seeds a
 * fresh (POST) form from another record's fields without carrying its id or
 * date along. Both still go through the one set of fields and one submit
 * path, which is what keeps them behaving identically to Add in every way
 * that isn't the point of the difference.
 */
export function AddExpenseModal({
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
  duplicateFrom?: DuplicateExpenseSeed;
}) {
  const toast = useToast();
  const editing = recordId !== undefined;
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [origin, setOrigin] = useState<RecordDetail["origin"]>(null);
  const [originAmount, setOriginAmount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // Errors appear on blur only for fields the owner has already left, so the
  // form doesn't turn red under a cursor that is still on the first input.
  const [touched, setTouched] = useState<Partial<Record<keyof FieldErrors, boolean>>>({});

  function reset() {
    setCategoryId("");
    setDate(today());
    setDescription("");
    setVendor("");
    setAmount("");
    setOrigin(null);
    setOriginAmount(0);
    setError(null);
    setFieldErrors({});
    setTouched({});
  }

  // Re-seeds every time the modal opens, from whichever of the three modes
  // (blank Add, edit-existing, duplicate-from) it was opened in — the modal
  // stays mounted the whole time (see Modal.tsx), so nothing else clears a
  // previous open's fields on its own.
  useEffect(() => {
    if (!open) return;
    reset();
    if (editing && recordId !== undefined) {
      setLoading(true);
      api
        .get<RecordDetail>(`/records/expenses/${recordId}`)
        .then(({ data }) => {
          setCategoryId(data.categoryId ?? "");
          setDate(data.date.slice(0, 10));
          setDescription(data.description);
          setVendor(data.vendor ?? "");
          setAmount(data.amount);
          setOrigin(data.origin);
          setOriginAmount(data.amount);
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false));
    } else if (duplicateFrom) {
      setCategoryId(duplicateFrom.categoryId);
      setDescription(duplicateFrom.description);
      setVendor(duplicateFrom.vendor);
      setAmount(duplicateFrom.amount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recordId]);

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

  function handleClose() {
    onClose();
    reset();
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
      const payload = {
        categoryId,
        date,
        description,
        vendor: vendor || (editing ? null : undefined),
        amount,
      };
      if (editing && recordId !== undefined) {
        await api.patch(`/records/expenses/${recordId}`, payload);
        toast("Changes saved");
      } else {
        await api.post("/records/expenses", { businessProfileId, ...payload });
        toast("Expense saved");
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

  /*
    Whether the amount still matches the receipt it was scanned from.

    Editing the amount on a scanned record is allowed — the owner may well be
    correcting a figure OCR got wrong. But it silently breaks the arithmetic
    the note below points at, so it is worth saying out loud rather than
    leaving the two to disagree on screen. A warning, never a block: the
    record is the owner's, not the scanner's.
  */
  const scanned = origin?.kind === "receipt_scan" ? origin : null;
  const amountDrifted =
    scanned !== null && amount !== "" && Math.round(Number(amount) * 100) !== Math.round(originAmount * 100);

  return (
    <Modal open={open} onClose={handleClose} title={editing ? "Edit expense" : "Add expense"}>
      {/* noValidate hands validation to the code above; see handleSubmit. */}
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {loading ? <p className="text-sm text-ink-500">Loading…</p> : null}
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
        {/*
          A condensed stand-in for the full-page RecordOriginPanel — this
          modal has no room for the item table or the receipt photo, but
          losing all trace that the record came off a scan would leave the
          owner guessing why the amount looks oddly specific. The full
          breakdown is one click away on the record's own edit page.
        */}
        {scanned ? (
          <Callout tone="info">
            From a scanned receipt, scanned {new Date(scanned.scannedAt).toLocaleDateString()}
            {scanned.extractedVendor ? ` · ${scanned.extractedVendor}` : ""}
            {scanned.items.length > 0 ? ` · ${scanned.items.length} item${scanned.items.length === 1 ? "" : "s"}` : ""}.{" "}
            <a
              href={`/records/expenses/${recordId}/edit`}
              className="tap-inline font-medium underline-offset-2 hover:underline"
            >
              View the full breakdown
            </a>
          </Callout>
        ) : null}
        {amountDrifted ? (
          <Callout tone="warn">
            This no longer matches the receipt breakdown, which comes to{" "}
            <Money value={originAmount} decimals />. Saving is fine — the breakdown will just no longer
            add up to the record.
          </Callout>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting || loading}>
          {submitting ? "Saving…" : editing ? "Save changes" : "Save expense"}
        </Button>
      </form>
    </Modal>
  );
}
