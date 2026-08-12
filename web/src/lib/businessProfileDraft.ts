/**
 * The in-progress state of a business profile, and the rules for turning it
 * into something the API will accept.
 *
 * WHY A SEPARATE SHAPE FROM BusinessProfileInput. Two reasons, both about
 * half-finished input:
 *
 *  1. Every value here is a STRING. A number-typed field cannot hold "empty" —
 *     it holds 0 — so the old form opened with `PHP 0` already in the funds box
 *     and an owner had to clear it before typing. Worse, 0 is a legitimate
 *     answer, so the form could not tell "not answered yet" from "answered
 *     zero".
 *  2. The onboarding wizard walks these fields across three steps and lets the
 *     owner leave and come back, so a draft has to survive being incomplete in
 *     a way BusinessProfileInput, which mirrors five NOT NULL columns, cannot.
 *
 * The conversion happens once, at submit, in toBusinessProfileInput().
 */
import { FIELD_LIMITS } from "./fieldLimits";
import {
  DEFAULT_THRESHOLD_PERCENT,
  thresholdPercentToPesos,
  thresholdPesosToPercent,
} from "./largeExpenseThreshold";
import type { BusinessProfile, BusinessProfileInput } from "./types";

/** The fields backed by a text box. Everything the owner actually types. */
export type BusinessTextField =
  | "name"
  | "type"
  | "availableFunds"
  | "expectedMonthlyExpenses"
  | "operatingDays"
  /** PESOS, not the percent the API takes — see largeExpenseThreshold.ts. */
  | "largeExpenseThresholdPesos";

export interface BusinessProfileDraft extends Record<BusinessTextField, string> {
  /**
   * Whether the owner has typed in the threshold box at all.
   *
   * WHY A FLAG AND NOT JUST AN EMPTY STRING. Empty has to mean two different
   * things: "never touched, so show the suggested amount" and "cleared it on
   * purpose, so leave the box empty while I retype". Collapsing them made the
   * field impossible to clear — select all, delete, and the suggestion
   * reappeared under the cursor.
   */
  thresholdTouched: boolean;
}

export type BusinessFieldErrors = Partial<Record<BusinessTextField, string>>;

/**
 * The types offered as a picker instead of the free-text box this used to be.
 *
 * A list is not merely faster to answer — it is the difference between the AI
 * context reading "Food Business" and reading "food biz", "foodbusiness" and
 * "Food  Business" as three unrelated categories. "Other" keeps the free-text
 * escape hatch for anyone the list does not describe, which on a list this
 * short is going to be plenty of people.
 */
export const BUSINESS_TYPES = [
  "Sari-sari store",
  "Food business",
  "Retail store",
  "Services",
  "Online selling",
  "Agriculture",
] as const;

/** The sentinel the picker uses to reveal its free-text box. Never sent to the API. */
export const OTHER_BUSINESS_TYPE = "__other__";

/**
 * The listed type this value IS, ignoring case and padding — or null for a
 * genuinely custom one.
 *
 * CASE-INSENSITIVE ON PURPOSE. Every profile created before the picker existed
 * holds free text, and "Food Business" is the same answer as the list's "Food
 * business". Matching exactly pushed those profiles to "Other…" with their type
 * in the free-text box: not data loss, but it told an owner their perfectly
 * ordinary food business was something the list had no word for, and the next
 * save would persist the odd casing for good.
 */
export function matchBusinessType(value: string): (typeof BUSINESS_TYPES)[number] | null {
  const needle = value.trim().toLowerCase();
  return BUSINESS_TYPES.find((t) => t.toLowerCase() === needle) ?? null;
}

export const EMPTY_DRAFT: BusinessProfileDraft = {
  name: "",
  type: "",
  availableFunds: "",
  expectedMonthlyExpenses: "",
  operatingDays: "26",
  largeExpenseThresholdPesos: "",
  thresholdTouched: false,
};

/**
 * Reopens an existing profile as a draft, converting the stored percent back to
 * pesos.
 *
 * `thresholdTouched` is true because a saved profile carries a real, chosen
 * threshold. Leaving it false would make the amount start chasing expected
 * monthly expenses the moment that field was edited, silently overwriting a
 * setting the owner had deliberately picked.
 */
export function draftFromProfile(profile: BusinessProfile | BusinessProfileInput): BusinessProfileDraft {
  const expenses = Number(profile.expectedMonthlyExpenses);
  return {
    name: profile.name,
    type: profile.type,
    availableFunds: String(profile.availableFunds),
    expectedMonthlyExpenses: String(profile.expectedMonthlyExpenses),
    operatingDays: String(profile.operatingDays),
    largeExpenseThresholdPesos: String(
      thresholdPercentToPesos(expenses, Number(profile.largeExpenseThresholdPercent)),
    ),
    thresholdTouched: true,
  };
}

/**
 * Applies one field edit.
 *
 * Shared rather than written at each call site because of the threshold's
 * touched flag: a form that forgot to set it would look correct and behave
 * subtly wrong, which is the worst kind of duplication to allow.
 */
export function applyFieldUpdate(
  draft: BusinessProfileDraft,
  key: BusinessTextField,
  value: string,
): BusinessProfileDraft {
  const next = { ...draft, [key]: value };
  if (key === "largeExpenseThresholdPesos") next.thresholdTouched = true;
  return next;
}

/**
 * What the threshold box should show right now.
 *
 * Until the owner types in it, it TRACKS expected monthly expenses at the
 * default share — enter 500000 above and this reads 100000 below, so the
 * relationship between the two numbers is visible rather than explained. From
 * the first keystroke it shows exactly what they typed, including nothing at
 * all, because at that point it is their answer and not a suggestion.
 */
export function thresholdDisplayValue(draft: BusinessProfileDraft): string {
  if (draft.thresholdTouched) return draft.largeExpenseThresholdPesos;
  const expenses = Number(draft.expectedMonthlyExpenses);
  if (!Number.isFinite(expenses) || expenses <= 0) return "";
  return String(thresholdPercentToPesos(expenses, DEFAULT_THRESHOLD_PERCENT));
}

export function toBusinessProfileInput(draft: BusinessProfileDraft): BusinessProfileInput {
  const expectedMonthlyExpenses = Number(draft.expectedMonthlyExpenses);
  // A box left alone — or cleared out — is not "no threshold". It is the
  // default share, which is what the field has been showing them all along.
  const pesos =
    draft.largeExpenseThresholdPesos === "" || !draft.thresholdTouched
      ? thresholdPercentToPesos(expectedMonthlyExpenses, DEFAULT_THRESHOLD_PERCENT)
      : Number(draft.largeExpenseThresholdPesos);

  return {
    name: draft.name.trim(),
    type: draft.type.trim(),
    availableFunds: Number(draft.availableFunds),
    expectedMonthlyExpenses,
    operatingDays: Number(draft.operatingDays),
    largeExpenseThresholdPercent: thresholdPesosToPercent(expectedMonthlyExpenses, pesos),
  };
}

/**
 * Step 1's rules. Kept apart from the numbers so the wizard can validate one
 * step without complaining about fields on a step the owner has not reached.
 */
export function validateBasics(draft: BusinessProfileDraft): BusinessFieldErrors {
  const errors: BusinessFieldErrors = {};
  if (!draft.name.trim()) errors.name = "Give your business a name.";
  else if (draft.name.trim().length > FIELD_LIMITS.businessName) errors.name = "That name is too long.";
  if (!draft.type.trim()) errors.type = "Pick what kind of business this is.";
  else if (draft.type.trim().length > FIELD_LIMITS.businessType) errors.type = "That type is too long.";
  return errors;
}

/** Step 2's rules. Mirrors the Zod schema in backend/src/controllers/businessProfile.controller.ts. */
export function validateNumbers(draft: BusinessProfileDraft): BusinessFieldErrors {
  const errors: BusinessFieldErrors = {};

  const funds = Number(draft.availableFunds);
  if (draft.availableFunds === "" || !Number.isFinite(funds) || funds < 0) {
    errors.availableFunds = "Enter the cash the business has to work with. Enter 0 if none.";
  }

  const expenses = Number(draft.expectedMonthlyExpenses);
  if (draft.expectedMonthlyExpenses === "" || !Number.isFinite(expenses) || expenses < 0) {
    errors.expectedMonthlyExpenses = "Enter roughly what a normal month costs you.";
  }

  const days = Number(draft.operatingDays);
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    errors.operatingDays = "Enter a number between 1 and 31.";
  }

  // Only checked when they typed something. Left alone — or cleared — it takes
  // the default, which is the whole point of it being optional.
  if (draft.thresholdTouched && draft.largeExpenseThresholdPesos !== "") {
    const pesos = Number(draft.largeExpenseThresholdPesos);
    if (!Number.isFinite(pesos) || pesos <= 0) {
      errors.largeExpenseThresholdPesos = "Enter an amount above 0, or leave it blank for the default.";
    }
  }

  return errors;
}

export function validateDraft(draft: BusinessProfileDraft): BusinessFieldErrors {
  return { ...validateBasics(draft), ...validateNumbers(draft) };
}

export function hasErrors(errors: BusinessFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
