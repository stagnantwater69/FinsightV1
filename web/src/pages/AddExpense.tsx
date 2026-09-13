import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { CategorySelect } from "../components/CategorySelect";
import { Celebration } from "../components/Confirmation";
import { hasCelebratedFirstRecord, markFirstRecordCelebrated } from "../components/Confirmation";
import { Button, ButtonLink } from "../components/Button";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { Money } from "../components/Money";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { CategorySuggestion, RecordItem } from "../lib/types";
import { FormPage } from "../components/ui";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { todayIso as today } from "../lib/dates";
import { ResultDetails } from "../components/ResultDetails";

interface DuplicateExpenseState {
  description: string;
  vendor: string;
  categoryId?: number;
  amount: number;
}

export function AddExpense() {
  const { selected } = useBusinessProfiles();
  return <AddExpenseForm key={selected?.id ?? "no-profile"} />;
}

function AddExpenseForm() {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  // Prefilled by the "Duplicate" action on Records — the date is left at
  // today() below rather than copied, since a duplicate is almost always
  // "the same thing, today".
  const duplicateFrom = (useLocation().state as { duplicateFrom?: DuplicateExpenseState } | null)?.duplicateFrom;
  const [categoryId, setCategoryId] = useState<number | "">(duplicateFrom?.categoryId ?? "");
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState(duplicateFrom?.description ?? "");
  const [vendor, setVendor] = useState(duplicateFrom?.vendor ?? "");
  const [amount, setAmount] = useState<number | "">(duplicateFrom?.amount ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Peak-End: the first expense a business ever records is the moment the
  // product becomes true for this owner. It earns a real confirmation screen
  // rather than a silent redirect back to an empty list.
  const [firstRecord, setFirstRecord] = useState<RecordItem | null>(null);
  const [suggestion, setSuggestion] = useState<CategorySuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const suggestionRequest = useRef<AbortController | null>(null);
  const savePending = useRef(false);

  useEffect(() => {
    setSuggestion(null);
    setSuggestionError(null);
    setSuggesting(false);
    suggestionRequest.current?.abort();
    return () => suggestionRequest.current?.abort();
  }, [description, vendor, categoryId]);

  async function suggestCategory() {
    if (!selected || suggesting || !description.trim()) return;
    const controller = new AbortController();
    suggestionRequest.current?.abort();
    suggestionRequest.current = controller;
    setSuggesting(true);
    setSuggestionError(null);
    try {
      const { data } = await api.post<{ suggestion: CategorySuggestion | null }>("/ai/suggest-category", {
        businessProfileId: selected.id,
        description: description.trim(),
        ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSuggestion(data.suggestion);
      if (!data.suggestion) setSuggestionError("No clear match. Choose a category above.");
    } catch {
      if (!controller.signal.aborted) setSuggestionError("Suggestions are unavailable. Choose a category above.");
    } finally {
      if (!controller.signal.aborted) setSuggesting(false);
    }
  }

  if (!selected) return <NoBusinessProfile />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!categoryId || amount === "" || savePending.current) return;
    savePending.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await api.post<RecordItem>("/records/expenses", {
        businessProfileId: selected!.id,
        categoryId,
        date,
        description,
        vendor: vendor || undefined,
        amount,
      });

      // Only celebrate if this business has never done it before.
      //
      // The localStorage check runs FIRST because it is free and it is false
      // for every save after the first. Previously the /records/search call
      // came first, so every single save fetched the business's entire expense
      // history purely to answer a boolean that had already been decided.
      let isFirst = false;
      if (!hasCelebratedFirstRecord(selected!.id)) {
        const existing = await api.get<{ items: RecordItem[]; nextCursor: string | null }>("/records/search", {
          params: { businessProfileId: selected!.id, type: "expense", limit: 2 },
        });
        isFirst = existing.data.items.length <= 1;
      }

      if (isFirst) {
        markFirstRecordCelebrated(selected!.id);
        setFirstRecord(data);
        return;
      }
      toast("Expense saved");
      navigate("/records");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      savePending.current = false;
      setSubmitting(false);
    }
  }

  if (firstRecord) {
    return (
      <div className="mx-auto w-full max-w-md">
        <Celebration
          title="That's your first expense recorded"
          action={
            <>
              <ButtonLink to="/dashboard" variant="primary">
                See your dashboard
              </ButtonLink>
              <ButtonLink to="/records/expenses/new" variant="secondary">
                Add another
              </ButtonLink>
            </>
          }
        >
          <span className="block">
            <strong className="text-ink-800">{firstRecord.description}</strong> —{" "}
            <Money value={firstRecord.amount} />
          </span>
          <span className="mt-2 block">
            Keep going for a few days and FinSight can start showing you where your money actually goes.
          </span>
        </Celebration>
        <p className="mt-4 text-center text-sm">
          <Link to="/records" className="tap-inline font-medium text-brand-700 hover:text-brand-800">
            Back to all records
          </Link>
        </p>
      </div>
    );
  }

  return (
    <FormPage eyebrow="Records" title="Add expense">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Category" htmlFor="category" required>
          <CategorySelect id="category" value={categoryId} onChange={setCategoryId} />
        </Field>
        <Field label="Date" htmlFor="date" required>
          <TextInput type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="description" required>
          <TextInput
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Rice sacks"
            maxLength={FIELD_LIMITS.recordDescription}
          />
        </Field>
        <Field label="Vendor" htmlFor="vendor" optional>
          <TextInput value={vendor} onChange={(e) => setVendor(e.target.value)}
            maxLength={FIELD_LIMITS.vendor}
          />
        </Field>
        {description.trim() ? (
          <div className="space-y-1 text-sm text-ink-700">
            <Button type="button" variant="secondary" onClick={suggestCategory} disabled={suggesting || submitting}>
              {suggesting ? "Finding a category…" : "Suggest a category"}
            </Button>
            {suggestion ? (
              <div className="mt-2">
                <p>Suggested: <strong>{suggestion.categoryName}</strong></p>
                <Button type="button" variant="secondary" onClick={() => setCategoryId(suggestion.categoryId)} disabled={submitting}>
                  Apply suggestion
                </Button>
                <ResultDetails label="Category suggestion details">
                  <p>{suggestion.source === "history" ? "Based on your previously saved choices." : "Based on your description and vendor."} Check that the category fits before saving.</p>
                </ResultDetails>
              </div>
            ) : null}
            {suggestionError ? <p role="status" className="text-xs text-ink-500">{suggestionError}</p> : null}
          </div>
        ) : null}
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
          {submitting ? "Saving…" : "Save expense"}
        </Button>
      </form>
    </FormPage>
  );
}
