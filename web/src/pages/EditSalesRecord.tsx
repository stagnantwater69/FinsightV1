import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordItem } from "../lib/types";
import { Callout, FormPage } from "../components/ui";
import { Button, ButtonLink } from "../components/Button";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { FIELD_LIMITS } from "../lib/fieldLimits";

export function EditSalesRecord() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [record, setRecord] = useState<RecordItem | null>(null);
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  /*
    The read, with both endings handled — see the matching note on EditExpense.
    A deleted record (404) or a lapsed session (403) has to say so; a response
    arriving after unmount, or after Retry has queued a newer request, is
    dropped rather than written into state.
  */
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .get<RecordItem>(`/records/sales/${id}`)
      .then(({ data }) => {
        if (cancelled) return;
        setRecord(data);
        setDate(data.date.slice(0, 10));
        setDescription(data.description);
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
    if (amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      await api.patch(`/records/sales/${id}`, { date, description, amount });
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
      <FormPage eyebrow="Records" title="Edit sales reference">
        <Callout tone="warn">
          <b className="font-semibold">Couldn't load this sales reference.</b> {loadError}
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

  return (
    <FormPage eyebrow="Records" title="Edit sales reference">
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
          {submitting ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </FormPage>
  );
}
