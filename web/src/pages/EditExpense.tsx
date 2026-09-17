import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CategorySelect } from "../components/CategorySelect";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordDetail } from "../lib/types";
import { Callout, FormPage } from "../components/ui";
import { Button, ButtonLink } from "../components/Button";
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  /*
    The read, with both endings handled.

    A record deleted from another tab answers 404 and a lapsed session answers
    403; without a catch the page held its "Loading…" line for the rest of the
    session. `cancelled` covers the other half — a response landing after the
    owner has navigated away, or after `attempt` has already started a newer
    request, must not overwrite what is on screen.
  */
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .get<RecordDetail>(`/records/expenses/${id}`)
      .then(({ data }) => {
        if (cancelled) return;
        setRecord(data);
        setCategoryId(data.categoryId ?? "");
        setDate(data.date.slice(0, 10));
        setDescription(data.description);
        setVendor(data.vendor ?? "");
        setAmount(data.amount);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

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

  if (loadError) {
    return (
      <FormPage eyebrow="Records" title="Edit expense">
        <Callout tone="warn">
          <b className="font-semibold">Couldn't load this expense.</b> {loadError}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
            <ButtonLink to="/records" variant="ghost" size="sm">
              Back to records
            </ButtonLink>
          </div>
        </Callout>
      </FormPage>
    );
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
