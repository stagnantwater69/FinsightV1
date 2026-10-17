import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import type { BusinessProfileInput } from "../lib/types";
import { Button } from "./Button";
import { FormError } from "./Field";
import { BusinessBasicsFields, BusinessNumbersFields } from "./BusinessFields";
import { Card } from "./ui";
import {
  EMPTY_DRAFT,
  applyFieldUpdate,
  draftFromProfile,
  hasErrors,
  toBusinessProfileInput,
  validateDraft,
  type BusinessFieldErrors,
  type BusinessProfileDraft,
  type BusinessTextField,
} from "../lib/businessProfileDraft";

interface Props {
  initialValues?: BusinessProfileInput;
  submitLabel: string;
  onSubmit: (input: BusinessProfileInput) => Promise<void>;
  /**
   * The logo control, rendered inside the identity section.
   *
   * Passed in rather than owned here because uploading needs a profile id, and
   * this form is also used before one exists.
   */
  logo?: ReactNode;
  /** Where "Cancel" goes. Omitted on screens with nowhere to go back to. */
  onCancel?: () => void;
  /** Condensed presentation for the wide modal; full pages retain guidance. */
  compact?: boolean;
  /** Independent financial controls and tools shown after the settings form. */
  settingsAside?: ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * One titled band of the form.
 *
 * WHY THE FORM IS BANDED AT ALL. It asks six questions of two completely
 * different kinds — what the business IS, and what its money looks like — and
 * rendered them as one undifferentiated stack of controls. Nothing said where
 * one subject ended and the next began, so the only way to find a field was to
 * read every label from the top.
 *
 * The two bands are also the two steps of the setup wizard, in the same order
 * and under the same names. An owner who set the business up and comes back to
 * edit it a month later meets the shape they already learned.
 */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-paper-200 pt-5 first:border-t-0 first:pt-0">
      <h2 className="font-display text-sm font-semibold text-ink-900">
        {title}
      </h2>
      {description ? (
        <p className="mt-0.5 mb-4 text-sm text-ink-500">{description}</p>
      ) : (
        <div className="mb-4" />
      )}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * The single-screen form, used for EDITING an existing business.
 *
 * Creating one goes through the three-step wizard in pages/Onboarding instead,
 * which asks for these same fields a few at a time. Both render the field
 * groups from BusinessFields.tsx, so the questions and their explanations
 * cannot drift apart.
 */
export function BusinessProfileForm({
  initialValues,
  submitLabel,
  onSubmit,
  logo,
  onCancel,
  compact = false,
  settingsAside,
  onDirtyChange,
}: Props) {
  const [draft, setDraft] = useState<BusinessProfileDraft>(() =>
    initialValues ? draftFromProfile(initialValues) : EMPTY_DRAFT,
  );
  const [baseline, setBaseline] = useState<BusinessProfileDraft>(() =>
    initialValues ? draftFromProfile(initialValues) : EMPTY_DRAFT,
  );
  const [fieldErrors, setFieldErrors] = useState<BusinessFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  function update(key: BusinessTextField, value: string) {
    const next = applyFieldUpdate(draft, key, value);
    const nextDirty = !sameDraft(next, baseline);
    setDraft(next);
    setDirty(nextDirty);
    setSaved(false);
    onDirtyChange?.(nextDirty);
    // Clearing on edit rather than revalidating on every keystroke: an error
    // that disappears the moment you start fixing it is encouraging, whereas
    // one that rewrites itself mid-word is noise.
    setFieldErrors((e) => (key in e ? { ...e, [key]: undefined } : e));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const errors = validateDraft(draft);
    if (hasErrors(errors)) {
      setFieldErrors(errors);
      requestAnimationFrame(() => {
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus();
      });
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(toBusinessProfileInput(draft));
      setBaseline(draft);
      setDirty(false);
      setSaved(true);
      onDirtyChange?.(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    setDraft(baseline);
    setFieldErrors({});
    setError(null);
    setDirty(false);
    setSaved(false);
    setResetVersion((version) => version + 1);
    onDirtyChange?.(false);
    onCancel?.();
  }

  if (settingsAside) {
    return (
      <>
        <form ref={formRef} onSubmit={handleSubmit} noValidate>
          <Card className="overflow-hidden shadow-none">
            <section className="p-5 sm:p-7">
              <SettingsSectionHeading
                title="Business identity"
                description="The name, type, and logo for this business."
              />
              <div className={`mt-6 grid gap-6 ${logo ? "lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:gap-8" : ""}`}>
                {logo ? <div className="min-w-0">{logo}</div> : null}
                <div className="min-w-0 space-y-5">
                  <BusinessBasicsFields
                    key={resetVersion}
                    draft={draft}
                    errors={fieldErrors}
                    update={update}
                    autoFocus={false}
                    settings
                  />
                </div>
              </div>
            </section>

            <section className="border-t border-paper-200 p-5 sm:p-7">
              <SettingsSectionHeading
                title="Starting figures"
                description="Your balance and estimates. Calculated figures from confirmed records appear below."
              />
              <div className="mt-6 space-y-5">
                <BusinessNumbersFields
                  draft={draft}
                  errors={fieldErrors}
                  update={update}
                  existingProfile={Boolean(initialValues)}
                  settings
                />
              </div>
            </section>
          </Card>

          {error ? <div className="mt-4"><FormError>{error}</FormError></div> : null}

          <div className="z-20 mt-4 flex flex-col gap-3 rounded-xl border border-paper-200 bg-paper px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p
              className={`flex min-h-6 items-center gap-2 text-sm ${dirty ? "text-tone-accent" : "text-ink-500"}`}
              aria-live="polite"
            >
              {dirty ? (
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent-500" />
              ) : (
                <CircleCheck aria-hidden className="size-4 shrink-0 text-tone-brand" />
              )}
              {dirty
                ? "You have unsaved changes"
                : saved
                  ? "Changes saved"
                  : "Everything is up to date"}
            </p>
            <div className="flex flex-col-reverse gap-3 sm:flex-row">
              <Button
                type="button"
                variant="secondary"
                disabled={submitting || !dirty}
                onClick={handleCancel}
                className="w-full sm:min-w-28"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={submitting || !dirty}
                className="w-full sm:min-w-36"
              >
                {submitting ? "Saving…" : submitLabel}
              </Button>
            </div>
          </div>
        </form>

        <div className="mt-8 min-w-0 space-y-6">{settingsAside}</div>
      </>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className={compact ? "space-y-4" : "space-y-6"}
      noValidate
    >
      <Section
        title="About your business"
        description={
          compact
            ? undefined
            : "How FinSight refers to it, and what kind it is."
        }
      >
        {/* The logo belongs with the name and the type: all three are the
            business's identity, and it was previously stranded above the form
            with no heading to say what it was part of. */}
        {logo}
        <BusinessBasicsFields
          draft={draft}
          errors={fieldErrors}
          update={update}
          compact={compact}
        />
      </Section>

      <Section
        title="Starting figures"
        description={
          compact
            ? undefined
            : "These initialize your recorded funds and monthly target. FinSight uses confirmed records when enough history is available."
        }
      >
        <BusinessNumbersFields
          draft={draft}
          errors={fieldErrors}
          update={update}
          compact={compact}
          existingProfile={Boolean(initialValues)}
        />
      </Section>

      {error ? <FormError>{error}</FormError> : null}

      {/*
        Actions on their own band, separated from the last field.

        Save used to sit flush under the final input, where it read as that
        field's control rather than the form's. Cancel is new: the only way off
        this screen was the browser's back button, which on a form with unsaved
        edits is the one control nobody wants to guess about.
      */}
      <div className="flex flex-wrap items-center gap-3 border-t border-paper-200 pt-5">
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function sameDraft(a: BusinessProfileDraft, b: BusinessProfileDraft) {
  return (
    a.name === b.name &&
    a.type === b.type &&
    a.availableFunds === b.availableFunds &&
    a.expectedMonthlyExpenses === b.expectedMonthlyExpenses &&
    a.operatingDays === b.operatingDays &&
    a.largeExpenseThresholdPesos === b.largeExpenseThresholdPesos &&
    a.thresholdTouched === b.thresholdTouched
  );
}

function SettingsSectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0">
      <h2 className="font-display text-lg font-semibold text-ink-900">
        {title}
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-ink-500">
        {description}
      </p>
    </div>
  );
}
