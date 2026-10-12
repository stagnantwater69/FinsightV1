/**
 * The business-profile fields, in the two groups the onboarding wizard splits
 * them across.
 *
 * They live here rather than inside BusinessProfileForm because the wizard and
 * the edit form ask for exactly the same things and must not drift: a hint
 * reworded in one place and not the other is how an owner ends up being told
 * two different stories about the same number.
 */
import { useState } from "react";
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
}

interface NumbersGroupProps extends GroupProps {
  /** Existing profiles reset their funds anchor when the amount changes. */
  existingProfile?: boolean;
}

export function BusinessBasicsFields({
  draft,
  errors,
  update,
  compact = false,
  autoFocus = true,
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
          compact
            ? undefined
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

export function BusinessNumbersFields({
  draft,
  errors,
  update,
  compact = false,
  existingProfile = false,
}: NumbersGroupProps) {
  return (
    <>
      {/* These values are starting inputs; records can replace them in active figures. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Starting available funds"
          fillRow
          htmlFor="availableFunds"
          required
          error={errors.availableFunds}
          hint={
            compact
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
            compact
              ? undefined
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
        <Field
          label="Operating days per month"
          fillRow
          htmlFor="operatingDays"
          required
          error={errors.operatingDays}
          hint={
            compact
              ? undefined
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
            compact
              ? undefined
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
      <DailyTargetNote draft={draft} compact={compact} />
    </>
  );
}
