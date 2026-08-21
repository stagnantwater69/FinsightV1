import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import type { Prisma, ReceiptScanItem } from "@prisma/client";
import { categoriseReceiptItems, UNCATEGORISED } from "../ai.service";

/**
 * The standing home for an item nothing else fits.
 *
 * Created per business profile on first need rather than at signup, so a
 * business that never scans a receipt never acquires a category it doesn't
 * use. Matched case-insensitively first, so an owner who already has their
 * own "Uncategorized" keeps it instead of getting a near-duplicate.
 */
export async function ensureUncategorised(businessProfileId: number): Promise<number> {
  const existing = await prisma.expenseCategory.findFirst({
    where: { businessProfileId, name: { equals: UNCATEGORISED, mode: "insensitive" } },
  });
  if (existing) return existing.id;
  const created = await prisma.expenseCategory.create({
    data: {
      businessProfileId,
      name: UNCATEGORISED,
      description: "Items FinSight could not confidently categorise. Reassign them as you review.",
    },
  });
  return created.id;
}

/**
 * How many past items are read to build the classifier's few-shot examples.
 *
 * Deliberately larger than the number of examples the prompt ends up carrying
 * (ai.service caps that): these are deduplicated by item name there, and a
 * business that buys the same few things every week would otherwise yield
 * only a handful of distinct examples from a tighter query.
 */
const PRIOR_CHOICE_LOOKBACK = 100;

/**
 * What this business has decided about items before, most recent first.
 *
 * ONLY from CONFIRMED scans, and that restriction is the whole point. A
 * pending scan's categories are the AI's own unreviewed guesses; feeding
 * those back would teach it its own mistakes and the loop would amplify an
 * error rather than correct it. A confirmed scan is the opposite — the owner
 * saw every row and either accepted it or changed it, so each one is a real
 * human decision.
 *
 * Items sitting in Uncategorized are left out too: "this belongs in
 * Uncategorized" is not a decision, it is the absence of one, and the model
 * already has UNCATEGORISED for declining.
 */
async function recentCategoryChoices(businessProfileId: number) {
  const rows = await prisma.receiptScanItem.findMany({
    where: {
      receiptScan: { businessProfileId, confirmationStatus: "Confirmed" },
      categoryId: { not: null },
    },
    select: { name: true, category: { select: { name: true } } },
    orderBy: { id: "desc" },
    take: PRIOR_CHOICE_LOOKBACK,
  });

  return rows
    .filter((r) => r.category !== null && r.category.name.toLowerCase() !== UNCATEGORISED.toLowerCase())
    .map((r) => ({ item: r.name, category: r.category!.name }));
}

/**
 * Categorises the extracted lines and stores them against the scan.
 *
 * Categorisation is automatic and happens here, at scan time, rather than
 * behind a button the owner has to find — reading a receipt and knowing that
 * "buns" are ingredients is the thing the feature is for, and making it
 * opt-in meant it mostly didn't happen.
 *
 * Nothing here can fail the scan. If the model is unreachable the items are
 * still stored, just all uncategorised, and the owner assigns them on the
 * review screen. An upload must never be lost because a third-party API was
 * down.
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
): Promise<ReceiptScanItem[]> {
  // A recovered attempt replaces any partial result left by the prior worker.
  await prisma.receiptScanItem.deleteMany({ where: { receiptScanId } });
  if (parsedItems.length === 0) return [];

  const categories = await prisma.expenseCategory.findMany({
    where: { businessProfileId },
    select: { id: true, name: true },
  });

  // The standing Uncategorized category is never offered to the model as a
  // classification target — "put it in Uncategorized" is our decision when
  // the model declines, not one of its options.
  const assignable = categories.filter((c) => c.name.toLowerCase() !== UNCATEGORISED.toLowerCase());

  let suggestions: Awaited<ReturnType<typeof categoriseReceiptItems>> = [];
  try {
    // The history read sits inside the try with the model call on purpose: it
    // is part of the categorisation attempt, and this function's promise is
    // that nothing in it can cost the owner their scan.
    suggestions = await categoriseReceiptItems(
      parsedItems.map((i) => i.name),
      assignable.map((c) => c.name),
      { vendorName: vendor, priorChoices: await recentCategoryChoices(businessProfileId) },
    );
  } catch (err) {
    logger.error({ err }, "Item categorisation failed; storing items uncategorised");
  }

  const idByName = new Map(assignable.map((c) => [c.name.toLowerCase(), c.id]));
  const matchByIndex = new Map(suggestions.map((s) => [s.index, s.match]));
  // Kept separate from the match: a proposal is only ever a question for the
  // owner, never an assignment. validateItemCategories guarantees the two are
  // mutually exclusive — a suggestion only survives when nothing matched.
  const suggestNewByIndex = new Map(suggestions.map((s) => [s.index, s.suggestNew]));

  // Only pay for the Uncategorized category if something actually needs it.
  const needsFallback = parsedItems.some((_, i) => !matchByIndex.get(i));
  const uncategorisedId = needsFallback ? await ensureUncategorised(businessProfileId) : null;

  await prisma.receiptScanItem.createMany({
    data: parsedItems.map((item, i) => {
      const match = matchByIndex.get(i);
      const evidence = itemEvidence[i] ?? null;
      return {
        receiptScanId,
        lineNumber: i + 1,
        name: item.name.slice(0, 255),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        categoryId: (match ? idByName.get(match.toLowerCase()) : null) ?? uncategorisedId,
        suggestedCategoryName: suggestNewByIndex.get(i) ?? null,
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

  return prisma.receiptScanItem.findMany({ where: { receiptScanId }, orderBy: { lineNumber: "asc" } });
}
