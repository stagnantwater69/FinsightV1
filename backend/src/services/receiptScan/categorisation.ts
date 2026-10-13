import type { ReceiptItemEvidenceInput } from "./types";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import type { Prisma, ReceiptScanItem } from "@prisma/client";
import { categoryFromHistory, type ConfirmedCategoryChoice } from "../../lib/categoryHistory";
import { categoriseReceiptLines, type CategoryDecision } from "../../lib/itemCategoriser";
import {
  categoryKind,
  findExistingCategory,
  taxonomyEntry,
  type ExpenseKind,
  type TaxonomyKey,
} from "../../lib/expenseTaxonomy";

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
 * How one item's category was chosen, stored with the item for the review
 * screen: whether to ask the owner to look, and why.
 */
export interface ItemCategorisation {
  /** "medium" at most — D0-03 reserves "high" for a rule the owner wrote. */
  confidence: "medium" | "low";
  /** history: the owner filed this exact item before; item: its own words; shop: the kind of shop; none: nothing fitted. */
  source: "history" | "item" | "shop" | "none";
  kind: ExpenseKind | null;
  /** Owner-facing, shown when the choice needs a look. Null when there is nothing to say. */
  reason: string | null;
  /** The category was created by this scan, because the business had nothing matching. */
  newCategory: boolean;
}

/**
 * The standard categories the decisions need that the business does not have
 * yet, created in one statement.
 *
 * INSERT ... ON CONFLICT DO NOTHING, not a check-then-create: a concurrent
 * scan of the same business creating the same category would otherwise hit
 * the (businessProfileId, name) unique constraint, and in PostgreSQL a failed
 * statement aborts the whole transaction the lease-guarded write runs in.
 * Only ever names from the taxonomy, so the same category is never created
 * twice under two spellings.
 */
async function ensureTaxonomyCategories(
  businessProfileId: number,
  keys: TaxonomyKey[],
  db: ReceiptCategorisationDb,
): Promise<Map<TaxonomyKey, number>> {
  const ids = new Map<TaxonomyKey, number>();
  if (keys.length === 0) return ids;
  await db.expenseCategory.createMany({
    data: keys.map((key) => ({
      businessProfileId,
      name: taxonomyEntry(key).name,
      description: taxonomyEntry(key).description,
    })),
    skipDuplicates: true,
  });
  const created = await db.expenseCategory.findMany({
    where: { businessProfileId, name: { in: keys.map((key) => taxonomyEntry(key).name) } },
    select: { id: true, name: true },
  });
  for (const key of keys) {
    const category = created.find((row) => row.name === taxonomyEntry(key).name);
    if (category) ids.set(key, category.id);
  }
  return ids;
}

/**
 * Categorises the extracted lines and stores them against the scan.
 *
 * LOCAL, per D0-03 — no receipt text leaves this worker for it:
 *
 *   1. The owner's own earlier decision for this exact item and vendor.
 *   2. The business-first categoriser (lib/itemCategoriser): what the item is,
 *      read against what the business does and what else is on the receipt.
 *   3. The decision lands in the owner's existing category for it, under any
 *      of its usual names; only when there is none is the standard category
 *      created. Nothing fits at all: Uncategorized, flagged for the owner.
 *
 * Every assignment is a draft the owner reviews before anything is saved, and
 * the review screen keeps whatever the owner changes.
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
  itemEvidence: (ReceiptItemEvidenceInput | null)[] = [],
  db: ReceiptCategorisationDb = prisma,
): Promise<ReceiptScanItem[]> {
  // A recovered attempt replaces any partial result left by the prior worker.
  await db.receiptScanItem.deleteMany({ where: { receiptScanId } });
  if (parsedItems.length === 0) return [];

  const [categories, profile] = await Promise.all([
    // Oldest first, so the choice between two matching categories never depends on row order.
    db.expenseCategory.findMany({ where: { businessProfileId }, select: { id: true, name: true }, orderBy: { id: "asc" } }),
    db.businessProfile.findUnique({ where: { id: businessProfileId }, select: { type: true } }),
  ]);

  // A prior Uncategorized row records no category decision to reuse.
  const assignable = categories.filter((c) => c.name.toLowerCase() !== UNCATEGORISED.toLowerCase());

  let history: ConfirmedCategoryChoice[] = [];
  try {
    history = await recentCategoryChoices(businessProfileId, db);
  } catch {
    logger.error(
      { operation: "receipt-item-categorisation", failureKind: "history-read-failed" },
      "Confirmed category history could not be read; categorising without it",
    );
  }

  const assignableIds = new Set(assignable.map((category) => category.id));
  const categoryByIndex = new Map<number, number>();
  const categorisationByIndex = new Map<number, ItemCategorisation>();
  parsedItems.forEach((item, index) => {
    const match = categoryFromHistory(history, item.name, vendor);
    if (match && assignableIds.has(match.categoryId)) {
      categoryByIndex.set(index, match.categoryId);
      categorisationByIndex.set(index, {
        confidence: "medium",
        source: "history",
        kind: categoryKind(match.categoryName),
        reason: null,
        newCategory: false,
      });
    }
  });

  // The categoriser reads the whole receipt at once — whether a line is stock
  // depends on what else was bought with it — and fills what history did not.
  const decisions = categoriseReceiptLines(
    parsedItems.map((item) => ({ name: item.name, quantity: item.quantity })),
    { businessType: profile?.type ?? null, vendor },
  );
  const pending = new Map<number, CategoryDecision>();
  decisions.forEach((decision, index) => {
    if (decision && !categoryByIndex.has(index)) pending.set(index, decision);
  });
  const existingByKey = new Map<TaxonomyKey, number>();
  const missingKeys: TaxonomyKey[] = [];
  for (const decision of pending.values()) {
    if (existingByKey.has(decision.key) || missingKeys.includes(decision.key)) continue;
    const existing = findExistingCategory(assignable, decision.key);
    if (existing) existingByKey.set(decision.key, existing.id);
    else missingKeys.push(decision.key);
  }
  const createdByKey = await ensureTaxonomyCategories(businessProfileId, missingKeys, db);
  for (const [index, decision] of pending) {
    const categoryId = existingByKey.get(decision.key) ?? createdByKey.get(decision.key);
    if (categoryId === undefined) continue;
    categoryByIndex.set(index, categoryId);
    categorisationByIndex.set(index, {
      confidence: decision.confidence,
      source: decision.source,
      kind: decision.kind,
      reason: decision.confidence === "low" ? decision.reason : null,
      newCategory: createdByKey.has(decision.key),
    });
  }

  // Only pay for the Uncategorized category if something actually needs it.
  const needsFallback = parsedItems.some((_, index) => !categoryByIndex.has(index));
  const uncategorisedId = needsFallback ? await ensureUncategorised(businessProfileId, db) : null;

  await db.receiptScanItem.createMany({
    data: parsedItems.map((item, i) => {
      const evidence = itemEvidence[i] ?? null;
      const categorisation: ItemCategorisation = categorisationByIndex.get(i) ?? {
        confidence: "low",
        source: "none",
        kind: null,
        reason: "FinSight couldn't tell what this is. Choose a category.",
        newCategory: false,
      };
      // Provenance only when something can actually be pointed at. An entry
      // that would say {null, null} carries no evidence, so none is claimed —
      // the extraction SOURCE is already on extractedByVision.
      const located = evidence && (evidence.pageNumber !== null || evidence.sourceText !== null);
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
        // How the category was chosen rides with the line's provenance: both
        // are the pipeline's account of how this row came to be.
        evidence: {
          ...(located
            ? {
                pageNumber: evidence.pageNumber,
                sourceText: evidence.sourceText,
                source: extractedByVision ? "vision" : "ocr",
                ...(evidence.possibleRepeatOf ? { possibleRepeatOf: evidence.possibleRepeatOf } : {}),
              }
            : {}),
          categorisation,
        } as unknown as Prisma.InputJsonValue,
      };
    }),
  });

  return db.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
}
