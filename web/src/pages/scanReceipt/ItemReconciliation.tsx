import { CategorySelect } from "../../components/CategorySelect";
import { Money } from "../../components/Money";
import type { GapPlan } from "../../lib/receiptConfirm";
import type { CategoryGroup } from "../../lib/receiptReview";
import { GapOption } from "./GapOption";

export function ItemReconciliation({
  itemGroups,
  categoryName,
  itemsAreComplete,
  everyItemHasCategory,
  itemGapCentavos,
  itemsTotalCentavos,
  totalCentavos,
  gapPlan,
  gapPlanIsResolved,
  gapNeedsAPlan,
  canFileGapInOneCategory,
  gapCategoryId,
  setReviewDirty,
  setGapPlan,
  setGapCategoryId,
  addAddedItem,
}: {
  itemGroups: CategoryGroup[];
  categoryName: (id: number | "") => string;
  itemsAreComplete: boolean;
  everyItemHasCategory: boolean;
  itemGapCentavos: number;
  itemsTotalCentavos: number;
  totalCentavos: number;
  gapPlan: GapPlan;
  gapPlanIsResolved: boolean;
  gapNeedsAPlan: boolean;
  canFileGapInOneCategory: boolean;
  gapCategoryId: number | "";
  setReviewDirty: (dirty: boolean) => void;
  setGapPlan: (plan: GapPlan) => void;
  setGapCategoryId: (categoryId: number | "") => void;
  addAddedItem: () => void;
}) {
  return (
    <>
      {/*
        The live per-category subtotals. Derived from the rows on
        every render rather than held in their own state, so moving
        one item between categories cannot leave a stale figure
        behind — both affected subtotals change in the same paint.
      */}
      <div className="mt-3 rounded-xl bg-paper-100 p-3">
        <p className="text-xs font-semibold text-ink-600">What gets saved</p>
        <ul className="mt-1.5 space-y-1">
          {itemGroups.map((group) => (
            <li
              key={String(group.categoryId)}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="min-w-0 truncate text-ink-700">
                {group.categoryId === "" ? (
                  <span className="text-tone-accent">Not categorised yet</span>
                ) : (
                  categoryName(group.categoryId)
                )}
                <span className="ml-1.5 text-xs text-ink-600">
                  ({group.count} item{group.count === 1 ? "" : "s"})
                </span>
              </span>
              <span className="figure shrink-0 font-medium text-ink-900">
                <Money value={group.subtotal} decimals />
              </span>
            </li>
          ))}
        </ul>
        <p
          aria-live="polite"
          className={`mt-2 flex items-center gap-1.5 border-t border-paper-200 pt-2 text-xs font-medium ${
            itemsAreComplete ? "text-tone-brand" : "text-tone-accent"
          }`}
        >
          <span aria-hidden>{itemsAreComplete ? "✓" : "⚠"}</span>
          {!everyItemHasCategory ? (
            <>Every item needs a category before this can be saved.</>
          ) : itemGapCentavos === 0 ? (
            <>
              {itemGroups.length} record{itemGroups.length === 1 ? "" : "s"} will be saved, adding
              up to the receipt total.
            </>
          ) : gapPlan === "shrink" ? (
            <>
              The receipt will be saved as <Money value={itemsTotalCentavos / 100} decimals /> based
              on the items' own total instead of the amount above.
            </>
          ) : gapPlanIsResolved ? (
            <>
              {itemGroups.length + (gapPlan === "category" ? 1 : 0)} record
              {itemGroups.length + (gapPlan === "category" ? 1 : 0) === 1 ? "" : "s"} will be saved,
              adding up to the receipt total of{" "}
              <Money value={totalCentavos / 100} decimals />.
            </>
          ) : itemGapCentavos > 0 ? (
            <>
              The items come to <Money value={itemsTotalCentavos / 100} decimals />, which is{" "}
              <Money value={itemGapCentavos / 100} decimals /> less than the receipt total above.
            </>
          ) : (
            <>
              The items come to <Money value={itemsTotalCentavos / 100} decimals />, which is{" "}
              <Money value={-itemGapCentavos / 100} decimals /> more than the receipt total above.
            </>
          )}
        </p>

        {gapPlan === "proportional" && gapNeedsAPlan ? (
          <p className="mt-1 text-xs text-ink-600">
            Each category above will carry its share of the{" "}
            <Money value={Math.abs(itemGapCentavos) / 100} decimals bare /> when saved.
          </p>
        ) : null}
      </div>

      {/*
        Accounting for the difference.

        A gap is normal rather than a mistake: a VAT-exclusive
        register adds tax on top of the printed lines, a discount
        takes money off, and OCR sometimes just misses one. The old
        screen offered a single way out — set the receipt total down
        to the items — which balances the arithmetic by DELETING
        money the owner really spent. On a receipt totalling 1,120
        with 1,000 of items, that filed a 1,000 expense.

        So the owner is asked what the difference actually is. The
        total they confirmed against the photo is the anchor and
        never moves on its own; only the last option, for a total
        OCR misread, changes it, and then only to figures read off
        the receipt.
      */}
      {everyItemHasCategory && gapNeedsAPlan ? (
        <fieldset className="mt-3 rounded-xl border border-tone-accent/30 bg-tone-accent/5 p-3">
          <legend className="px-1 text-xs font-semibold text-ink-700">
            {itemGapCentavos > 0 ? (
              <>
                What is the missing <Money value={itemGapCentavos / 100} decimals bare />?
              </>
            ) : (
              <>
                What is the extra <Money value={-itemGapCentavos / 100} decimals bare />?
              </>
            )}
          </legend>

          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {itemGapCentavos > 0
              ? "Usually tax, a service charge, or a line that didn't scan."
              : "Usually a discount or a voided line."}
          </p>

          <div className="mt-2 space-y-1.5">
            <GapOption
              name="gap-plan"
              checked={gapPlan === "proportional"}
              onChange={() => {
                setReviewDirty(true);
                setGapPlan("proportional");
              }}
              label={itemGapCentavos > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
              detail="Split across the categories above, in proportion to each."
            />

            {canFileGapInOneCategory ? (
              <GapOption
                name="gap-plan"
                checked={gapPlan === "category"}
                onChange={() => {
                  setReviewDirty(true);
                  setGapPlan("category");
                }}
                label="A separate charge to track on its own"
                detail="Saved as its own expense record under one category."
              >
                {gapPlan === "category" ? (
                  <div className="mt-1.5">
                    <label htmlFor="gap-category" className="sr-only">
                      Category for the remaining amount
                    </label>
                    <CategorySelect
                      id="gap-category"
                      value={gapCategoryId}
                      onChange={(categoryId) => {
                        setReviewDirty(true);
                        setGapCategoryId(categoryId);
                      }}
                    />
                  </div>
                ) : null}
              </GapOption>
            ) : null}

            <GapOption
              name="gap-plan"
              checked={gapPlan === "shrink"}
              onChange={() => {
                setReviewDirty(true);
                setGapPlan("shrink");
              }}
              label="FinSight misread the receipt total"
              detail={
                <>
                  Save <Money value={itemsTotalCentavos / 100} decimals bare /> based on the items' own
                  total instead of the amount above.
                </>
              }
            />
          </div>

          {/*
            A missing line is not a category question, so it sits
            apart from the radios: adding it changes the gap rather
            than explaining it, and often closes it entirely.
          */}
          <button
            type="button"
            onClick={addAddedItem}
            className="tap-inline mt-2.5 border-t border-tone-accent/20 pt-2 text-xs link-action"
          >
            + Add a missing item to the list
          </button>
        </fieldset>
      ) : null}
    </>
  );
}
