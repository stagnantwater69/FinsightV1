import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Callout } from "./ui";
import { Field, FormError, TextInput } from "./Field";
import { Money } from "./Money";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { ReductionSimulation, ReductionSimulationInput } from "../lib/types";

/**
 * "Simulate reduction" — plan §12, Phase 4.
 *
 * A modal rather than a redesign of Spending Impact, per §12.4's explicit
 * instruction: this is a second, separate concept (a hypothetical reduction
 * of PAST recorded spending) from Spending Impact's planned-purchase mode,
 * and the plan defers combining the two until UAT shows owners understand
 * both.
 *
 * Scoped to one opportunity's category — opened from its card, closed with
 * its own state, exactly like AddExpenseModal/AddSalesModal.
 *
 * WHAT THIS MUST NEVER DO (plan §4.2, §12.1): assert the reduction will
 * happen, or reference the business's cash on hand. The backend's
 * calculation never touches it, so showing it here would misrepresent what
 * the numbers mean — this component takes no prop for it and reads nothing
 * of the kind from the business profile.
 */

type Kind = "percent" | "amount";

interface FieldErrors {
  value?: string;
}

/**
 * Mirrors the server's own rules in reductionOpportunity.service.ts
 * (`computeReductionSimulation`) so a bad value is caught before the round
 * trip, not just after it. `baseline` is the category's period total — the
 * card's own `evidence.currentAmount`, which was computed from the same
 * `periodDays`/`endDate` this modal submits, so it is the same number the
 * server will derive.
 */
function validate(kind: Kind, rawValue: string, baseline: number): FieldErrors {
  if (rawValue.trim() === "") return { value: "Enter a value." };
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return { value: "Enter a number." };

  if (kind === "percent") {
    if (value <= 0 || value > 100) return { value: "Enter a percentage greater than 0 and no greater than 100." };
    return {};
  }

  if (value <= 0) return { value: "Enter an amount greater than 0." };
  if (baseline > 0 && value > baseline) {
    return { value: `Enter an amount up to the category's period total of ${baseline.toFixed(2)}.` };
  }
  return {};
}

export function ReductionSimulationModal({
  open,
  onClose,
  businessProfileId,
  categoryId,
  categoryName,
  periodDays,
  endDate,
  /** The category's period total already on screen — see `validate` above. */
  baseline,
}: {
  open: boolean;
  onClose: () => void;
  businessProfileId: number;
  categoryId: number;
  categoryName: string;
  periodDays: number;
  endDate: string | null;
  baseline: number;
}) {
  const [kind, setKind] = useState<Kind>("percent");
  const [rawValue, setRawValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReductionSimulation | null>(null);

  function reset() {
    setKind("percent");
    setRawValue("");
    setTouched(false);
    setSubmitting(false);
    setError(null);
    setResult(null);
  }

  // Re-seeded every time the modal opens — same pattern as AddExpenseModal,
  // so switching which card opened it never carries a stale result forward.
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, categoryId]);

  function handleClose() {
    onClose();
    reset();
  }

  const fieldErrors = validate(kind, rawValue, baseline);
  const shownError = touched ? fieldErrors.value : undefined;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (fieldErrors.value) {
      setTouched(true);
      return;
    }
    setError(null);
    setSubmitting(true);
    setResult(null);
    try {
      const payload: ReductionSimulationInput = {
        businessProfileId,
        categoryId,
        periodDays,
        ...(endDate ? { endDate } : {}),
        reduction: { kind, value: Number(rawValue) },
      };
      const res = await api.post<ReductionSimulation>("/insights/reduction-simulation", payload);
      setResult(res.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Simulate reduction — ${categoryName}`}>
      {result ? (
        <div className="space-y-4">
          <Callout tone="info">
            This is a hypothetical scenario — nothing was changed, and no expense record was created,
            edited, or deleted.
          </Callout>

          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
                {result.categoryName} — before
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink-900">
                <Money value={result.categoryExpenses.before} decimals />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
                {result.categoryName} — hypothetical after
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink-900">
                <Money value={result.categoryExpenses.after} decimals />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
                Total expenses — before
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink-900">
                <Money value={result.totalExpenses.before} decimals />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
                Total expenses — hypothetical after
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink-900">
                <Money value={result.totalExpenses.after} decimals />
              </dd>
            </div>
          </dl>

          <p className="text-sm text-ink-700">
            Hypothetical reduction:{" "}
            <span className="font-semibold text-ink-900">
              <Money value={result.hypotheticalReduction} decimals />
            </span>{" "}
            ({result.requestedReductionPercent.toFixed(1)}% of {result.categoryName}'s period total)
          </p>

          {result.assumptions.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-ink-700">Assumptions behind this figure</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-500">
                {result.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setResult(null)}>
              Try a different value
            </Button>
            <Button type="button" variant="primary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <p className="text-sm text-ink-600">
            See what {categoryName}'s recorded expenses would look like if this period's total were
            hypothetically lower — for review, not a plan you're committing to.
          </p>

          <div className="flex gap-2" role="radiogroup" aria-label="Reduction type">
            <button
              type="button"
              role="radio"
              aria-checked={kind === "percent"}
              onClick={() => {
                setKind("percent");
                setTouched(false);
              }}
              className={`tap rounded-lg px-3 text-sm font-semibold transition ${
                kind === "percent"
                  ? "bg-brand-600 text-white"
                  : "border border-ink-200 bg-paper text-ink-700 hover:bg-paper-100"
              }`}
            >
              Percent
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === "amount"}
              onClick={() => {
                setKind("amount");
                setTouched(false);
              }}
              className={`tap rounded-lg px-3 text-sm font-semibold transition ${
                kind === "amount"
                  ? "bg-brand-600 text-white"
                  : "border border-ink-200 bg-paper text-ink-700 hover:bg-paper-100"
              }`}
            >
              Peso amount
            </button>
          </div>

          <Field
            label={kind === "percent" ? "Reduction percentage" : "Reduction amount"}
            htmlFor="reduction-simulation-value"
            required
            hint={
              kind === "percent"
                ? "Greater than 0, up to 100."
                : baseline > 0
                  ? `Greater than 0, up to this period's ${categoryName} total of ${baseline.toFixed(2)}.`
                  : "Greater than 0."
            }
            error={shownError}
          >
            <TextInput
              id="reduction-simulation-value"
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              value={rawValue}
              onChange={(e) => setRawValue(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={kind === "percent" ? "e.g. 15" : "e.g. 500"}
            />
          </Field>

          {error ? <FormError>{error}</FormError> : null}

          <Button type="submit" variant="primary" fullWidth disabled={submitting}>
            {submitting ? "Simulating…" : "Simulate"}
          </Button>
        </form>
      )}
    </Modal>
  );
}
