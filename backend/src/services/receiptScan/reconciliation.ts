import { Prisma, ReceiptPurgeMode } from "@prisma/client";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../middleware/error.middleware";
import { createExpenseRecordWithin, type BulkDbClient } from "../expenseRecord.service";
import { allocateProportionally, type ReconciliationMode } from "../../lib/allocation";
import { recordConfirmationFeedback, snapshotItemCategories } from "../extractionFeedback.service";
import {
  lockReceiptCaptureBatchForMutation,
  refreshReceiptCaptureBatchStatus,
} from "../receiptCaptureBatch.service";
import { evaluateReceiptDuplicateGate } from "../receiptDuplicate.service";
import { resolveConfirmationMode } from "./confirmMode";
import { toDTO } from "./dto";
import { CHARGES_DESCRIPTION, type ConfirmInput, type ReceiptSplit } from "./types";
import { requiresManualCurrencyConversion } from "../../lib/receiptDetails";

interface ItemUpdateInput {
  name: string;
  amount: number;
  expectedScanRevision: number;
}

async function claimEditableScan(
  tx: Prisma.TransactionClient,
  userId: number,
  receiptScanId: number,
  expectedScanRevision: number | undefined,
  nonEditableStatus: 400 | 409,
): Promise<void> {
  const current = await tx.receiptScan.findFirst({
    where: {
      id: receiptScanId,
      businessProfile: { userId },
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
    select: { confirmationStatus: true, processingStatus: true, scanRevision: true },
  });
  if (!current) throw new ApiError(404, "Receipt scan not found");
  if (current.confirmationStatus !== "Pending") {
    throw new ApiError(nonEditableStatus, "This receipt scan has already been confirmed");
  }
  if (current.processingStatus !== "Complete") {
    throw new ApiError(nonEditableStatus, "This receipt must finish processing before its items can be edited");
  }
  if (expectedScanRevision !== undefined && current.scanRevision !== expectedScanRevision) {
    throw new ApiError(409, "This receipt changed while you were editing it. Review the latest result and try again.");
  }

  const revision = expectedScanRevision ?? current.scanRevision;
  const claimed = await tx.receiptScan.updateMany({
    where: {
      id: receiptScanId,
      businessProfile: { userId },
      confirmationStatus: "Pending",
      processingStatus: "Complete",
      scanRevision: revision,
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
    // Item edits move the abandoned-scan clock; stamping the claim covers
    // both update and delete inside their own transaction.
    data: { scanRevision: { increment: 1 }, lastActivityAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, "This receipt changed while you were editing it. Review the latest result and try again.");
  }
}

async function editableScanDTO(tx: Prisma.TransactionClient, receiptScanId: number) {
  const scan = await tx.receiptScan.findUniqueOrThrow({
    where: { id: receiptScanId },
    include: {
      corrections: true,
      items: { orderBy: { lineNumber: "asc" } },
      pages: true,
    },
  });
  return toDTO(scan, scan.items, scan.pages, scan.corrections);
}

export async function updateScanItem(
  userId: number,
  receiptScanId: number,
  itemId: number,
  input: ItemUpdateInput,
) {
  return prisma.$transaction(async (tx) => {
    await claimEditableScan(tx, userId, receiptScanId, input.expectedScanRevision, 409);

    const item = await tx.receiptScanItem.findFirst({
      where: { id: itemId, receiptScanId },
    });
    if (!item) throw new ApiError(404, "Item not found on this receipt scan");

    const nameChanged = item.name !== input.name;
    const amountChanged = !item.amount.equals(new Prisma.Decimal(input.amount));
    const earlierCorrections = await tx.receiptFieldCorrection.findMany({
      where: {
        receiptScanId,
        lineNumber: item.lineNumber,
        field: { in: ["itemName", "itemAmount"] },
        wasEdited: true,
      },
      select: { field: true },
    });
    const earlierFields = new Set(earlierCorrections.map((correction) => correction.field));

    await tx.receiptScanItem.update({
      where: { id: item.id },
      data: {
        name: input.name,
        amount: new Prisma.Decimal(input.amount),
        ...(amountChanged ? { amountConfidence: null } : {}),
      },
    });

    const source = item.extractedByVision ? "vision" : "ocr";
    const corrections: Prisma.ReceiptFieldCorrectionCreateManyInput[] = [];
    if (nameChanged) {
      corrections.push({
        receiptScanId,
        lineNumber: item.lineNumber,
        field: "itemName",
        source: earlierFields.has("itemName") ? "owner" : source,
        originalValue: item.name,
        finalValue: input.name,
        itemName: input.name,
        confidence: null,
        wasEdited: true,
      });
    }
    if (amountChanged) {
      corrections.push({
        receiptScanId,
        lineNumber: item.lineNumber,
        field: "itemAmount",
        source: earlierFields.has("itemAmount") ? "owner" : source,
        originalValue: Number(item.amount).toFixed(2),
        finalValue: input.amount.toFixed(2),
        itemName: input.name,
        confidence: earlierFields.has("itemAmount") ? null : item.amountConfidence,
        wasEdited: true,
      });
    }
    if (corrections.length > 0) {
      await tx.receiptFieldCorrection.createMany({ data: corrections });
    }

    return editableScanDTO(tx, receiptScanId);
  });
}

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
export async function deleteScanItem(
  userId: number,
  receiptScanId: number,
  itemId: number,
  expectedScanRevision?: number,
) {
  return prisma.$transaction(async (tx) => {
    await claimEditableScan(tx, userId, receiptScanId, expectedScanRevision, 400);

    const item = await tx.receiptScanItem.findFirst({ where: { id: itemId, receiptScanId } });
    if (!item) throw new ApiError(404, "Item not found on this receipt scan");

    await tx.receiptScanItem.delete({ where: { id: item.id } });
    if (!item.addedByOwner) {
      await tx.receiptFieldCorrection.create({
        data: {
          receiptScanId,
          field: "itemPresence",
          source: item.extractedByVision ? "vision" : "ocr",
          originalValue: item.name,
          finalValue: null,
          itemName: item.name,
          lineNumber: item.lineNumber,
          confidence: item.amountConfidence,
          wasEdited: true,
        },
      });
    }

    return editableScanDTO(tx, receiptScanId);
  });
}

export async function confirmReceipt(userId: number, receiptScanId: number, input: ConfirmInput) {
  // Refused before any read: a body that mixes the two modes carries
  // financial input one of the paths below would never look at.
  const confirmation = resolveConfirmationMode(input);

  const scan = await prisma.receiptScan.findFirst({
    where: {
      id: receiptScanId,
      businessProfile: { userId },
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
  });
  if (!scan) {
    throw new ApiError(404, "Receipt scan not found");
  }
  if (scan.confirmationStatus === "Confirmed") {
    throw new ApiError(400, "This receipt scan has already been confirmed");
  }
  if (input.expectedScanRevision !== undefined && input.expectedScanRevision !== scan.scanRevision) {
    throw new ApiError(409, "This receipt changed while you were reviewing it. Review the latest result and try again.");
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
  if (requiresManualCurrencyConversion(scan.rawText)) {
    throw new ApiError(400, "This receipt uses a foreign currency. Enter an expense manually with the amount paid in PHP.");
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
   * business before the transaction opens, so an obviously bad payload is
   * refused with a 400 without ever taking the claim on the scan row.
   */
  const validCategories = new Set(
    (
      await prisma.expenseCategory.findMany({
        where: { businessProfileId: scan.businessProfileId },
        select: { id: true },
      })
    ).map((c) => c.id),
  );
  const namedCategories = confirmation.mode === "itemised"
    ? [
        ...confirmation.itemAssignments.map((a) => a.categoryId),
        ...confirmation.additionalItems.map((i) => i.categoryId),
        ...(confirmation.reconciliation.mode === "category" ? [confirmation.reconciliation.categoryId] : []),
      ]
    : [];
  if (namedCategories.some((id) => !validCategories.has(id))) {
    throw new ApiError(400, "Category does not belong to this business profile");
  }

  /*
   * The categoriser's picks, read before the write below destroys them.
   *
   * Writing the expense records sets each item's categoryId to the owner's
   * choice, so once that loop has run the AI's original answer is gone from
   * the database entirely. Comparing afterwards would compare the owner's
   * choice with itself and conclude the categoriser is never wrong. This is
   * the one signal in the whole feedback loop that cannot be recovered later,
   * which is why it is taken here rather than at the end. Owner-added lines
   * are excluded by that query, so it does not need to wait for them.
   */
  const priorItems = await snapshotItemCategories(scan.id);

  const businessProfileId = scan.businessProfileId;

  /*
   * EVERYTHING THE CONFIRMATION WRITES, IN ONE TRANSACTION.
   *
   * Three separate ways this used to corrupt the books or the review, all
   * fixed by the same unit of work:
   *
   * 1. TWO CONFIRMS AT ONCE. The read guard near the top of this function and
   *    the flip to Confirmed used to sit ~140 awaited lines apart, so a double
   *    tap on a slow connection put both requests past the guard and both
   *    wrote a complete set of expense records — a receipt booked twice, with
   *    neither copy flagged, because the duplicate detector raced too. The
   *    conditional updateMany below is the claim: it is the FIRST statement in
   *    the transaction, so the loser blocks on that row until the winner
   *    commits and then matches zero rows, because the status is no longer
   *    Pending. Same discipline as claimImportBatch in csvImport.service.ts.
   *
   * 2. A FAILURE MID-LOOP. The record writes used to commit one at a time with
   *    the status flip last, so an error on the third split left two expense
   *    records booked against a scan that was still Pending — the owner saw a
   *    failure, retried, and booked the first two a second time. Inside the
   *    transaction there is no such half state: either the whole receipt is
   *    booked and the scan is Confirmed, or nothing happened at all.
   *
   * 3. OWNER-ADDED LINES. The rows for lines the owner typed in used to be
   *    written before the transaction, so any rejection after that point — a
   *    total that did not reconcile, an unassigned item, the post-condition
   *    below — left them on the scan. The retry then wrote a second copy and
   *    failed on the first, which carried no assignment. They are written
   *    after the claim now, and the validation that can refuse them runs in
   *    here too, so a refused or failed confirmation leaves none behind.
   *    One consequence: a concurrent loser answers 409 regardless of whether
   *    its own payload would have reconciled, because the claim comes first.
   *
   * The side effects each record create would normally fire — the duplicate
   * and large-expense notifications, the queued analysis job — come back as
   * thunks and run after the COMMIT. A notification that fails to send must
   * never roll back the books, and the analysis job carries a foreign key to a
   * record that does not exist outside the transaction yet.
   */
  const outcome = await prisma.$transaction(
    async (tx) => {
      if (
        scan.captureBatchId !== null
        && !(await lockReceiptCaptureBatchForMutation(tx, scan.captureBatchId))
      ) {
        throw new ApiError(409, "This receipt batch is no longer available");
      }
      const duplicateGate = await evaluateReceiptDuplicateGate(tx, {
        userId,
        businessProfileId,
        receiptScanId: scan.id,
        date: input.date,
        vendor: input.vendor,
        description: input.description,
        amount: input.amount,
        sourceImageHash: scan.sourceImageHash,
        decision: input.duplicateDecision,
      });
      if (duplicateGate.kind === "review-required") return duplicateGate;

      const claimed = await tx.receiptScan.updateMany({
        where: {
          id: scan.id,
          businessProfileId,
          businessProfile: { userId },
          confirmationStatus: "Pending",
          processingStatus: "Complete",
          scanRevision: input.expectedScanRevision ?? scan.scanRevision,
          evidenceDeletionRequestedAt: null,
          purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
        },
        data: {
          confirmationStatus: "Confirmed",
          extractedDate: new Date(`${input.date}T00:00:00.000Z`),
          extractedVendor: input.vendor ?? null,
          extractedDescription: input.description,
          extractedAmount: new Prisma.Decimal(input.amount),
          semanticFingerprint: duplicateGate.sourceFingerprint,
        },
      });
      if (claimed.count === 0) {
        // 409 rather than the 400 the read guard gives: the guard answers
        // "you already did this", this answers "someone is doing it right
        // now". The books are intact either way, and the client's retry will
        // find the scan confirmed.
        throw new ApiError(409, "This receipt scan is already being confirmed");
      }

      // The itemised path derives its own splits from the stored items, so the
      // amounts written and the item -> record links written come from the same
      // grouping and cannot drift apart.
      let splits: ReceiptSplit[];
      let ownerAdded: { itemId: number; categoryId: number; name: string; lineNumber: number }[] = [];
      if (confirmation.mode === "itemised") {
        ownerAdded = await persistOwnerAddedItems(tx, scan.id, confirmation.additionalItems);
        splits = await groupItemsIntoSplits(tx, scan.id, validCategories, [...confirmation.itemAssignments, ...ownerAdded]);
        splits = reconcileSplits(splits, totalCentavos, confirmation.reconciliation);
      } else {
        splits = confirmation.splits;
      }

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
       * original check on what the owner typed. Throwing here rolls back the
       * claim and any owner-added rows along with it.
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
      // categories at most, and going through the shared create keeps the
      // duplicate check, the large-expense rule and their notifications
      // identical to a hand-typed expense.
      const created = [];
      const effects: (() => Promise<void>)[] = [];
      for (const split of splits) {
        const { record, runSideEffects } = await createExpenseRecordWithin(
          userId,
          {
            businessProfileId,
            categoryId: split.categoryId,
            date: input.date,
            description: split.description ?? input.description,
            vendor: input.vendor,
            amount: split.amount,
            allocatedCharges: split.allocatedCharges,
            source: "RECEIPT_SCAN",
            receiptScanId: scan.id,
          },
          tx,
        );
        created.push(record);
        effects.push(runSideEffects);

        // Point the items that composed this record at it, so "what made up
        // this PHP 1,850 Ingredients entry" stays answerable after the fact.
        // Scoped to THIS scan like its siblings above: an item id is the one
        // value in this request that names a row directly, and an id belonging
        // to another owner's receipt must not be writable by guessing it.
        if (split.itemIds && split.itemIds.length > 0) {
          await tx.receiptScanItem.updateMany({
            where: { id: { in: split.itemIds }, receiptScanId: scan.id },
            data: { expenseRecordId: record.id, categoryId: split.categoryId },
          });
        }
      }

      if (scan.captureBatchId !== null) {
        await refreshReceiptCaptureBatchStatus(tx, scan.captureBatchId);
      }

      return {
        kind: "confirmed" as const,
        records: created,
        deferredEffects: effects,
        splits,
        ownerAdded,
      };
    },
    // Generous relative to the handful of statements above, because a second
    // confirm of the same scan waits here on the claim's row lock rather than
    // failing fast, and the default 5s would turn an ordinary slow commit into
    // a spurious error on a receipt that is perfectly fine.
    { timeout: 20_000, maxWait: 10_000 },
  );

  if (outcome.kind === "review-required") {
    throw new ApiError(
      409,
      outcome.code === "DUPLICATE_REVIEW_CHANGED"
        ? "The possible matches changed while you were reviewing them. Review the latest matches before saving."
        : "This receipt may already be recorded. Review the possible matches before saving.",
      {
        code: outcome.code,
        responseDetails: {
          sourceFingerprint: outcome.sourceFingerprint,
          candidateSetHash: outcome.candidateSetHash,
          candidates: outcome.candidates,
          candidateCount: outcome.candidateCount,
          candidatesTruncated: outcome.candidatesTruncated,
          nextCursor: outcome.nextCursor,
        },
      },
    );
  }

  const { records, deferredEffects, splits, ownerAdded } = outcome;

  /*
   * Everything from here on runs after COMMIT and is noncritical: the books
   * are already written and the scan is already Confirmed. A failure here is
   * logged and the committed records are still returned, because a 500 at
   * this point told the owner a booked receipt had failed and invited a retry
   * that could only answer "already confirmed".
   */
  for (const [index, runSideEffects] of deferredEffects.entries()) {
    await runPostCommitEffect("expense-record-side-effects", scan.id, records[index]?.id, runSideEffects);
  }

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

  await runPostCommitEffect("confirmation-feedback", scan.id, undefined, () =>
    recordConfirmationFeedback({
      scan,
      confirmed: { date: input.date, vendor: input.vendor, amount: input.amount },
      priorItems,
      finalCategoryByItemId,
      ownerAddedItems: ownerAdded.map((i) => ({ name: i.name, lineNumber: i.lineNumber })),
    }));

  return records;
}

/**
 * Runs one post-commit effect of a confirmation and swallows its failure.
 *
 * Only identifiers reach the log. The receipt's vendor, amounts and item
 * names never do, and the thrown error is passed through as-is for the same
 * key-based redaction every other logged error gets.
 */
async function runPostCommitEffect(
  effect: "expense-record-side-effects" | "confirmation-feedback",
  receiptScanId: number,
  expenseRecordId: number | undefined,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    logger.error(
      { err, receiptScanId, expenseRecordId, effect, code: "RECEIPT_CONFIRM_POST_COMMIT_EFFECT_FAILED" },
      "receipt confirmation post-commit effect failed",
    );
  }
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
 *
 * Written through `db` — the confirmation's transaction client — so a
 * confirmation that is refused or fails after this point leaves none of these
 * rows behind. They used to be written up front with the global client, and
 * every later rejection (a total that did not reconcile, an unassigned line,
 * a failed record write) left them on the scan as orphans; the retry then
 * created a second copy and failed on the first one, which had no assignment.
 */
async function persistOwnerAddedItems(
  db: BulkDbClient,
  receiptScanId: number,
  additionalItems: { name: string; amount: number; categoryId: number }[],
): Promise<{ itemId: number; categoryId: number; name: string; lineNumber: number }[]> {
  if (additionalItems.length === 0) return [];

  const existing = await db.receiptScanItem.findMany({
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
    const row = await db.receiptScanItem.create({
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
  db: BulkDbClient,
  receiptScanId: number,
  validCategories: ReadonlySet<number>,
  assignments: { itemId: number; categoryId: number }[],
): Promise<ReceiptSplit[]> {
  // Read through the same client that just wrote the owner-added rows: inside
  // the confirmation transaction those rows are not yet visible to the global
  // client, and reading past them here would reject every hand-added line as
  // "not on this receipt".
  const items = await db.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
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
