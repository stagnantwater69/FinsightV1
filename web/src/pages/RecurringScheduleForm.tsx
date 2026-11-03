import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { CategorySelect } from "../components/CategorySelect";
import { Button } from "../components/Button";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Checkbox, Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { FormPage, InfoNote } from "../components/ui";
import { Modal } from "../components/Modal";
import { formatDueDate } from "../components/RecurringAgenda";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { todayIso as today } from "../lib/dates";
import type { RecurringSchedule } from "../lib/types";
import { NoBusinessProfile } from "../components/NoBusinessProfile";

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

/** The repeat lengths most owners pick; anything else is "Custom". */
const REPEAT_PRESETS: { days: number; label: string }[] = [
  { days: 7, label: "Weekly" },
  { days: 14, label: "Every 2 weeks" },
  { days: 30, label: "Monthly" },
  { days: 90, label: "Quarterly" },
];

/*
 * Layout: the name alone on top (it is what the owner thinks of first), then
 * pairs that belong together, then how often. Pairs collapse to one column
 * below `sm` so the popup still works on a phone.
 */
function ScheduleFields({
  values,
  onChange,
}: {
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
}) {
  const presetMatch = REPEAT_PRESETS.some((preset) => preset.days === values.intervalDays);
  // Custom stays open once chosen, even if the typed number happens to equal a
  // preset, so the input does not vanish mid-typing.
  const [custom, setCustom] = useState(!presetMatch && values.intervalDays !== "");
  const showCustom = custom || !presetMatch;

  return (
    <>
      <Field
        label="Payment name"
        htmlFor="label"
        required
        hint="Use the words you write on the expense, so FinSight can match it."
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" htmlFor="category" required fillRow>
          <CategorySelect
            id="category"
            value={values.categoryId}
            onChange={(categoryId) => onChange({ categoryId })}
          />
        </Field>
        <Field label="Paid to" htmlFor="vendor" optional fillRow>
          <TextInput
            id="vendor"
            value={values.vendor}
            onChange={(e) => onChange({ vendor: e.target.value })}
            placeholder="e.g. landlord"
            maxLength={FIELD_LIMITS.vendor}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Usual amount" htmlFor="expectedAmount" required fillRow>
          <MoneyInput
            id="expectedAmount"
            min={0.01}
            required
            value={values.expectedAmount}
            onChange={(e) => onChange({ expectedAmount: e.target.value === "" ? "" : Number(e.target.value) })}
          />
        </Field>
        <Field label="Next due" htmlFor="nextDueDate" required fillRow>
          <TextInput
            id="nextDueDate"
            type="date"
            required
            value={values.nextDueDate}
            onChange={(e) => onChange({ nextDueDate: e.target.value })}
          />
        </Field>
      </div>

      <fieldset>
        <legend className="block text-sm font-medium text-ink-700">
          Repeats
          <span className="ml-1 text-tone-danger" title="Required">
            <span aria-hidden>*</span>
            <span className="sr-only">(required)</span>
          </span>
        </legend>
        <div
          className="mt-1.5 flex flex-wrap gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1"
        >
          {REPEAT_PRESETS.map((preset) => (
            <RepeatOption
              key={preset.days}
              active={!showCustom && values.intervalDays === preset.days}
              onClick={() => {
                setCustom(false);
                onChange({ intervalDays: preset.days });
              }}
            >
              {preset.label}
            </RepeatOption>
          ))}
          <RepeatOption active={showCustom} onClick={() => setCustom(true)}>
            Custom
          </RepeatOption>
        </div>
        {showCustom ? (
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="intervalDays" className="text-sm text-ink-700">
              Every
            </label>
            <TextInput
              id="intervalDays"
              type="number"
              min={1}
              // Matches the server's own bound: a schedule longer than annual would
              // raise its first finding after the owner's planning horizon.
              max={366}
              step={1}
              required
              className="w-24"
              value={values.intervalDays}
              onChange={(e) => onChange({ intervalDays: e.target.value === "" ? "" : Number(e.target.value) })}
            />
            <span className="text-sm text-ink-700">days</span>
          </div>
        ) : null}
      </fieldset>

      <Checkbox
        label="Watch this payment"
        hint="Untick to pause late alerts. The schedule stays."
        checked={values.isActive}
        onChange={(isActive) => onChange({ isActive })}
      />
    </>
  );
}

function RepeatOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`tap flex-1 whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        active ? "bg-paper text-tone-brand shadow-sm" : "text-ink-600 hover:text-tone-brand"
      }`}
    >
      {children}
    </button>
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

function valuesOf(schedule: RecurringSchedule): FormValues {
  return {
    label: schedule.label,
    vendor: schedule.vendor ?? "",
    categoryId: schedule.categoryId,
    intervalDays: schedule.intervalDays,
    expectedAmount: schedule.expectedAmount,
    // Date-only column: slice the ISO string rather than going through a
    // local-time Date, which would hand the input the previous day.
    nextDueDate: schedule.nextDueDate.slice(0, 10),
    isActive: schedule.isActive,
  };
}

/**
 * The add/edit form itself, without a page or a popup around it. `schedule`
 * null means "add". `onDone` runs after a successful save or delete; the
 * caller decides what happens next — a page navigates away, a popup closes
 * and refreshes the list behind it.
 */
function ScheduleForm({
  businessProfileId,
  schedule,
  onDone,
}: {
  businessProfileId: number;
  schedule: RecurringSchedule | null;
  onDone: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [values, setValues] = useState<FormValues>(() => (schedule ? valuesOf(schedule) : EMPTY));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isComplete(values)) return;
    setError(null);
    setSubmitting(true);
    try {
      if (schedule) {
        await api.patch(
          `/insights/recurring-schedules/${schedule.id}`,
          {
            categoryId: values.categoryId,
            label: values.label.trim(),
            vendor: values.vendor.trim() || null,
            intervalDays: values.intervalDays,
            expectedAmount: values.expectedAmount,
            nextDueDate: values.nextDueDate,
            isActive: values.isActive,
          },
          { serverStateScope: { businessProfileId } },
        );
        toast("Changes saved");
      } else {
        await api.post(
          "/insights/recurring-schedules",
          {
            businessProfileId,
            categoryId: values.categoryId,
            label: values.label.trim(),
            vendor: values.vendor.trim() || undefined,
            intervalDays: values.intervalDays,
            expectedAmount: values.expectedAmount,
            nextDueDate: values.nextDueDate,
            isActive: values.isActive,
          },
          { serverStateScope: { businessProfileId } },
        );
        toast("Recurring payment added");
      }
      onDone();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!schedule) return;
    const ok = await confirm({
      title: "Stop watching this payment?",
      body: (
        <>
          FinSight stops watching <b className="font-semibold">{values.label}</b>. Your expense records
          stay. To pause alerts instead, untick “Watch this payment” and save.
        </>
      ),
      confirmLabel: "Delete schedule",
    });
    if (!ok) return;
    setError(null);
    try {
      await api.delete(`/insights/recurring-schedules/${schedule.id}`, {
        serverStateScope: { businessProfileId },
      });
      toast("Recurring payment deleted");
      onDone();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ScheduleFields values={values} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} />
      {schedule ? null : (
        <InfoNote>FinSight won’t add the expense for you. It tells you when yours hasn’t come in.</InfoNote>
      )}
      {error ? <FormError>{error}</FormError> : null}
      <Button type="submit" variant="primary" fullWidth disabled={submitting}>
        {submitting ? "Saving…" : schedule ? "Save changes" : "Add payment"}
      </Button>
      {schedule ? (
        // Outlined danger, never a fill — the destructive path must not look
        // like the primary one.
        <Button type="button" variant="danger" fullWidth onClick={handleDelete}>
          Delete schedule
        </Button>
      ) : null}
    </form>
  );
}

function lastMatchText(schedule: RecurringSchedule) {
  return schedule.lastRecordedDate
    ? `Last matched expense: ${formatDueDate(schedule.lastRecordedDate)}.`
    : "No matching expense yet.";
}

/**
 * The same form in a popup, for the screens that list schedules — the
 * calendar, Expense insight and the recurring page — so adding or editing one
 * does not take the owner away from what they were looking at.
 *
 * `schedule` null with `open` true is "add". `onSaved` runs after a save or a
 * delete so the caller can refetch: a schedule's due state is
 * server-computed, never patched in on the client.
 */
export function ScheduleFormModal({
  open,
  schedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  schedule: RecurringSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { selected } = useBusinessProfiles();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={schedule ? "Edit recurring payment" : "Add a recurring payment"}
    >
      {/* Mounted only while open, and keyed on the schedule, so every opening
          starts from that schedule's saved values rather than the last edit. */}
      {open && selected ? (
        <div key={schedule?.id ?? "new"}>
          {schedule ? <p className="mb-4 text-sm text-ink-500">{lastMatchText(schedule)}</p> : null}
          <ScheduleForm
            businessProfileId={selected.id}
            schedule={schedule}
            onDone={() => {
              onClose();
              onSaved();
            }}
          />
        </div>
      ) : null}
    </Modal>
  );
}

export function AddRecurringSchedule() {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();

  if (!selected) return <NoBusinessProfile />;

  return (
    <FormPage
      eyebrow="Insights"
      title="Add a recurring payment"
      subtitle="FinSight tells you when it’s late or the amount is off."
    >
      <ScheduleForm
        businessProfileId={selected.id}
        schedule={null}
        onDone={() => navigate("/insights/expense-behavior")}
      />
    </FormPage>
  );
}

export function EditRecurringSchedule() {
  const { id } = useParams<{ id: string }>();
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const [schedule, setSchedule] = useState<RecurringSchedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, profileId]);

  if (loadError) return <p className="text-sm text-tone-danger">{loadError}</p>;
  if (!selected || !schedule) return <p className="text-sm text-ink-500">Loading…</p>;

  return (
    <FormPage eyebrow="Insights" title="Edit recurring payment" subtitle={lastMatchText(schedule)}>
      <ScheduleForm
        businessProfileId={selected.id}
        schedule={schedule}
        onDone={() => navigate("/insights/expense-behavior")}
      />
    </FormPage>
  );
}
