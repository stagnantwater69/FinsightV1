import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import type { Prisma, ReceiptScanItem } from "@prisma/client";
import { categoryFromHistory, type ConfirmedCategoryChoice } from "../../lib/categoryHistory";

const UNCATEGORISED = "Uncategorized";
export type ReceiptCategorisationDb = Prisma.TransactionClient | typeof prisma;

/**
 * The standing home for an item nothing else fits.
 *
 * Created per business profile on first need rather than at signup, so a
 * business that never scans a receipt never acquires a category it doesn't
 * use. Matched case-insensitively first, so an owner who already has their
 * own "Uncategorized" keeps it instead of getting a near-duplicate.
 */
export async function ensureUncategorised(
  businessProfileId: number,
  db: ReceiptCategorisationDb = prisma,
): Promise<number> {
  const existing = await db.expenseCategory.findFirst({
    where: { businessProfileId, name: { equals: UNCATEGORISED, mode: "insensitive" } },
  });
  if (existing) return existing.id;
  const created = await db.expenseCategory.create({
    data: {
      businessProfileId,
      name: UNCATEGORISED,
      description: "Items FinSight could not confidently categorise. Reassign them as you review.",
    },
  });
  return created.id;
}

/**
 * How many recent confirmed item choices are considered for an exact local
 * match. Rows are newest first, so a more recent owner correction wins.
 */
const PRIOR_CHOICE_LOOKBACK = 100;

/**
 * What this business has confirmed about receipt items before, newest first.
 * Pending scans and Uncategorized rows are not owner category decisions.
 */
async function recentCategoryChoices(
  businessProfileId: number,
  db: ReceiptCategorisationDb,
): Promise<ConfirmedCategoryChoice[]> {
  const rows = await db.receiptScanItem.findMany({
    where: {
      receiptScan: { businessProfileId, confirmationStatus: "Confirmed" },
      categoryId: { not: null },
      category: { businessProfileId },
    },
    select: {
      name: true,
      category: { select: { id: true, name: true } },
      receiptScan: { select: { extractedVendor: true } },
      expenseRecord: { select: { vendor: true } },
    },
    orderBy: { id: "desc" },
    take: PRIOR_CHOICE_LOOKBACK,
  });

  return rows
    .filter((r) => r.category !== null && r.category.name.toLowerCase() !== UNCATEGORISED.toLowerCase())
    .map((r) => ({
      description: r.name,
      vendor: r.expenseRecord?.vendor ?? r.receiptScan.extractedVendor,
      categoryId: r.category!.id,
      categoryName: r.category!.name,
    }));
}

/**
 * Categorises the extracted lines and stores them against the scan.
 *
 * Categorisation at scan time is deliberately local: only an exact normalized
 * match to the owner's confirmed history is assigned. Everything else stays
 * Uncategorized for review, so receipt-derived text never leaves this worker.
 */
export async function persistCategorisedItems(
  businessProfileId: number,
  receiptScanId: number,
  parsedItems: { name: string; quantity: number | null; unitPrice: number | null; amount: number }[],
  vendor: string | null,
  extractedByVision = false,
  /** Per-item OCR confidence, positionally aligned with parsedItems. */
  amountConfidences: (number | null)[] = [],
  /** Per-item provenance (page + printed line), positionally aligned. Null entries stay unrecorded. */
  itemEvidence: ({ pageNumber: number | null; sourceText: string | null } | null)[] = [],
  db: ReceiptCategorisationDb = prisma,
): Promise<ReceiptScanItem[]> {
  // A recovered attempt replaces any partial result left by the prior worker.
  await db.receiptScanItem.deleteMany({ where: { receiptScanId } });
  if (parsedItems.length === 0) return [];

  const categories = await db.expenseCategory.findMany({
    where: { businessProfileId },
    select: { id: true, name: true },
  });

  // A prior Uncategorized row records no category decision to reuse.
  const assignable = categories.filter((c) => c.name.toLowerCase() !== UNCATEGORISED.toLowerCase());

  let history: ConfirmedCategoryChoice[] = [];
  try {
    history = await recentCategoryChoices(businessProfileId, db);
  } catch {
    logger.error(
      { operation: "receipt-item-categorisation", failureKind: "history-read-failed" },
      "Confirmed category history could not be read; storing items uncategorised",
    );
  }

  const assignableIds = new Set(assignable.map((category) => category.id));
  const categoryByIndex = new Map<number, number>();
  parsedItems.forEach((item, index) => {
    const match = categoryFromHistory(history, item.name, vendor);
    if (match && assignableIds.has(match.categoryId)) categoryByIndex.set(index, match.categoryId);
  });

  // Only pay for the Uncategorized category if something actually needs it.
  const needsFallback = parsedItems.some((_, index) => !categoryByIndex.has(index));
  const uncategorisedId = needsFallback ? await ensureUncategorised(businessProfileId, db) : null;

  await db.receiptScanItem.createMany({
    data: parsedItems.map((item, i) => {
      const evidence = itemEvidence[i] ?? null;
      return {
        receiptScanId,
        lineNumber: i + 1,
        name: item.name.slice(0, 255),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        categoryId: categoryByIndex.get(i) ?? uncategorisedId,
        suggestedCategoryName: null,
        extractedByVision,
        amountConfidence: amountConfidences[i] ?? null,
        // Only when something can actually be pointed at. An entry that would
        // say {null, null} carries no evidence, so none is claimed — the
        // extraction SOURCE is already on extractedByVision.
        evidence:
          evidence && (evidence.pageNumber !== null || evidence.sourceText !== null)
            ? ({
                pageNumber: evidence.pageNumber,
                sourceText: evidence.sourceText,
                source: extractedByVision ? "vision" : "ocr",
              } as Prisma.InputJsonValue)
            : undefined,
      };
    }),
  });

  return db.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
}
