import { prisma } from "../../config/prisma";
import { ApiError } from "../../middleware/error.middleware";
import { createExpenseRecord } from "../expenseRecord.service";
import { allocateProportionally, type ReconciliationMode } from "../../lib/allocation";
import { recordConfirmationFeedback, recordDeletedLine, snapshotItemCategories } from "../extractionFeedback.service";
import { toDTO } from "./dto";
import { CHARGES_DESCRIPTION, type ConfirmInput, type ReceiptSplit } from "./types";

/**
 * Removes a line the owner says was never a purchase.
 *
 * OCR occasionally admits a line that is really register furniture, and the
 * owner is the only one who can tell. Deleting the ROW rather than hiding it
 * client-side is deliberate: `groupItemsIntoSplits` requires every stored item
 * to carry an assignment, so a line the client merely stopped sending would
 * fail confirmation with "Every item on the receipt needs a category" and no
 * way for the owner to act on it.
 *
 * Only while the scan is still Pending. Once confirmed, the items are the
 * evidence for expense records that already exist, and deleting one would
 * leave a record whose breakdown no longer explains its own amount.
 *
 * Removing a line widens the gap between the items and the confirmed total.
 * That is correct and is left to the reconciliation step, which already
 * exists to answer exactly that question.
 */
export async function deleteScanItem(userId: number, receiptScanId: number, itemId: number) {
  const scan = await prisma.receiptScan.findFirst({
    where: { id: receiptScanId, businessProfile: { userId } },
  });
  if (!scan) {
    throw new ApiError(404, "Receipt scan not found");
  }
  if (scan.confirmationStatus === "Confirmed") {
    throw new ApiError(400, "This receipt scan has already been confirmed");
  }

  // Read before the delete, because "OCR read a line that was not a purchase"
  // is a fact about a row that is about to stop existing. Scoped to the scan
  // for the same reason the delete is: an id from someone else's receipt must
  // not be readable by guessing it.
  const doomed = await prisma.receiptScanItem.findFirst({ where: { id: itemId, receiptScanId } });

  const deleted = await prisma.receiptScanItem.deleteMany({ where: { id: itemId, receiptScanId } });
  if (deleted.count === 0) {
    throw new ApiError(404, "Item not found on this receipt scan");
  }

  // After the delete has actually succeeded, so a failed removal cannot leave
  // behind a record of a false positive that was never removed.
  if (doomed) {
    await recordDeletedLine(scan, doomed);
  }

  const [items, pages] = await Promise.all([
    prisma.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } }),
    // Loaded so the returned scan keeps its per-page quality and
    // duplicate-page findings — the review screen re-renders from this
    // response, and dropping them here would make those warnings vanish the
    // moment an owner removed one line.
    prisma.receiptScanPage.findMany({ where: { receiptScanId } }),
  ]);
  return toDTO(scan, items, pages);
}

export async function confirmReceipt(userId: number, receiptScanId: number, input: ConfirmInput) {
  const scan = await prisma.receiptScan.findFirst({
    where: { id: receiptScanId, businessProfile: { userId } },
  });
  if (!scan) {
    throw new ApiError(404, "Receipt scan not found");
  }
  if (scan.confirmationStatus === "Confirmed") {
    throw new ApiError(400, "This receipt scan has already been confirmed");
  }
  /*
   * A scan still being read cannot be confirmed.
   *
   * The clients only show the confirm screen once polling reports "Complete",
   * so this is not reachable through the ordinary flow — but confirming
   * mid-read would race the background write, and the loser would be the
   * owner: the items the split is validated against might not exist yet, so a
   * perfectly correct receipt could be rejected as not adding up, or worse,
   * accepted against a partial reading. Refusing is the only safe answer, and
   * the message names the state rather than blaming their input.
   */
  if (scan.processingStatus === "Processing") {
    throw new ApiError(400, "This receipt is still being read. Try again in a moment.");
  }
  if (scan.processingStatus === "Failed") {
    throw new ApiError(400, "This receipt could not be read. Scan it again.");
  }
  if (!scan.businessProfileId) {
    throw new ApiError(400, "Receipt scan is not linked to a business profile");
  }

  /*
   * The splits must account for the whole receipt, exactly.
   *
   * The total is the number the owner confirmed against the photo, and it is
   * what the receipt actually cost — so it is the anchor, and the split has to
   * reconcile TO it. Silently importing a short split would quietly under-
   * report the expense; silently scaling one to fit would invent numbers the
   * owner never entered. Both are worse than refusing.
   *
   * Compared in centavos because 1200.10 + 800.20 !== 2000.30 in binary
   * floating point, and an owner whose arithmetic is right should never be
   * told it is wrong by a rounding artefact.
   */
  const totalCentavos = Math.round(input.amount * 100);

  /*
   * Every category named anywhere in this request is checked against THIS
   * business before anything is written. Doing it up front rather than at
   * each use matters because owner-added items are persisted below: a
   * validation failure halfway through would leave orphan item rows on the
   * scan that reappear the next time the owner opens it.
   */
  const validCategories = new Set(
    (
      await prisma.expenseCategory.findMany({
        where: { businessProfileId: scan.businessProfileId },
        select: { id: true },
      })
    ).map((c) => c.id),
  );
  const namedCategories = [
    ...(input.itemAssignments ?? []).map((a) => a.categoryId),
    ...(input.additionalItems ?? []).map((i) => i.categoryId),
    ...(input.reconciliation?.mode === "category" ? [input.reconciliation.categoryId] : []),
  ];
  if (namedCategories.some((id) => !validCategories.has(id))) {
    throw new ApiError(400, "Category does not belong to this business profile");
  }

  // The itemised path derives its own splits from the stored items, so the
  // amounts written and the item -> record links written come from the same
  // grouping and cannot drift apart.
  let splits: ReceiptSplit[];
  let ownerAdded: { itemId: number; categoryId: number; name: string; lineNumber: number }[] = [];
  if (input.itemAssignments) {
    ownerAdded = await persistOwnerAddedItems(scan.id, input.additionalItems);
    splits = await groupItemsIntoSplits(scan.id, validCategories, [...input.itemAssignments, ...ownerAdded]);
    splits = reconcileSplits(splits, totalCentavos, input.reconciliation ?? { mode: "none" });
  } else {
    splits = input.splits ?? [];
  }

  /*
   * The categoriser's picks, read before the write below destroys them.
   *
   * Writing the expense records sets each item's categoryId to the owner's
   * choice, so once that loop has run the AI's original answer is gone from
   * the database entirely. Comparing afterwards would compare the owner's
   * choice with itself and conclude the categoriser is never wrong. This is
   * the one signal in the whole feedback loop that cannot be recovered later,
   * which is why it is taken here rather than at the end.
   */
  const priorItems = await snapshotItemCategories(scan.id);

  if (splits.length === 0) {
    throw new ApiError(400, "Assign the receipt to at least one category");
  }

  /*
   * The splits must account for the whole receipt, exactly.
   *
   * On the itemised path reconcileSplits has already closed any legitimate
   * gap, so this is now a POST-CONDITION on that arithmetic rather than the
   * owner's problem to solve — if it ever fires there, the allocation is
   * wrong and must not be written. On the manual-split path it is still the
   * original check on what the owner typed.
   */
  const splitCentavos = splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  if (splitCentavos !== totalCentavos) {
    const difference = (splitCentavos - totalCentavos) / 100;
    throw new ApiError(
      400,
      difference > 0
        ? `The categories add up to PHP ${Math.abs(difference).toFixed(2)} more than the receipt total.`
        : `PHP ${Math.abs(difference).toFixed(2)} of the receipt total is not assigned to a category yet.`,
    );
  }

  // One record per category, all pointing back at this scan. Sequential
  // rather than batched on purpose: a receipt splits into a handful of
  // categories at most, and going through createExpenseRecord keeps the
  // duplicate check, the large-expense rule and their notifications
  // identical to a hand-typed expense.
  const records = [];
  for (const split of splits) {
    const record = await createExpenseRecord(userId, {
      businessProfileId: scan.businessProfileId,
      categoryId: split.categoryId,
      date: input.date,
      description: split.description ?? input.description,
      vendor: input.vendor,
      amount: split.amount,
      allocatedCharges: split.allocatedCharges,
      source: "RECEIPT_SCAN",
      receiptScanId: scan.id,
    });
    records.push(record);

    // Point the items that composed this record at it, so "what made up this
    // PHP 1,850 Ingredients entry" stays answerable after the fact.
    if (split.itemIds && split.itemIds.length > 0) {
      await prisma.receiptScanItem.updateMany({
        where: { id: { in: split.itemIds } },
        data: { expenseRecordId: record.id, categoryId: split.categoryId },
      });
    }
  }

  await prisma.receiptScan.update({
    where: { id: scan.id },
    data: { confirmationStatus: "Confirmed" },
  });

  /*
   * Last, and only once the confirmation has actually succeeded.
   *
   * Everything above can still refuse the request — an unassigned item, a
   * split that does not reconcile — and a refused confirmation is not a
   * judgement on the extraction. Recording feedback earlier would file
   * accuracy data for reviews the owner never completed, and would count the
   * same receipt again each time they corrected the problem and retried.
   *
   * The final category per item comes from `splits` rather than from
   * `input.itemAssignments`: splits are what was actually written, after
   * reconciliation, so the feedback cannot disagree with the records.
   */
  const finalCategoryByItemId = new Map<number, number>();
  for (const split of splits) {
    for (const itemId of split.itemIds ?? []) finalCategoryByItemId.set(itemId, split.categoryId);
  }

  await recordConfirmationFeedback({
    scan,
    confirmed: { date: input.date, vendor: input.vendor, amount: input.amount },
    priorItems,
    finalCategoryByItemId,
    ownerAddedItems: ownerAdded.map((i) => ({ name: i.name, lineNumber: i.lineNumber })),
  });

  return records;
}

/**
 * Persists the lines the owner typed in because OCR missed them.
 *
 * They become ordinary ReceiptScanItem rows so everything downstream —
 * grouping, the item -> record links, the breakdown shown when the record is
 * later opened — treats them like any other line. `addedByOwner` is what keeps
 * them honest: the review panel says FinSight *read* the items off the
 * receipt, and that sentence must not cover a row a human supplied.
 *
 * Line numbers continue after the extracted ones, so a hand-added line sorts
 * to the bottom rather than claiming a position on the printed receipt it
 * never occupied.
 */
async function persistOwnerAddedItems(
  receiptScanId: number,
  additionalItems: { name: string; amount: number; categoryId: number }[] | undefined,
): Promise<{ itemId: number; categoryId: number; name: string; lineNumber: number }[]> {
  if (!additionalItems || additionalItems.length === 0) return [];

  const existing = await prisma.receiptScanItem.findMany({
    where: { receiptScanId },
    select: { lineNumber: true },
  });
  let lineNumber = existing.reduce((max, i) => Math.max(max, i.lineNumber), 0);

  // Name and line number ride back out alongside the ids because each of these
  // is also a line OCR failed to read, which extractionFeedback records as a
  // miss. Returning them here avoids re-reading the rows that were just
  // written just to learn what they say.
  const created: { itemId: number; categoryId: number; name: string; lineNumber: number }[] = [];
  for (const item of additionalItems) {
    lineNumber += 1;
    const row = await prisma.receiptScanItem.create({
      data: {
        receiptScanId,
        lineNumber,
        name: item.name.slice(0, 255),
        // A hand-added line is a name and an amount. Quantity and unit price
        // are left null rather than defaulted to 1 — null means "the receipt
        // didn't say", and inventing a quantity would be a number nobody
        // entered.
        quantity: null,
        unitPrice: null,
        amount: item.amount,
        categoryId: item.categoryId,
        addedByOwner: true,
      },
    });
    created.push({ itemId: row.id, categoryId: item.categoryId, name: row.name, lineNumber: row.lineNumber });
  }
  return created;
}

/**
 * Accounts for the difference between what the items come to and what the
 * receipt actually cost.
 *
 * THE RULE THIS ENFORCES: the total the owner confirmed against the photo is
 * the anchor and is never altered. It is what left their pocket. The gap —
 * VAT a register adds on top, a service charge, a discount taken off — gets
 * allocated to categories instead. The alternative, shrinking the total down
 * to the items, silently under-reports the expense, which is the one thing a
 * spending monitor must not do.
 */
function reconcileSplits(
  splits: ReceiptSplit[],
  totalCentavos: number,
  reconciliation: ReconciliationMode,
): ReceiptSplit[] {
  const itemsCentavos = splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  const gapCentavos = totalCentavos - itemsCentavos;

  // Nothing to account for. A VAT-inclusive receipt — the compliant
  // Philippine case, where the printed prices already contain the tax and the
  // VAT block is only a breakdown — lands here, whatever mode was requested.
  if (gapCentavos === 0) return splits;

  if (reconciliation.mode === "none") {
    const difference = Math.abs(gapCentavos) / 100;
    throw new ApiError(
      400,
      gapCentavos > 0
        ? `The items come to PHP ${difference.toFixed(2)} less than the receipt total. Choose how to account for the difference.`
        : `The items come to PHP ${difference.toFixed(2)} more than the receipt total. Choose how to account for the difference.`,
    );
  }

  if (reconciliation.mode === "category") {
    /*
     * A negative gap is a discount — money the owner did NOT spend. Filing it
     * as its own record would mean a negative expense, which every total,
     * chart and insight downstream would have to learn to handle. Spreading
     * it across the categories that were actually discounted is both the
     * correct accounting and the only shape the rest of the app understands.
     */
    if (gapCentavos < 0) {
      throw new ApiError(
        400,
        "A discount can't be filed as its own expense. Spread it across the item categories instead.",
      );
    }
    return [
      ...splits,
      {
        categoryId: reconciliation.categoryId,
        amount: gapCentavos / 100,
        description: CHARGES_DESCRIPTION,
        allocatedCharges: gapCentavos / 100,
      },
    ];
  }

  // Proportional: each category absorbs the share of the gap that matches its
  // own subtotal, so per-category spending stays truthful. Buy PHP 1,000 of
  // inventory and PHP 500 of equipment with PHP 180 of VAT and inventory
  // carries 120 of it, not 90 and not all 180.
  const weights = splits.map((s) => Math.round(s.amount * 100));
  const shares = allocateProportionally(gapCentavos, weights);

  const reconciled = splits.map((split, i) => ({
    ...split,
    amount: (weights[i]! + shares[i]!) / 100,
    allocatedCharges: shares[i]! / 100,
  }));

  // A discount bigger than a category's own items would drive it to zero or
  // below. Refusing beats writing a record for PHP 0.00 that the owner then
  // has to work out the meaning of.
  if (reconciled.some((s) => s.amount <= 0)) {
    throw new ApiError(
      400,
      "The discount is too large to spread across these categories. Check the receipt total and the item amounts.",
    );
  }

  return reconciled;
}

/**
 * Turns the owner's per-item category choices into one split per category.
 *
 * This is where "one record per category group" is actually decided. A
 * fourteen-item grocery run becomes two records, not fourteen: item-level
 * detail belongs to ReceiptScanItem, while the Records table stays one row
 * per finalised transaction.
 */
async function groupItemsIntoSplits(
  receiptScanId: number,
  validCategories: ReadonlySet<number>,
  assignments: { itemId: number; categoryId: number }[],
): Promise<ReceiptSplit[]> {
  const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
  const chosen = new Map(assignments.map((a) => [a.itemId, a.categoryId]));

  // Every assignment must name an item of THIS scan and a category of THIS
  // business — otherwise a crafted request could file an expense under
  // someone else's category, or attach another receipt's items to it. The
  // category half is checked by the caller, before anything is written.
  const itemIds = new Set(items.map((i) => i.id));
  for (const a of assignments) {
    if (!itemIds.has(a.itemId)) {
      throw new ApiError(400, "An item assignment does not belong to this receipt");
    }
    if (!validCategories.has(a.categoryId)) {
      throw new ApiError(400, "Category does not belong to this business profile");
    }
  }
  if (items.some((i) => !chosen.has(i.id))) {
    throw new ApiError(400, "Every item on the receipt needs a category before saving");
  }

  const groups = new Map<number, { centavos: number; names: string[]; itemIds: number[] }>();
  for (const item of items) {
    const categoryId = chosen.get(item.id)!;
    const group = groups.get(categoryId) ?? { centavos: 0, names: [], itemIds: [] };
    group.centavos += Math.round(Number(item.amount) * 100);
    group.names.push(item.name);
    group.itemIds.push(item.id);
    groups.set(categoryId, group);
  }

  return [...groups.entries()].map(([categoryId, g]) => ({
    categoryId,
    amount: g.centavos / 100,
    // The item names ARE the description — "Buns, Ground beef patty, Eggs
    // tray" says far more on the Records table than "Purchase from Puregold".
    description: g.names.join(", ").slice(0, 255),
    itemIds: g.itemIds,
  }));
}
