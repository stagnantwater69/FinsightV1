/**
 * The arithmetic behind the itemised receipt review screen.
 *
 * WHY THIS IS ITS OWN MODULE. These few functions decide how an owner's money
 * is split across categories, what subtotal each one shows, and whether
 * Confirm is allowed at all — and they used to live inline in a 1,500-line
 * component, where nothing could reach them to check. That is the same reason
 * lib/receiptConfirm exists: the payload builder was extracted after a request
 * silently broke against the server's schema, because logic that decides what
 * gets saved has to be testable on its own.
 *
 * EVERYTHING IS IN CENTAVOS, and that is not a stylistic preference. Peso
 * amounts do not survive repeated addition as binary floats: 10.10 + 20.20 +
 * 30.30 gives 60.599999999999994, not 60.60. Summing integers and dividing
 * once at the end is what keeps a category subtotal equal to the sum of the
 * lines an owner can see in it.
 */

/** A line as this screen holds it: a scanned item or one the owner typed. */
export interface ReviewLine {
  key: string;
  centavos: number;
  /** `""` is the not-yet-chosen state, which is distinct from any real id. */
  categoryId: number | "";
}

export interface CategoryGroup {
  categoryId: number | "";
  /** In pesos — divided once, at the end, from an integer sum. */
  subtotal: number;
  count: number;
}

/** A scanned line, as the confirm screen holds it. */
export interface ScannedLine {
  id: number;
  amount: number;
}

/** A line the owner is adding because OCR missed it. */
export interface AddedLine {
  key: string;
  name: string;
  amount: number | "";
  categoryId: number | "";
}

/**
 * Scanned lines and owner-added lines as one list.
 *
 * An added line is included as soon as it has an amount — before it is
 * otherwise complete — so that typing a missed item closes the gap on screen
 * immediately rather than only after it has a name and a category. Whether it
 * is complete enough to SAVE is a separate question, answered by
 * `everyLineIsReady`.
 */
export function toReviewLines(
  items: ScannedLine[],
  itemCategories: Record<number, number | "">,
  addedItems: AddedLine[],
): ReviewLine[] {
  return [
    ...items.map((item) => ({
      key: `scanned-${item.id}`,
      centavos: Math.round(item.amount * 100),
      categoryId: itemCategories[item.id] ?? ("" as number | ""),
    })),
    ...addedItems
      .filter((a) => a.amount !== "")
      .map((a) => ({
        key: a.key,
        centavos: Math.round(Number(a.amount) * 100),
        categoryId: a.categoryId,
      })),
  ];
}

/**
 * One entry per category, each carrying what will be saved as a single expense
 * record. Uncategorised lines group under `""` together, so the screen can show
 * them as one outstanding thing to resolve rather than scattering them.
 */
export function groupByCategory(lines: ReviewLine[]): CategoryGroup[] {
  const groups = new Map<number | "", { centavos: number; count: number }>();
  for (const line of lines) {
    const group = groups.get(line.categoryId) ?? { centavos: 0, count: 0 };
    group.centavos += line.centavos;
    group.count += 1;
    groups.set(line.categoryId, group);
  }
  return [...groups.entries()].map(([categoryId, g]) => ({
    categoryId,
    subtotal: g.centavos / 100,
    count: g.count,
  }));
}

export function sumCentavos(lines: ReviewLine[]): number {
  return lines.reduce((sum, l) => sum + l.centavos, 0);
}

/**
 * Whether an added line is usable.
 *
 * A half-typed row must not enable Confirm — a line with an amount but no
 * category would otherwise be saved into nothing, and one with no name would
 * be saved as a blank description.
 */
export function isAddedLineComplete(line: AddedLine): boolean {
  return (
    line.name.trim() !== "" && line.amount !== "" && Number(line.amount) > 0 && line.categoryId !== ""
  );
}

/**
 * Whether every line is ready to save: each scanned item has a category, and
 * every added row is complete.
 */
export function everyLineIsReady(
  items: ScannedLine[],
  itemCategories: Record<number, number | "">,
  addedItems: AddedLine[],
): boolean {
  const everyScannedHasCategory = items.every(
    (i) => itemCategories[i.id] !== "" && itemCategories[i.id] !== undefined,
  );
  return everyScannedHasCategory && addedItems.every(isAddedLineComplete);
}
