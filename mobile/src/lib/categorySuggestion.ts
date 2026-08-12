/**
 * When a proposed new category is still worth offering.
 *
 * The classifier can suggest a category the business does not have — the item
 * lands in Uncategorized and the suggestion rides along for the owner to
 * accept or ignore. Nothing is ever created automatically: a category
 * appearing in someone's books that they never asked for is exactly what the
 * classifier's grounding rules exist to prevent.
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
