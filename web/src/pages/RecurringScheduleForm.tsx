import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { CategorySelect } from "../components/CategorySelect";
import { Button } from "../components/Button";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Checkbox, Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { FormPage, InfoNote } from "../components/ui";
import { formatDueDate } from "../components/RecurringAgenda";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import type { RecurringSchedule } from "../lib/types";

/**
 * Declaring and editing a recurring payment.
 *
 * The two screens share one form because they are the same form — the only
 * differences are where the initial values come from, which verb the submit
 * button uses, and whether deleting is on offer. Splitting them into two files
 * the way AddExpense/EditExpense are split would mean maintaining the interval
 * bound, the tolerance note and the date convention in two places.
 *
 * WHY AN OWNER CAN CREATE ONE FROM NOTHING: the detector needs three
 * observations before it will suggest a pattern, which is two months of waiting
 * for a monthly bill. An owner who already knows the rent is due on the 5th
 * should not have to prove it to FinSight first.
 */

/** Today as `YYYY-MM-DD` — what `<input type="date">` binds to. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

interface FormValues {
  label: string;
  vendor: string;
  categoryId: number | "";
  intervalDays: number | "";
  expectedAmount: number | "";
  nextDueDate: string;
  isActive: boolean;
}

const EMPTY: FormValues = {
  label: "",
  vendor: "",
  categoryId: "",
  intervalDays: 30,
  expectedAmount: "",
  nextDueDate: today(),
  isActive: true,
};

function ScheduleFields({
  values,
  onChange,
}: {
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
}) {
  return (
    <>
      <Field
        label="What is it?"
        htmlFor="label"
        required
        hint="What you call this payment. FinSight matches your records against it, so keep it close to how you describe the expense — “Shop rent”, “Staff salary”."
      >
        <TextInput
          id="label"
          required
          value={values.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="e.g. Shop rent"
          maxLength={FIELD_LIMITS.recurringScheduleLabel}
        />
      </Field>

      <Field label="Category" htmlFor="category" required>
        <CategorySelect
          id="category"
          value={values.categoryId}
          onChange={(categoryId) => onChange({ categoryId })}
        />
      </Field>

      <Field label="Paid to" htmlFor="vendor" optional>
        <TextInput
          id="vendor"
          value={values.vendor}
          onChange={(e) => onChange({ vendor: e.target.value })}
          maxLength={FIELD_LIMITS.vendor}
        />
      </Field>

      <Field
        label="Expected amount"
        htmlFor="expectedAmount"
        required
        hint="Roughly what it usually comes to. FinSight allows a margin either side before it says anything."
      >
        <MoneyInput
          id="expectedAmount"
          min={0.01}
          required
          value={values.expectedAmount}
          onChange={(e) => onChange({ expectedAmount: e.target.value === "" ? "" : Number(e.target.value) })}
        />
      </Field>

      <Field
        label="How often, in days"
        htmlFor="intervalDays"
        required
        hint="7 for weekly, 30 for monthly, 90 for quarterly."
      >
        <TextInput
          id="intervalDays"
          type="number"
          min={1}
          // Matches the server's own bound: a schedule longer than annual would
          // raise its first finding after the owner's planning horizon.
          max={366}
          step={1}
          required
          value={values.intervalDays}
          onChange={(e) => onChange({ intervalDays: e.target.value === "" ? "" : Number(e.target.value) })}
        />
      </Field>

      <Field
        label="Next due"
        htmlFor="nextDueDate"
        required
        hint="The next date you expect to pay it. FinSight moves this forward on its own once it sees a matching record."
      >
        <TextInput
          id="nextDueDate"
          type="date"
          required
          value={values.nextDueDate}
          onChange={(e) => onChange({ nextDueDate: e.target.value })}
        />
      </Field>

      <Checkbox
        label="Watch this payment"
        hint="Turn this off to pause it — the schedule stays, FinSight just stops telling you when it's late."
        checked={values.isActive}
        onChange={(isActive) => onChange({ isActive })}
      />
    </>
  );
}

/** True once every required field holds something the server will accept. */
function isComplete(values: FormValues) {
  return (
    values.label.trim() !== "" &&
    values.categoryId !== "" &&
    values.expectedAmount !== "" &&
    values.intervalDays !== "" &&
    values.nextDueDate !== ""
  );
}

export function AddRecurringSchedule() {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!selected) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isComplete(values)) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/insights/recurring-schedules", {
        businessProfileId: selected!.id,
        categoryId: values.categoryId,
        label: values.label.trim(),
        vendor: values.vendor.trim() || undefined,
        intervalDays: values.intervalDays,
        expectedAmount: values.expectedAmount,
        nextDueDate: values.nextDueDate,
        isActive: values.isActive,
      });
      toast("Recurring payment added");
      navigate("/insights/expense-behavior");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormPage
      eyebrow="Insights"
      title="Add a recurring payment"
      subtitle="Tell FinSight about something that repeats, and it will say so when one is late or comes in at an amount you did not expect."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <ScheduleFields values={values} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} />
        <InfoNote>
          FinSight will not create the expense record for you. It watches for the one you record, and
          tells you when it hasn't arrived.
        </InfoNote>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save recurring payment"}
        </Button>
      </form>
    </FormPage>
  );
}

export function EditRecurringSchedule() {
  const { id } = useParams<{ id: string }>();
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [schedule, setSchedule] = useState<RecurringSchedule | null>(null);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
   * Read from the agenda list rather than a per-id endpoint, because the API
   * deliberately has no `GET /recurring-schedules/:id` — an owner keeps a
   * handful of these, so the list is a small payload and one fewer route is one
   * fewer place for the ownership scoping to be got wrong. A schedule belonging
   * to someone else simply is not in it.
   */
  const profileId = selected?.id;

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    api
      .get<RecurringSchedule[]>("/insights/recurring-schedules", {
        params: { businessProfileId: profileId },
      })
      .then(({ data }) => {
        if (cancelled) return;
        const found = data.find((row) => String(row.id) === id);
        if (!found) {
          setLoadError("That recurring payment no longer exists.");
          return;
        }
        setSchedule(found);
        setValues({
          label: found.label,
          vendor: found.vendor ?? "",
          categoryId: found.categoryId,
          intervalDays: found.intervalDays,
          expectedAmount: found.expectedAmount,
          // Date-only column: slice the ISO string rather than going through a
          // local-time Date, which would hand the input the previous day.
          nextDueDate: found.nextDueDate.slice(0, 10),
          isActive: found.isActive,
        });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, profileId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isComplete(values)) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.patch(`/insights/recurring-schedules/${id}`, {
        categoryId: values.categoryId,
        label: values.label.trim(),
        vendor: values.vendor.trim() || null,
        intervalDays: values.intervalDays,
        expectedAmount: values.expectedAmount,
        nextDueDate: values.nextDueDate,
        isActive: values.isActive,
      });
      toast("Changes saved");
      navigate("/insights/expense-behavior");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Stop watching this payment?",
      body: (
        <>
          FinSight will forget <b className="font-semibold">{values.label}</b> and stop telling you when
          it's late. Your expense records are not affected. If you only want to stop the alerts for now,
          untick “Watch this payment” and save instead.
        </>
      ),
      confirmLabel: "Delete schedule",
    });
    if (!ok) return;
    setError(null);
    try {
      await api.delete(`/insights/recurring-schedules/${id}`);
      toast("Recurring payment deleted");
      navigate("/insights/expense-behavior");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (loadError) return <p className="text-sm text-tone-danger">{loadError}</p>;
  if (!selected || !schedule) return <p className="text-sm text-ink-500">Loading…</p>;

  return (
    <FormPage
      eyebrow="Insights"
      title="Edit recurring payment"
      subtitle={
        schedule.lastRecordedDate
          ? `Last matching record: ${formatDueDate(schedule.lastRecordedDate)}.`
          : "FinSight hasn't matched a record to this one yet."
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <ScheduleFields values={values} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} />
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
        {/* Outlined danger, never a fill — the destructive path must not look
            like the primary one. */}
        <Button type="button" variant="danger" fullWidth onClick={handleDelete}>
          Delete this schedule
        </Button>
      </form>
    </FormPage>
  );
}
