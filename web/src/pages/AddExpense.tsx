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
import { ResultDetails } from "../components/ResultDetails";
import { TransactionDateField, useTransactionDate } from "../components/TransactionDateField";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../components/AvailableFundsBaselineChoice";
import { useAuth } from "../context/AuthContext";
import { useManualRecordCreate } from "../lib/useManualRecordCreate";
import { ManualCreateRecovery } from "../components/ManualCreateRecovery";

interface DuplicateExpenseState {
  description: string;
  vendor: string;
  categoryId?: number;
  amount: number;
}

export function AddExpense() {
  const { selected } = useBusinessProfiles();
  const { profile } = useAuth();
  return <AddExpenseForm key={`${profile?.id}:${selected?.id}`} />;
}

function AddExpenseForm() {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  // Prefilled by the "Duplicate" action on Records. The date starts at today
  // rather than being copied, since a duplicate is almost always "the same
  // thing, today".
  const duplicateFrom = (useLocation().state as { duplicateFrom?: DuplicateExpenseState } | null)?.duplicateFrom;
  const [categoryId, setCategoryId] = useState<number | "">(duplicateFrom?.categoryId ?? "");
  const dateField = useTransactionDate();
  const baselineChoice = useAvailableFundsBaselineChoice(dateField.date);
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
  const confirmedSave = useRef(false);
  const recovery = useManualRecordCreate(selected?.id, "expense");
  const formScope = `${recovery.ownerId}:${selected?.id}`;
  const currentScope = useRef(formScope);
  currentScope.current = formScope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const frozenBody = recovery.pending?.body ?? recovery.deferredDraft;
  const setTransactionDate = dateField.setDate;
  useEffect(() => {
    if (!frozenBody) return;
    setCategoryId(frozenBody.categoryId ?? "");
    setTransactionDate(frozenBody.date);
    setDescription(frozenBody.description); setVendor(frozenBody.vendor ?? ""); setAmount(frozenBody.amount);
  }, [frozenBody, setTransactionDate]);

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
    if (confirmedSave.current || savePending.current || recovery.busy || recovery.loading) return;
    if (!recovery.pending && (!categoryId || amount === "" || !dateField.check() || !baselineChoice.check())) return;
    const requestScope = formScope;
    const isCurrent = () => mounted.current && currentScope.current === requestScope;
    savePending.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const data = await recovery.save(recovery.pending?.body ?? {
        businessProfileId: selected!.id,
        categoryId: Number(categoryId),
        date: dateField.date,
        description,
        vendor: vendor || undefined,
        amount: Number(amount),
        ...baselineChoice.requestFields(),
      });
      if (!data || !isCurrent()) return;
      confirmedSave.current = true;

      // Only celebrate if this business has never done it before.
      //
      // The localStorage check runs FIRST because it is free and it is false
      // for every save after the first. Previously the /records/search call
      // came first, so every single save fetched the business's entire expense
      // history purely to answer a boolean that had already been decided.
      let isFirst = false;
      try {
        if (!hasCelebratedFirstRecord(selected!.id)) {
          const existing = await api.get<{ items: RecordItem[]; nextCursor: string | null }>("/records/search", {
            params: { businessProfileId: selected!.id, type: "expense", limit: 2 },
          });
          isFirst = existing.data.items.length <= 1;
        }
      } catch { /* An optional celebration lookup cannot change a confirmed save. */ }
      if (!isCurrent()) return;

      if (isFirst) {
        try { markFirstRecordCelebrated(selected!.id); } catch { /* Saving the milestone is optional. */ }
        setFirstRecord(data);
        return;
      }
      toast("Expense saved");
      navigate("/records");
    } catch (err) {
      if (!isCurrent()) return;
      if (confirmedSave.current) { setError("Your expense is saved. Open Records to see it."); return; }
      if (recovery.pending || (!dateField.absorb(err) && !(await baselineChoice.absorb(err, isCurrent)))) {
        if (isCurrent()) setError(getErrorMessage(err));
      }
    } finally {
      savePending.current = false;
      if (isCurrent()) setSubmitting(false);
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
              <Button type="button" variant="secondary" onClick={() => {
                confirmedSave.current = false; setFirstRecord(null); setCategoryId(""); setDescription("");
                setVendor(""); setAmount(""); setError(null); dateField.setDate(dateField.today); baselineChoice.setDecision(null);
              }}>
                Add another
              </Button>
            </>
          }
        >
          <span className="block">
            <strong className="text-ink-800">{firstRecord.description}</strong> —{" "}
            <Money value={firstRecord.amount} />
          </span>

        </Celebration>
        <p className="mt-4 text-center text-sm">
          <Link to="/records" className="tap-inline link-action">
            Back to all records
          </Link>
        </p>
      </div>
    );
  }

  return (
    <FormPage eyebrow="Records" title="Add expense">
      <form onSubmit={handleSubmit} className="space-y-4">
        <ManualCreateRecovery recovery={recovery} />
        <fieldset className="min-w-0 space-y-4" disabled={submitting || recovery.loading || recovery.frozen}>
        <Field label="Category" htmlFor="category" required>
          <CategorySelect id="category" value={categoryId} onChange={setCategoryId} />
        </Field>
        <TransactionDateField field={dateField} />
        {!recovery.pending ? <AvailableFundsBaselineChoice choice={baselineChoice} disabled={submitting} /> : null}
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
        </fieldset>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={confirmedSave.current || submitting || recovery.busy || recovery.loading || recovery.corrupt || (!recovery.pending && dateField.invalid)}>
          {submitting ? "Saving…" : recovery.pending?.confirmedRecord ? "Finish recovery" : recovery.pending ? "Retry original save" : "Save expense"}
        </Button>
      </form>
    </FormPage>
  );
}
