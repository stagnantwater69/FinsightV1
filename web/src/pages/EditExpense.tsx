import { useEffect, useRef, useState, type FormEvent } from "react";
import { FileSpreadsheet, PenLine, ReceiptText } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { CategorySelect } from "../components/CategorySelect";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { RECORD_SOURCE_LABELS, type RecordDetail, type RecordSource } from "../lib/types";
import { formatCalendarDate } from "../lib/dates";
import { DuplicateReviewModal } from "../components/DuplicateReviewModal";
import { Callout, Card, FormPage } from "../components/ui";
import { useResolveDuplicate } from "../components/useResolveDuplicate";
import { sharedFields } from "../lib/duplicateMatch";
import { SkeletonFormFields } from "../components/Skeleton";
import { Button, ButtonLink } from "../components/Button";
import { RecordOriginPanel } from "../components/RecordOriginPanel";
import { ReviewReason } from "../components/LargeExpenseReason";
import { Money, formatMoney } from "../components/Money";
import { useToast } from "../components/Toast";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { TransactionDateField, useTransactionDate } from "../components/TransactionDateField";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../components/AvailableFundsBaselineChoice";

export function EditExpense() {
  const { selected } = useBusinessProfiles();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const dateField = useTransactionDate("");
  const baselineChoice = useAvailableFundsBaselineChoice(dateField.date);
  const setBaselineFromRecord = baselineChoice.setFromRecord;
  const setLoadedDate = dateField.setDate;
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
        setLoadedDate(data.date.slice(0, 10));
        setDescription(data.description);
        setVendor(data.vendor ?? "");
        setAmount(data.amount);
        setBaselineFromRecord(
          data.includedInAvailableFundsBaseline ?? null,
          data.availableFundsDeltaBaselineAt,
        );
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt, setLoadedDate, setBaselineFromRecord]);

  // A Repeat? names its original, so the page shows it instead of sending the owner to look for it.
  const [twin, setTwin] = useState<RecordDetail | null>(null);
  const [comparing, setComparing] = useState(false);
  const [showTwin, setShowTwin] = useState(false);
  const twinCard = useRef<HTMLDivElement>(null);
  const resolver = useResolveDuplicate((outcome) => {
    if (outcome === "deleted") navigate("/records");
    else {
      setShowTwin(false);
      setAttempt((n) => n + 1);
    }
  });
  useEffect(() => {
    if (showTwin) twinCard.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [showTwin]);
  const twinId = record?.duplicateStatus === "Flagged" ? record.duplicateOfRecordId : null;
  useEffect(() => {
    setTwin(null);
    if (!twinId) return;
    let cancelled = false;
    api
      .get<RecordDetail>(`/records/expenses/${twinId}`)
      .then(({ data }) => {
        if (!cancelled) setTwin(data);
      })
      // The original may have been deleted since; the plain reason below still stands.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [twinId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dateField.check() || !baselineChoice.check()) return;
    if (!categoryId || amount === "") return;
    setError(null);
    setSubmitting(true);
    try {
      await api.patch(
        `/records/expenses/${id}`,
        {
          categoryId,
          date: dateField.date,
          description,
          vendor: vendor || null,
          amount,
          ...baselineChoice.requestFields(),
        },
        { serverStateScope: { businessProfileId: selected!.id } },
      );
      toast("Changes saved");
      navigate("/records");
    } catch (err) {
      if (!dateField.absorb(err) && !(await baselineChoice.absorb(err))) setError(getErrorMessage(err));
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
    return (
      <FormPage eyebrow="Records" title="Edit expense">
        <SkeletonFormFields />
      </FormPage>
    );
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

  // The other record's row is marked only when it came in on the same file.
  const twinInSameFile =
    twin?.origin?.kind === "csv_import" && record.origin?.kind === "csv_import" && twin.origin.batchId === record.origin.batchId;

  return (
    <FormPage
      eyebrow="Records"
      title="Edit expense"
      aside={
        record.origin ? (
          <RecordOriginPanel
            origin={record.origin}
            recordAmount={record.amount}
            expenseId={record.id}
            otherExpenseId={showTwin && twin && twinInSameFile ? twin.id : undefined}
          />
        ) : undefined
      }
      below={showTwin && twin ? (
        <div ref={twinCard}>
          <TwinCard
            record={record}
            twin={twin}
            inSameFile={twinInSameFile}
            busy={resolver.busy}
            error={resolver.error}
            onKeep={() => void resolver.keep(record)}
            onDelete={() => void resolver.discard(record, true)}
          />
        </div>
      ) : undefined}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {record.duplicateStatus === "Flagged" || record.reviewStatus === "Needs Review" ? (
          <Callout tone="warn">
            <b className="block font-semibold">
              {record.duplicateStatus === "Flagged" ? "Why this is marked Repeat?" : "Why this is marked Check"}
            </b>{" "}
            {twin ? (
              <>
                It has the same {sharedFields(record, twin)} as another expense.
                {/* One line per fact: a receipt's description is a list of items and
                    would otherwise fill the note; the full text is under "Show the other record". */}
                <span className="mt-2.5 flex items-center gap-3 rounded-xl bg-paper px-3 py-2.5 ring-1 ring-paper-200">
                  <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tint-brand text-tone-brand">
                    <SourceIcon source={twin.source} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-900" title={twin.description}>
                      {twin.description}
                    </span>
                    <span className="block truncate text-xs text-ink-600">
                      {RECORD_SOURCE_LABELS[twin.source as RecordSource] ?? twin.source} · {formatCalendarDate(twin.date)}
                      {twin.vendor ? ` · ${twin.vendor}` : ""}
                    </span>
                  </span>
                  <span className="figure shrink-0 text-sm font-semibold text-ink-900">{formatMoney(twin.amount, { decimals: true })}</span>
                </span>
                <span className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => setComparing(true)}>
                    Compare and decide
                  </Button>
                  <button
                    type="button"
                    aria-expanded={showTwin}
                    onClick={() => setShowTwin((v) => !v)}
                    className="tap-inline text-sm link-action"
                  >
                    {showTwin ? "Hide the other record" : "Show the other record"}
                  </button>
                </span>
              </>
            ) : (
              <ReviewReason record={record} profile={selected ?? null} />
            )}
          </Callout>
        ) : null}
        <Field label="Category" htmlFor="category" required>
          <CategorySelect id="category" value={categoryId} onChange={setCategoryId} />
        </Field>
        <TransactionDateField field={dateField} />
        <AvailableFundsBaselineChoice choice={baselineChoice} disabled={submitting} />
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
        <Button type="submit" variant="primary" fullWidth disabled={submitting || dateField.invalid}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
      </form>
      <DuplicateReviewModal
        recordId={record.id}
        recordType="expense"
        open={comparing}
        onClose={() => setComparing(false)}
        // "Keep both" leaves this record to reload; "Delete this copy" leaves nothing here to show.
        onResolved={() => {
          setComparing(false);
          api.get(`/records/expenses/${id}`).then(() => setAttempt((n) => n + 1), () => navigate("/records"));
        }}
      />
    </FormPage>
  );
}

/** The record a Repeat? matches, under the form, so both can be read without leaving the page. */
function TwinCard({
  record,
  twin,
  inSameFile,
  busy,
  error,
  onKeep,
  onDelete,
}: {
  record: RecordDetail;
  twin: RecordDetail;
  inSameFile: boolean;
  busy: boolean;
  error: string | null;
  onKeep: () => void;
  onDelete: () => void;
}) {
  const differs = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() !== String(b ?? "").trim().toLowerCase();
  const addedAt = (r: RecordDetail) =>
    new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const rows: { label: string; value: string; differs: boolean }[] = [
    { label: "Description", value: twin.description, differs: differs(twin.description, record.description) },
    { label: "Date", value: formatCalendarDate(twin.date), differs: twin.date.slice(0, 10) !== record.date.slice(0, 10) },
    { label: "Amount", value: formatMoney(twin.amount, { decimals: true }), differs: twin.amount !== record.amount },
    { label: "Vendor", value: twin.vendor || "None", differs: differs(twin.vendor, record.vendor) },
    { label: "Source", value: RECORD_SOURCE_LABELS[twin.source as RecordSource] ?? twin.source, differs: twin.source !== record.source },
    { label: "Added", value: addedAt(twin), differs: addedAt(twin) !== addedAt(record) },
  ];
  return (
    <Card className="max-w-xl p-6 sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-900">The other record</h2>
        <a href={`/records/expenses/${twin.id}/edit`} className="tap-inline text-xs link-action">
          Edit it
        </a>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-600">
        What differs from this one is in bold.
        {inSameFile ? " It came in on the same file; its row is marked in blue in File rows." : ""}
      </p>
      <dl className="mt-4 divide-y divide-paper-200 rounded-xl ring-1 ring-paper-200">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm">
            <dt className="text-xs text-ink-600">{row.label}</dt>
            <dd className={`[overflow-wrap:anywhere] ${row.differs ? "font-semibold text-ink-900" : "text-ink-600"}`}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {error ? <div className="mt-3"><FormError>{error}</FormError></div> : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onKeep}>
          Keep both
        </Button>
        <Button type="button" variant="danger" disabled={busy} onClick={onDelete}>
          Delete this copy
        </Button>
      </div>
    </Card>
  );
}

function SourceIcon({ source }: { source: string }) {
  const Icon = source === "RECEIPT_SCAN" ? ReceiptText : source === "CSV_UPLOAD" ? FileSpreadsheet : PenLine;
  return <Icon className="h-4 w-4" />;
}
