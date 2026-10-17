import { CategorySelect } from "../../components/CategorySelect";
import { MoneyInput } from "../../components/Field";
import { Money } from "../../components/Money";
import type { Split } from "./types";

export function SplitEditor({
  splits,
  updateSplit,
  removeSplit,
  unallocatedCentavos,
}: {
  splits: Split[];
  updateSplit: (index: number, patch: Partial<Split>) => void;
  removeSplit: (index: number) => void;
  unallocatedCentavos: number;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink-700">
        Split across categories
        <span className="ml-1 text-tone-danger" title="Required">
          <span aria-hidden>*</span>
          <span className="sr-only">(required)</span>
        </span>
      </legend>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        The parts must add up to the total above.
      </p>

      <ul className="mt-2 space-y-2">
        {splits.map((split, i) => (
          <li key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={`split-category-${i}`} className="sr-only">
                Category for part {i + 1}
              </label>
              <CategorySelect
                id={`split-category-${i}`}
                value={split.categoryId}
                onChange={(id) => updateSplit(i, { categoryId: id })}
              />
            </div>
            <div className="w-36 shrink-0">
              <label htmlFor={`split-amount-${i}`} className="sr-only">
                Amount for part {i + 1}
              </label>
              <MoneyInput
                id={`split-amount-${i}`}
                min={0.01}
                required
                value={split.amount}
                onChange={(e) =>
                  updateSplit(i, { amount: e.target.value === "" ? "" : Number(e.target.value) })
                }
              />
            </div>
            <button
              type="button"
              onClick={() => removeSplit(i)}
              aria-label={`Remove part ${i + 1}`}
              className="tap mt-0.5 h-11 w-11 shrink-0 rounded-lg text-ink-500 transition hover:bg-paper-100 hover:text-tone-danger"
            >
              <span aria-hidden>×</span>
            </button>
          </li>
        ))}
      </ul>

      <p
        aria-live="polite"
        className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
          unallocatedCentavos === 0 ? "text-tone-brand" : "text-tone-accent"
        }`}
      >
        <span aria-hidden>{unallocatedCentavos === 0 ? "✓" : "⚠"}</span>
        {unallocatedCentavos === 0 ? (
          <>The parts add up to the receipt total.</>
        ) : unallocatedCentavos > 0 ? (
          <>
            <Money value={unallocatedCentavos / 100} /> of the total isn't assigned yet.
          </>
        ) : (
          <>
            The parts are <Money value={-unallocatedCentavos / 100} /> over the receipt total.
          </>
        )}
      </p>
    </fieldset>
  );
}
