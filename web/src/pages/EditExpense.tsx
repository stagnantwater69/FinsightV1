import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CategorySelect } from "../components/CategorySelect";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordDetail } from "../lib/types";
import { Callout, FormPage } from "../components/ui";
import { Button } from "../components/Button";
import { RecordOriginPanel } from "../components/RecordOriginPanel";
import { Money } from "../components/Money";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { FIELD_LIMITS } from "../lib/fieldLimits";

export function EditExpense() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<RecordDetail>(`/records/expenses/${id}`).then(({ data }) => {
      setRecord(data);
      setCategoryId(data.categoryId ?? "");
      setDate(data.date.slice(0, 10));
      setDescription(data.description);
      setVendor(data.vendor ?? "");
      setAmount(data.amount);
    });
  }, [id]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!categoryId || amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      await api.patch(`/records/expenses/${id}`, {
        categoryId,
        date,
        description,
        vendor: vendor || null,
        amount,
      });
      toast("Changes saved");
      navigate("/records");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!record) {
    return <p className="text-sm text-ink-500">Loading…</p>;
  }

  /*
    Whether the amount still matches the detail behind it.

    Editing the amount on a scanned record is allowed — the owner may well be
    correcting a figure OCR got wrong. But it silently breaks the arithmetic
    the panel above shows, so it is worth saying out loud rather than leaving
    the two to disagree on screen. A warning, never a block: the record is the
    owner's, not the scanner's.
  */
  const scannedItems = record.origin?.kind === "receipt_scan" ? record.origin : null;
  const amountDrifted =
    scannedItems !== null && amount !== "" && Math.round(Number(amount) * 100) !== Math.round(record.amount * 100);

  return (
    <FormPage
      eyebrow="Records"
      title="Edit expense"
      aside={
        record.origin ? (
          <RecordOriginPanel origin={record.origin} recordAmount={record.amount} />
        ) : undefined
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Category" htmlFor="category" required>
          <CategorySelect id="category" value={categoryId} onChange={setCategoryId} />
        </Field>
        <Field label="Date" htmlFor="date" required>
          <TextInput type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="description" required>
          <TextInput required value={description} onChange={(e) => setDescription(e.target.value)}
            maxLength={FIELD_LIMITS.recordDescription}
          />
        </Field>
        <Field label="Vendor" htmlFor="vendor" optional>
          <TextInput value={vendor} onChange={(e) => setVendor(e.target.value)}
            maxLength={FIELD_LIMITS.vendor}
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
        {amountDrifted ? (
          <Callout tone="warn">
            This no longer matches the receipt breakdown, which comes to{" "}
            <Money value={record.amount} decimals />. Saving is fine — the breakdown will just no longer
            add up to the record.
          </Callout>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </FormPage>
  );
}
