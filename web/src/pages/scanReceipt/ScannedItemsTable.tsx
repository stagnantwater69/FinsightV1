import type { Dispatch, SetStateAction } from "react";
import { Button } from "../../components/Button";
import { CategorySelect } from "../../components/CategorySelect";
import { MoneyInput, TextInput } from "../../components/Field";
import { Money } from "../../components/Money";
import { BAND_COPY, confidenceBand } from "../../lib/confidenceBands";
import { EvidenceNote } from "./EvidenceNote";
import { scannedItemRemoveId, scannedItemRowId } from "./helpers";
import type { AddedItem, ReceiptScanResult, ScannedItem } from "./types";

// Temporarily hidden; set to true to restore the per-item photo extraction label.
const SHOW_AI_PHOTO_EXTRACTION_LABEL = false;

/** An extracted line whose name and amount are open for correction. */
export interface EditingItem {
  id: number;
  name: string;
  amount: number | "";
}

export function ScannedItemsTable({
  scan,
  items,
  editingItem,
  setEditingItem,
  updatingItemId,
  removingItemId,
  keptRepeatItemIds,
  setKeptRepeatItemIds,
  itemCategories,
  setItemCategories,
  setReviewDirty,
  categoryReviewNote,
  suggestedNewCategoryFor,
  creatingCategoryFor,
  acceptSuggestedCategory,
  saveItemEdit,
  beginItemEdit,
  removeScannedItem,
  addedItems,
  updateAddedItem,
  removeAddedItem,
}: {
  scan: ReceiptScanResult;
  items: ScannedItem[];
  editingItem: EditingItem | null;
  setEditingItem: Dispatch<SetStateAction<EditingItem | null>>;
  updatingItemId: number | null;
  removingItemId: number | null;
  keptRepeatItemIds: ReadonlySet<number>;
  setKeptRepeatItemIds: Dispatch<SetStateAction<ReadonlySet<number>>>;
  itemCategories: Record<number, number | "">;
  setItemCategories: Dispatch<SetStateAction<Record<number, number | "">>>;
  setReviewDirty: (dirty: boolean) => void;
  categoryReviewNote: (item: ScannedItem) => string | null;
  suggestedNewCategoryFor: (item: ScannedItem) => string | null;
  creatingCategoryFor: string | null;
  acceptSuggestedCategory: (name: string) => Promise<void>;
  saveItemEdit: () => Promise<void>;
  beginItemEdit: (item: ScannedItem) => void;
  removeScannedItem: (item: ScannedItem) => Promise<void>;
  addedItems: AddedItem[];
  updateAddedItem: (key: string, patch: Partial<Omit<AddedItem, "key">>) => void;
  removeAddedItem: (key: string) => void;
}) {
  return (
    <div className="mt-2 overflow-x-auto rounded-xl border border-paper-200">
      <table className="w-full min-w-[38rem] text-left text-sm">
        <caption className="sr-only">
          Each item read from the receipt, with the category it will be filed under
        </caption>
        <thead>
          <tr className="border-b border-paper-200 bg-paper-100">
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
              Item
            </th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
              Qty
            </th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
              Price
            </th>
            <th scope="col" className="w-56 px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-600">
              Category
            </th>
            <th scope="col" className="w-24 px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} id={scannedItemRowId(item.id)} className="border-t border-paper-200 align-middle">
              <td className="px-3 py-2 text-ink-800">
                {editingItem?.id === item.id ? (
                  <>
                    <label htmlFor={`item-name-${item.id}`} className="sr-only">
                      Item name
                    </label>
                    <TextInput
                      id={`item-name-${item.id}`}
                      value={editingItem.name}
                      onChange={(event) =>
                        setEditingItem((current) => current
                          ? { ...current, name: event.target.value }
                          : current)
                      }
                    />
                  </>
                ) : (
                  item.name
                )}
                {/*
                  When the items do not add up, the server names
                  the line it is least sure of. Pointing beats
                  asking the owner to re-read all nine — and it
                  never changes the figure, because the right
                  value is not something the engine knows.
                */}
                {scan.suspectItemId === item.id ? (
                  <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent ring-1 ring-edge-accent align-middle">
                    <span aria-hidden>⚠</span>
                    Check this one first
                  </span>
                ) : null}
                {/*
                  Marked per row, not just once at the top, because
                  the row is where the owner decides. A line a model
                  inferred from a photograph should look different
                  from one read off text at the moment it is checked.
                */}
                {SHOW_AI_PHOTO_EXTRACTION_LABEL && item.extractedByVision ? (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent ring-1 ring-edge-accent align-middle">
                    <span aria-hidden>✦</span>
                    AI read this from the photo
                  </span>
                ) : null}
                {item.ownerEditedFields?.length ? (
                  <span className="ml-1.5 inline-flex rounded-full bg-tint-brand px-1.5 py-0.5 text-[10px] font-medium text-tone-brand ring-1 ring-edge-brand align-middle">
                    Corrected by you
                  </span>
                ) : null}
                {/*
                  The printed line this row came off, quoted. It is
                  the cheapest possible way to check a row: the
                  owner compares two strings instead of hunting the
                  paper for a number.
                */}
                {item.evidence ? (
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-500">
                    <EvidenceNote evidence={item.evidence} />
                  </span>
                ) : null}
                {/*
                  A line that may be the overlap between two photos
                  read twice. FinSight removes a repeat on its own
                  only when the receipt's total proves it; anything
                  short of that is the owner's call, made on the row.
                */}
                {item.possibleRepeatOf && !keptRepeatItemIds.has(item.id) ? (
                  <span className="mt-1.5 block rounded-lg border border-edge-accent bg-tint-accent px-2 py-1.5 text-xs text-tone-accent">
                    May be counted twice. Your photos overlap, and page {item.possibleRepeatOf.pageNumber} also shows{" "}
                    {item.possibleRepeatOf.name} for PHP {item.possibleRepeatOf.amount.toFixed(2)}.
                    <span className="mt-1.5 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`Remove ${item.name}, it repeats page ${item.possibleRepeatOf.pageNumber}`}
                        disabled={editingItem !== null || removingItemId !== null}
                        onClick={() => void removeScannedItem(item)}
                      >
                        Remove repeat
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Keep ${item.name}, it is a separate purchase`}
                        disabled={removingItemId === item.id}
                        onClick={() => setKeptRepeatItemIds((current) => new Set(current).add(item.id))}
                      >
                        Keep both
                      </Button>
                    </span>
                  </span>
                ) : null}
              </td>
              <td className="figure px-3 py-2 text-right text-ink-600">
                {item.quantity ?? "Not listed"}
              </td>
              <td className="px-3 py-2 text-right">
                {editingItem?.id === item.id ? (
                  <>
                    <label htmlFor={`item-amount-${item.id}`} className="sr-only">
                      Item amount
                    </label>
                    <MoneyInput
                      id={`item-amount-${item.id}`}
                      min={0.01}
                      value={editingItem.amount}
                      onChange={(event) =>
                        setEditingItem((current) => current
                          ? {
                              ...current,
                              amount: event.target.value === "" ? "" : Number(event.target.value),
                            }
                          : current)
                      }
                    />
                  </>
                ) : (
                  <Money value={item.amount} decimals />
                )}
                {/*
                  The engine's own doubt about THIS figure. Shown
                  only when it is low enough to act on — a
                  percentage beside every correct price would be
                  noise, and noise is what stops people checking.
                */}
                {/*
                  The engine's own doubt about THIS figure, as a
                  band rather than "72% sure". Same mapping as the
                  header cue (lib/confidenceBands.ts) — before
                  this, the page used 80/60 and the item badge used
                  75, so a receipt could read "clear" above a row
                  the same engine was unsure of. The raw figure
                  stays in the title, as evidence.
                */}
                {confidenceBand({
                  confidence: item.amountConfidence,
                  visionAssisted: item.extractedByVision,
                }) !== "clear" && typeof item.amountConfidence === "number" ? (
                  <span
                    className="mt-0.5 block text-[10px] font-medium text-tone-accent"
                    title={`FinSight's own confidence reading this amount: ${item.amountConfidence}%`}
                  >
                    {BAND_COPY[
                      confidenceBand({
                        confidence: item.amountConfidence,
                        visionAssisted: item.extractedByVision,
                      })
                    ].label}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <label htmlFor={`item-category-${item.id}`} className="sr-only">
                  Category for {item.name}
                </label>
                <CategorySelect
                  id={`item-category-${item.id}`}
                  value={itemCategories[item.id] ?? ""}
                  onChange={(categoryId) => {
                    setReviewDirty(true);
                    setItemCategories((prev) => ({ ...prev, [item.id]: categoryId }));
                  }}
                />
                {/*
                  Why FinSight is unsure of this line's category,
                  in the row's own "check this" style (the amount
                  band above uses the same tone).
                */}
                {categoryReviewNote(item) ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-tone-accent">
                    {categoryReviewNote(item)}
                  </p>
                ) : null}
                {/*
                  A category FinSight thinks is missing.

                  Shown only where it is still useful — see
                  suggestedNewCategoryFor. Phrased as an offer
                  rather than an assignment, because nothing is
                  created until the owner says so; the whole
                  reason this is a suggestion and not a decision
                  is that inventing categories in someone's books
                  is not FinSight's call to make.
                */}
                {suggestedNewCategoryFor(item) ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
                    <span aria-hidden className="text-tone-accent">
                      ✦
                    </span>{" "}
                    Nothing fits this. FinSight suggests a new category,{" "}
                    <b className="font-semibold text-ink-700">{item.suggestedCategoryName}</b>.{" "}
                    <button
                      type="button"
                      onClick={() => acceptSuggestedCategory(item.suggestedCategoryName!)}
                      disabled={creatingCategoryFor !== null}
                      className="tap-inline disabled:opacity-50 link"
                    >
                      {creatingCategoryFor === item.suggestedCategoryName
                        ? "Creating…"
                        : "Create it"}
                      <span className="sr-only"> and file {item.name} under it</span>
                    </button>
                  </p>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                  {editingItem?.id === item.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void saveItemEdit()}
                        disabled={updatingItemId === item.id}
                        className="tap-inline shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand disabled:opacity-50"
                      >
                        {updatingItemId === item.id ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingItem(null)}
                        disabled={updatingItemId === item.id}
                        className="tap-inline shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-ink-600 transition hover:bg-paper-100 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Edit ${item.name}`}
                      onClick={() => beginItemEdit(item)}
                      disabled={editingItem !== null || removingItemId !== null}
                      className="tap-inline shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand disabled:opacity-50"
                    >
                      Edit
                    </button>
                  )}
                  {/*
                    Disabled while ANY row is being removed, not
                    just this one. Each × sends the scan revision
                    it was rendered with, so a second click during
                    a delete in flight comes back 409 — "this
                    receipt changed in another request" — for a
                    change the owner made themselves a moment ago.
                  */}
                  <button
                    type="button"
                    id={scannedItemRemoveId(item.id)}
                    onClick={() => void removeScannedItem(item)}
                    disabled={removingItemId !== null || editingItem !== null}
                    className="tap-inline flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-ink-500 transition hover:bg-paper-100 hover:text-tone-danger disabled:opacity-50"
                  >
                    <span aria-hidden>×</span>
                    <span className="sr-only">
                      Remove {item.name}. This was not a purchase
                    </span>
                  </button>
                </div>

              </td>
            </tr>
          ))}

          {/*
            Lines the owner is adding because OCR missed them.

            Kept visually distinct from the extracted rows: the
            panel above claims FinSight READ these items off the
            receipt, and that claim must not quietly extend to a
            row a human typed. The same distinction is stored
            server-side (ReceiptScanItem.addedByOwner) so it
            survives onto the saved record.
          */}
          {addedItems.map((added, i) => (
            <tr key={added.key} className="border-t border-paper-200 bg-paper-50 align-middle">
              <td className="px-3 py-2">
                <label htmlFor={`added-name-${added.key}`} className="sr-only">
                  Name for added item {i + 1}
                </label>
                <TextInput
                  id={`added-name-${added.key}`}
                  placeholder="Item name"
                  value={added.name}
                  onChange={(e) => updateAddedItem(added.key, { name: e.target.value })}
                />
              </td>
              <td className="px-3 py-2 text-right text-ink-500">Not listed</td>
              <td className="px-3 py-2">
                <label htmlFor={`added-amount-${added.key}`} className="sr-only">
                  Amount for added item {i + 1}
                </label>
                <MoneyInput
                  id={`added-amount-${added.key}`}
                  min={0.01}
                  value={added.amount}
                  onChange={(e) =>
                    updateAddedItem(added.key, {
                      amount: e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
              </td>
              <td className="px-3 py-2">
                <label htmlFor={`added-category-${added.key}`} className="sr-only">
                  Category for added item {i + 1}
                </label>
                <CategorySelect
                  id={`added-category-${added.key}`}
                  value={added.categoryId}
                  onChange={(categoryId) => updateAddedItem(added.key, { categoryId })}
                />
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => removeAddedItem(added.key)}
                    className="tap-inline flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-ink-500 transition hover:bg-paper-100 hover:text-tone-danger"
                  >
                    <span aria-hidden>×</span>
                    <span className="sr-only">Remove added item {i + 1}</span>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
