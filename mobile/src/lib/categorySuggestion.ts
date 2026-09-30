/**
 * When a proposed new category is still worth offering.
 *
 * A scan can carry a category name the business does not have — the item
 * lands in Uncategorized and the suggestion rides along for the owner to
 * accept or ignore. (The server's current categoriser creates the standard
 * categories it needs itself and says so; see categoriesCreatedByScan. This
 * offer remains for scans that carry a proposal.)
 *
 * Extracted from the screen because the rule has three separate conditions
 * and a case-insensitive match, which is the kind of thing that quietly stops
 * working. Web applies the same rule inline in ScanReceipt.tsx.
 */

export interface SuggestionCandidate {
  suggestedCategoryName?: string | null;
}

export function suggestedNewCategory(
  item: SuggestionCandidate,
  /** The category the row is in right now, or null. */
  currentCategoryId: number | null,
  /** The standing "nothing fitted" category, if this business has one. */
  uncategorisedId: number | null,
  /** Every category the business already has. */
  existingCategoryNames: string[],
): string | null {
  const name = item.suggestedCategoryName?.trim();
  if (!name) return null;

  // Withheld once the owner has placed the row themselves. The suggestion
  // answers "nothing here fits this", which stops being true the moment they
  // say what does. Sitting in Uncategorized is not being placed — that is the
  // absence of a decision.
  if (currentCategoryId !== null && currentCategoryId !== uncategorisedId) return null;

  // Withheld once the category exists, which happens as soon as it is
  // accepted for a sibling row. Offering again would be offering a duplicate.
  if (existingCategoryNames.some((c) => c.toLowerCase() === name.toLowerCase())) return null;

  return name;
}

/**
 * The rows a newly accepted category should be applied to.
 *
 * Every UNPLACED row it was proposed for, not only the one that was tapped. A
 * grocery run proposes "Packaging" on all four packaging lines, and making the
 * owner create it once and then assign it three more times by hand would be
 * busywork on a decision they have already made. Rows they placed themselves
 * are left alone.
 */
export function rowsToApplySuggestionTo<T extends { id: number; suggestedCategoryName?: string | null }>(
  items: T[],
  name: string,
  assignments: Record<number, number | null>,
  uncategorisedId: number | null,
): number[] {
  return items
    .filter((item) => {
      const current = assignments[item.id] ?? null;
      const unplaced = current === null || current === uncategorisedId;
      return unplaced && item.suggestedCategoryName?.toLowerCase() === name.toLowerCase();
    })
    .map((item) => item.id);
}

interface CategorisedRow {
  categoryId: number | null;
  categorisation?: { confidence: "medium" | "low"; reason: string | null; newCategory: boolean } | null;
}

/**
 * Why FinSight is unsure of a row's category, to show under it — until the
 * owner answers by choosing a category themselves, at which point the doubt
 * is theirs to have settled and the note goes.
 */
export function categoryReviewNote(item: CategorisedRow, currentCategoryId: number | null): string | null {
  const categorisation = item.categorisation;
  if (categorisation?.confidence !== "low" || !categorisation.reason) return null;
  return currentCategoryId === item.categoryId ? categorisation.reason : null;
}

/** The categories this scan created, by name, once each, in the order the rows use them. */
export function categoriesCreatedByScan(items: CategorisedRow[], categories: { id: number; name: string }[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (!item.categorisation?.newCategory) continue;
    const name = categories.find((category) => category.id === item.categoryId)?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
