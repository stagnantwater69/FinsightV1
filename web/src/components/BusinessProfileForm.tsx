import { useState, type FormEvent, type ReactNode } from "react";
import type { BusinessProfileInput } from "../lib/types";
import { Button } from "./Button";
import { FormError } from "./Field";
import { BusinessBasicsFields, BusinessNumbersFields } from "./BusinessFields";
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
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="border-t border-paper-200 pt-5 first:border-t-0 first:pt-0">
      <h2 className="font-display text-sm font-semibold text-ink-900">{title}</h2>
      {description ? <p className="mt-0.5 mb-4 text-sm text-ink-500">{description}</p> : <div className="mb-4" />}
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
export function BusinessProfileForm({ initialValues, submitLabel, onSubmit, logo, onCancel }: Props) {
  const [draft, setDraft] = useState<BusinessProfileDraft>(() =>
    initialValues ? draftFromProfile(initialValues) : EMPTY_DRAFT,
  );
  const [fieldErrors, setFieldErrors] = useState<BusinessFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(key: BusinessTextField, value: string) {
    setDraft((d) => applyFieldUpdate(d, key, value));
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
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(toBusinessProfileInput(draft));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      <Section title="About your business" description="How FinSight refers to it, and what kind it is.">
        {/* The logo belongs with the name and the type: all three are the
            business's identity, and it was previously stranded above the form
            with no heading to say what it was part of. */}
        {logo}
        <BusinessBasicsFields draft={draft} errors={fieldErrors} update={update} />
      </Section>

      <Section
        title="Your numbers"
        description="These drive your sales target, your recovery tracking and which expenses get flagged. Rough figures are fine — you can change them anytime."
      >
        <BusinessNumbersFields draft={draft} errors={fieldErrors} update={update} />
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
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
