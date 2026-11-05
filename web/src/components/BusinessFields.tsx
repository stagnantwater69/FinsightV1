/**
 * The business-profile fields, in the two groups the onboarding wizard splits
 * them across.
 *
 * They live here rather than inside BusinessProfileForm because the wizard and
 * the edit form ask for exactly the same things and must not drift: a hint
 * reworded in one place and not the other is how an owner ends up being told
 * two different stories about the same number.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Divide, Equal, Target, Wallet } from "lucide-react";
import { api } from "../lib/api";
import type { OperatingScheduleEntry, RecoveryInsight } from "../lib/types";
import { monthLabel } from "../lib/reportingPeriod";
import { Field, MoneyInput, SelectInput, TextInput } from "./Field";
import { InfoNote } from "./ui";
import { formatMoney } from "./Money";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import {
  BUSINESS_TYPES,
  OTHER_BUSINESS_TYPE,
  matchBusinessType,
  thresholdDisplayValue,
  type BusinessFieldErrors,
  type BusinessProfileDraft,
  type BusinessTextField,
} from "../lib/businessProfileDraft";

interface GroupProps {
  draft: BusinessProfileDraft;
  errors: BusinessFieldErrors;
  update: (key: BusinessTextField, value: string) => void;
  compact?: boolean;
  autoFocus?: boolean;
  /** Full-width profile settings; setup and compact forms retain their copy. */
  settings?: boolean;
  /** Setup screens: one-line hints, and the daily target drawn as a sum
   * instead of the written note. */
  brief?: boolean;
}

interface NumbersGroupProps extends GroupProps {
  /** Existing profiles reset their funds anchor when the amount changes. */
  existingProfile?: boolean;
  /** The saved business being edited. Once it has an operating schedule, the
   * schedule decides the open days and the per-month field no longer applies. */
  scheduleProfileId?: number;
}

/** True once the business has a saved weekly schedule (all seven weekdays exist after setup). */
function useHasOperatingSchedule(profileId: number | undefined): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    setConfigured(false);
    if (profileId === undefined) return;
    const controller = new AbortController();
    api
      .get<OperatingScheduleEntry[]>(`/business-profiles/${profileId}/operating-schedule`, { signal: controller.signal })
      .then((res) => setConfigured(Array.isArray(res.data) && res.data.length === 7))
      // Unknown means the old field stays, which is what an unscheduled business uses.
      .catch(() => undefined);
    return () => controller.abort();
  }, [profileId]);
  return configured;
}

/**
 * This month's open days as the Recovery target counts them (schedule plus
 * date overrides), so this page and Recovery cannot show different numbers.
 */
function useOpenDaysThisMonth(profileId: number | undefined, enabled: boolean) {
  const [result, setResult] = useState<{ days: number; month: string } | null>(null);
  useEffect(() => {
    setResult(null);
    if (profileId === undefined || !enabled) return;
    const controller = new AbortController();
    api
      .get<RecoveryInsight>("/insights/recovery", {
        params: { businessProfileId: profileId, coverageDays: 1 },
        signal: controller.signal,
      })
      .then(({ data }) => {
        const days = data.operatingDaysThisMonth;
        if (typeof days === "number") setResult({ days, month: data.monthStart.slice(0, 7) });
      })
      // Without the count the line still says where open days come from.
      .catch(() => undefined);
    return () => controller.abort();
  }, [profileId, enabled]);
  return result;
}

export function BusinessBasicsFields({
  draft,
  errors,
  update,
  compact = false,
  autoFocus = true,
  settings = false,
  brief = false,
}: GroupProps) {
  /*
   * A type that is not on the list can only have come from "Other" — either
   * typed just now, or loaded from a profile created before the picker existed.
   * Deriving the initial state this way means reopening such a profile shows
   * the value in the free-text box rather than silently snapping it to the
   * first option in the list and discarding it on the next save.
   *
   * Matched case-insensitively, so a stored "Food Business" selects the list's
   * "Food business" instead of being treated as something the list has no word
   * for. See matchBusinessType.
   */
  const listed = matchBusinessType(draft.type);
  const [showCustomType, setShowCustomType] = useState(
    () => draft.type !== "" && listed === null,
  );

  return (
    <>
      <Field label="Business name" htmlFor="name" required error={errors.name}>
        <TextInput
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="e.g. Aling Nena Sari-Sari Store"
          maxLength={FIELD_LIMITS.businessName}
          autoFocus={autoFocus}
        />
      </Field>

      <Field
        label="Business type"
        htmlFor="type"
        required
        error={errors.type}
        hint={
          compact || brief
            ? undefined
            : settings
              ? "Choose a type, or select Other to enter your own."
              : "Helps FinSight compare you against the right kind of business."
        }
      >
        <SelectInput
          /* The canonical option, not the raw value — a stored "Food Business"
             has no matching <option> and would render the select as blank. */
          value={showCustomType ? OTHER_BUSINESS_TYPE : (listed ?? "")}
          onChange={(e) => {
            const next = e.target.value;
            if (next === OTHER_BUSINESS_TYPE) {
              setShowCustomType(true);
              // Cleared rather than kept: the box below is empty, and leaving
              // the old value in state would save a type the owner can no
              // longer see.
              update("type", "");
            } else {
              setShowCustomType(false);
              update("type", next);
            }
          }}
        >
          <option value="">Choose one…</option>
          {BUSINESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
          <option value={OTHER_BUSINESS_TYPE}>Other…</option>
        </SelectInput>
      </Field>

      {showCustomType ? (
        <Field label="Tell us what kind" htmlFor="customType">
          <TextInput
            value={draft.type}
            onChange={(e) => update("type", e.target.value)}
            placeholder="e.g. Tire shop, laundry, printing"
            maxLength={FIELD_LIMITS.businessType}
            autoFocus={autoFocus}
          />
        </Field>
      ) : null}
    </>
  );
}

/**
 * What the two figures above actually produce, using the owner's OWN numbers.
 *
 * This preview uses the starting estimate. The active Recovery Target can
 * later use a complete previous month's expense records instead.
 */
function DailyTargetNote({
  draft,
  compact = false,
}: {
  draft: BusinessProfileDraft;
  compact?: boolean;
}) {
  const expenses = Number(draft.expectedMonthlyExpenses);
  const days = Number(draft.operatingDays);
  const ready =
    Number.isFinite(expenses) &&
    expenses > 0 &&
    Number.isInteger(days) &&
    days > 0;

  if (!ready) {
    return (
      <InfoNote>
        Your starting monthly estimate divided by operating days gives the
        initial daily sales target. After you confirm a complete previous
        month, FinSight uses those expense records instead.
      </InfoNote>
    );
  }

  return (
    <InfoNote>
      <b className="font-semibold text-ink-700">Starting daily sales target:</b>{" "}
      <span className="figure font-semibold text-ink-900">
        {formatMoney(expenses / days)}
      </span>
      {compact ? (
        " per operating day."
      ) : (
        <>
          {" "}
          from <span className="figure">
            {formatMoney(expenses)}
          </span> across <span className="figure">{days}</span> open{" "}
          {days === 1 ? "day" : "days"}.
        </>
      )}
    </InfoNote>
  );
}

/**
 * The daily target, drawn as the sum it is: monthly costs divided by open
 * days. Seeing the two inputs turn into the one output explains why the
 * screen asks for them better than a paragraph did.
 */
function TargetPreview({ draft }: { draft: BusinessProfileDraft }) {
  const expenses = Number(draft.expectedMonthlyExpenses);
  const days = Number(draft.operatingDays);
  const ready = expenses > 0 && Number.isInteger(days) && days > 0;
  const cells = [
    { Icon: Wallet, label: "Monthly costs", value: expenses > 0 ? formatMoney(expenses) : null },
    { Icon: CalendarDays, label: "Open days", value: Number.isInteger(days) && days > 0 ? String(days) : null },
    { Icon: Target, label: "Daily sales target", value: ready ? formatMoney(expenses / days) : null },
  ];
  return (
    <div className="rounded-2xl border border-paper-200 bg-paper-50 p-4" aria-live="polite">
      <div className="grid grid-cols-1 items-center justify-items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-3">
        {cells.map(({ Icon, label, value }, i) => {
          const result = i === 2;
          return (
            <div key={label} className="contents">
              {i > 0 ? (
                <span aria-hidden className="mx-auto flex h-6 w-6 items-center justify-center rounded-full bg-paper text-ink-600 ring-1 ring-paper-200">
                  {i === 1 ? <Divide className="h-3.5 w-3.5" /> : <Equal className="h-3.5 w-3.5" />}
                </span>
              ) : null}
              <div
                className={`min-w-0 rounded-xl px-2.5 py-2.5 text-center transition-colors duration-300 sm:px-3 ${
                  result && ready ? "bg-brand-700 text-white shadow-sm" : "bg-paper ring-1 ring-paper-200"
                }`}
              >
                <Icon aria-hidden className={`mx-auto h-4 w-4 ${result && ready ? "text-brand-100" : "text-tone-brand"}`} />
                <p className={`mt-1 truncate text-xs ${result && ready ? "text-brand-100" : "text-ink-600"}`}>{label}</p>
                <p
                  key={value ?? "empty"}
                  className={`figure mt-0.5 truncate text-sm font-semibold sm:text-base ${value ? "animate-fade-up" : ""} ${
                    result && ready ? "text-white" : "text-ink-900"
                  }`}
                >
                  {value ?? <span className="text-ink-600">?</span>}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-center text-xs text-ink-600">
        Your first target. Once a full month of records is in, FinSight uses those instead.
      </p>
    </div>
  );
}

export function BusinessNumbersFields({
  draft,
  errors,
  update,
  compact = false,
  existingProfile = false,
  settings = false,
  brief = false,
  scheduleProfileId,
}: NumbersGroupProps) {
  const scheduled = useHasOperatingSchedule(scheduleProfileId);
  const openDays = useOpenDaysThisMonth(scheduleProfileId, scheduled);
  const scheduleHref = `/business-profiles/${scheduleProfileId}/operating-schedule`;
  return (
    <>
      {/* These values are starting inputs; records can replace them in active figures. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Opening balance"
          fillRow
          htmlFor="availableFunds"
          required
          error={errors.availableFunds}
          hint={
            brief
              ? "Cash the business has right now."
              : compact
              ? undefined
              : existingProfile
                ? "Enter the amount available now. Saving a different amount starts a new balance from the day you save it."
                : "Enter the amount the business has available now. FinSight uses this as the starting point for confirmed sales and expenses."
          }
        >
          <MoneyInput
            min={0}
            inputMode="decimal"
            value={draft.availableFunds}
            onChange={(e) => update("availableFunds", e.target.value)}
            placeholder="0"
          />
        </Field>
        <Field
          label="Starting monthly expense estimate"
          fillRow
          htmlFor="expectedMonthlyExpenses"
          required
          error={errors.expectedMonthlyExpenses}
          hint={
            brief
              ? "Rent, stock, wages and bills in a normal month."
              : compact
              ? undefined
              : settings
                ? "Used until the previous month’s expense records are confirmed complete."
                : "Enter your best estimate for a normal month. FinSight uses it until the previous month's expense records are confirmed complete."
          }
        >
          <MoneyInput
            min={0}
            inputMode="decimal"
            value={draft.expectedMonthlyExpenses}
            onChange={(e) => update("expectedMonthlyExpenses", e.target.value)}
            placeholder="0"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {scheduled ? (
          // Laid out like the field beside it (label, hint, box) so the two rows line up.
          <div className="flex flex-col">
            <p className="text-sm font-medium text-ink-800">Operating days</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Set by your operating schedule.{" "}
              <Link to={scheduleHref} className="tap-inline font-semibold link-action">
                Edit schedule
              </Link>
              {compact ? null : <> Your daily sales target is spread across these days.</>}
            </p>
            <p className="mt-2 flex min-h-10 items-center rounded-xl bg-paper-50 px-3.5 py-2 text-sm text-ink-700 ring-1 ring-paper-200 sm:mt-auto">
              {openDays ? (
                <span>
                  <span className="figure font-semibold text-ink-900">{openDays.days}</span> days open in{" "}
                  {monthLabel(openDays.month)}
                </span>
              ) : (
                "From your weekly schedule"
              )}
            </p>
          </div>
        ) : (
          <Field
            label="Operating days per month"
            fillRow
            htmlFor="operatingDays"
            required
            error={errors.operatingDays}
            hint={
              brief
                ? "Days you are open in a normal month."
                : compact
                ? undefined
                : settings
                  ? "Open days in a normal month. Your daily target is spread across these days."
                  : "How many days a month the business is actually open. Used to spread your target across the days you can actually sell."
            }
          >
            <TextInput
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={draft.operatingDays}
              onChange={(e) => update("operatingDays", e.target.value)}
              // Same wheel guard MoneyInput carries: scrolling the page with the
              // pointer over a focused number input silently edits it. The
              // stepper arrows are kept here — unlike on the money fields they
              // step by a useful 1, and 26→27 is a real way to answer this.
              onWheel={(e) => e.currentTarget.blur()}
            />
          </Field>
        )}

        {/*
          ASKED IN PESOS, STORED AS A PERCENT — see lib/largeExpenseThreshold.ts.
          Marked optional rather than required because it is the one field here
          that is not a fact about the business: it is a setting, it has a
          sensible default, and an owner who does not know what to put should be
          able to move past it rather than stall on it.
        */}
        <Field
          label="Flag single expenses over"
          fillRow
          htmlFor="largeExpenseThresholdPesos"
          optional
          error={errors.largeExpenseThresholdPesos}
          hint={
            brief
              ? "Bigger expenses get a second look. We suggest an amount."
              : compact
              ? undefined
              : settings
                ? "Larger expenses are flagged for review. The suggested amount comes from your monthly estimate."
                : "Expenses this big get set aside for review. FinSight suggests an amount from your starting monthly estimate, and you can change it anytime."
          }
        >
          <MoneyInput
            min={0}
            inputMode="decimal"
            value={thresholdDisplayValue(draft)}
            onChange={(e) =>
              update("largeExpenseThresholdPesos", e.target.value)
            }
            placeholder="0"
          />
        </Field>
      </div>

      {/* Lives with the fields it is computed from, so both screens that ask
          these questions show the same answer. */}
      {/* With a schedule, the Operating days box above already says how the target is spread. */}
      {scheduled ? null : brief ? <TargetPreview draft={draft} /> : <DailyTargetNote draft={draft} compact={compact} />}
    </>
  );
}
