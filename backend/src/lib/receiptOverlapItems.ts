/**
 * Line items repeated because two photographs of one long receipt overlap.
 *
 * The camera asks the owner to keep a few lines of the previous section in
 * view, so the bottom of page N and the top of page N+1 show the same printed
 * lines. A reader that transcribes each photograph faithfully lists those
 * lines twice. This module finds those repeats from the item list alone and
 * decides, conservatively, whether they may be dropped.
 *
 * WHAT COUNTS AS A REPEAT. Only a run at a seam: the first items of page N+1,
 * in order, matching items at the end of page N, in order. Each pair must have
 * the same amount to the centavo, the same quantity where both are printed,
 * and a similar name (OCR reads the same line slightly differently in two
 * photographs). Two identical lines anywhere else, including on the same
 * page, are never treated as repeats: a receipt may genuinely list the same
 * product twice at the same price.
 *
 * WHEN A REPEAT MAY BE DROPPED. Order and position are context, not proof.
 * The receipt's printed total is the objective test, the same one the rest of
 * the pipeline uses to choose between readings:
 *   - the list as read already adds up: nothing is dropped;
 *   - only the list without the repeats adds up: they are dropped;
 *   - neither adds up: nothing is dropped, the repeats are flagged for the
 *     owner, who can see every line and decide;
 *   - no usable total: only a run of two or more strongly matching lines is
 *     dropped; a single matching line is flagged, never removed.
 * A dropped repeat is reported, never silently lost.
 *
 * No I/O and no provider knowledge: callers pass items and a reconciliation
 * test, which keeps this usable for both the provider and the local OCR read.
 */

/**
 * Bump when the matching or the decision rules change; persisted for calibration.
 * v2: a printed product code, where both copies carry one, decides the match.
 */
export const OVERLAP_RESOLVER_VERSION = "seam-items-v2";

/** At most this many items at the top of a page are considered overlap. */
const MAX_SEAM_ITEMS = 12;
/** Unmatched items allowed inside the earlier page's tail (a line one read skipped). */
const MAX_TAIL_SKIPS = 2;
const MATCH_SIMILARITY = 0.6;
const STRONG_SIMILARITY = 0.8;

export interface SeamItem {
  name: string;
  quantity: number | null;
  amount: number;
  /** 1-indexed photograph the item was read from; null when the reader did not say. */
  pageNumber: number | null;
  /** The printed product code, when the reader has one. */
  code?: string | null;
}

export interface SeamRepeat {
  /** Index in the input list of the later copy (top of the later page). */
  repeatIndex: number;
  /** Index in the input list of the earlier copy it repeats (bottom of the earlier page). */
  originalIndex: number;
  /** Page the later copy is on. */
  pageNumber: number;
  /** Page the earlier copy is on. */
  originalPageNumber: number;
  /** Name similarity of the pair, 0..1. */
  similarity: number;
  /** Length of the seam run this pair belongs to. */
  runLength: number;
  /** Every pair in the run is a strong name match. */
  strongRun: boolean;
}

export type SeamResolution =
  /** No seam run was found. */
  | "none"
  /** Runs were found but the list as read already adds up, so they are real lines. */
  | "kept-reconciled"
  /** Dropping the repeats made the items add up to the printed total. */
  | "removed-reconciled"
  /** No usable total; dropped on strong multi-line context alone. */
  | "removed-context"
  /** Could not be settled; kept and flagged for the owner. */
  | "flagged";

export interface SeamOutcome<T extends SeamItem> {
  items: T[];
  /** Repeats dropped from `items`, with indexes into the INPUT list. */
  removed: SeamRepeat[];
  /** Repeats kept but flagged, with indexes into the INPUT list. */
  flagged: SeamRepeat[];
  /** For each surviving item, its index in the input list. */
  keptInputIndexes: number[];
  resolution: SeamResolution;
}

function normalizedName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** 0..1 similarity of two printed item names, tolerant of OCR noise and truncation. */
export function itemNameSimilarity(left: string, right: string): number {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  // One reading cut off at the edge of the photograph.
  if (shorter.length >= 4 && longer.startsWith(shorter)) return STRONG_SIMILARITY;
  return 1 - editDistance(a, b) / longer.length;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function pairSimilarity(later: SeamItem, earlier: SeamItem): number {
  if (cents(later.amount) !== cents(earlier.amount)) return 0;
  if (later.quantity !== null && earlier.quantity !== null && later.quantity !== earlier.quantity) return 0;
  /*
   * A product code is the register's own identity for the line, so where both
   * copies carry one it decides alone: equal codes are the same product even
   * when one photograph lost the description, and different codes are
   * different products however alike the names read. Not fuzzy: neighbouring
   * products of one brand differ by a single digit (004461333 and 004461336
   * are two lotions at the same price).
   */
  if (later.code && earlier.code) return later.code === earlier.code ? 1 : 0;
  const similarity = itemNameSimilarity(later.name, earlier.name);
  return similarity >= MATCH_SIMILARITY ? similarity : 0;
}

/**
 * Matches `head` (the top of the later page, in order) into `tail` (the
 * earlier page, in order) so that the last head item lands on one of the last
 * two tail items and at most MAX_TAIL_SKIPS tail items are passed over.
 * Returns the tail index for each head item, or null.
 */
function alignHeadToTail(head: SeamItem[], tail: SeamItem[]): { indexes: number[]; similarities: number[] } | null {
  const search = (headIndex: number, tailLimit: number, skipsLeft: number): { indexes: number[]; similarities: number[] } | null => {
    if (headIndex < 0) return { indexes: [], similarities: [] };
    for (let tailIndex = tailLimit; tailIndex >= 0 && tailLimit - tailIndex <= skipsLeft; tailIndex--) {
      const similarity = pairSimilarity(head[headIndex]!, tail[tailIndex]!);
      if (similarity === 0) continue;
      const rest = search(headIndex - 1, tailIndex - 1, skipsLeft - (tailLimit - tailIndex));
      if (rest) return { indexes: [...rest.indexes, tailIndex], similarities: [...rest.similarities, similarity] };
    }
    return null;
  };
  // The overlap is the bottom of the earlier photograph, so the run must reach
  // its last or second-to-last item.
  for (let lastTail = tail.length - 1; lastTail >= Math.max(0, tail.length - 2); lastTail--) {
    const skipsUsed = tail.length - 1 - lastTail;
    const found = search(head.length - 1, lastTail, MAX_TAIL_SKIPS - skipsUsed);
    if (found) return found;
  }
  return null;
}

/** Every seam run between consecutive pages, longest run per seam. */
export function findSeamRepeats(items: readonly SeamItem[]): SeamRepeat[] {
  const byPage = new Map<number, number[]>();
  items.forEach((item, index) => {
    if (item.pageNumber === null) return;
    const list = byPage.get(item.pageNumber) ?? [];
    list.push(index);
    byPage.set(item.pageNumber, list);
  });
  const pages = [...byPage.keys()].sort((left, right) => left - right);
  const repeats: SeamRepeat[] = [];
  for (let position = 1; position < pages.length; position++) {
    const earlierPage = pages[position - 1]!;
    const laterPage = pages[position]!;
    if (laterPage !== earlierPage + 1) continue;
    const tailIndexes = byPage.get(earlierPage)!;
    const headIndexes = byPage.get(laterPage)!;
    const tail = tailIndexes.map((index) => items[index]!);
    const longest = Math.min(MAX_SEAM_ITEMS, headIndexes.length, tail.length);
    for (let run = longest; run >= 1; run--) {
      const head = headIndexes.slice(0, run).map((index) => items[index]!);
      const aligned = alignHeadToTail(head, tail);
      if (!aligned) continue;
      const strongRun = aligned.similarities.every((similarity) => similarity >= STRONG_SIMILARITY);
      aligned.indexes.forEach((tailPosition, headPosition) => {
        repeats.push({
          repeatIndex: headIndexes[headPosition]!,
          originalIndex: tailIndexes[tailPosition]!,
          pageNumber: laterPage,
          originalPageNumber: earlierPage,
          similarity: aligned.similarities[headPosition]!,
          runLength: run,
          strongRun,
        });
      });
      break;
    }
  }
  return repeats;
}

/**
 * Decides what to do with seam repeats. `reconciles` answers whether a
 * candidate list adds up to the printed total, or null when there is no total
 * to test against.
 */
export function resolveSeamRepeats<T extends SeamItem>(
  items: readonly T[],
  reconciles: (candidate: T[]) => boolean | null,
): SeamOutcome<T> {
  const all = items.map((_, index) => index);
  const unchanged = (resolution: SeamResolution, flagged: SeamRepeat[] = []): SeamOutcome<T> => ({
    items: [...items],
    removed: [],
    flagged,
    keptInputIndexes: all,
    resolution,
  });
  const repeats = findSeamRepeats(items);
  if (repeats.length === 0) return unchanged("none");

  const without = (dropped: SeamRepeat[]) => {
    const drop = new Set(dropped.map((repeat) => repeat.repeatIndex));
    const keptInputIndexes = all.filter((index) => !drop.has(index));
    return { list: keptInputIndexes.map((index) => items[index]!), keptInputIndexes };
  };
  const removedOutcome = (dropped: SeamRepeat[], resolution: SeamResolution, flagged: SeamRepeat[] = []): SeamOutcome<T> => {
    const kept = without(dropped);
    return { items: kept.list, removed: dropped, flagged, keptInputIndexes: kept.keptInputIndexes, resolution };
  };

  const plain = reconciles([...items]);
  if (plain === true) return unchanged("kept-reconciled");

  const strongRuns = repeats.filter((repeat) => repeat.strongRun && repeat.runLength >= 2);
  if (plain === null) {
    // No total to test: multi-line strong runs are the only context strong
    // enough to act on. Everything else stays and is flagged.
    const flagged = repeats.filter((repeat) => !strongRuns.includes(repeat));
    if (strongRuns.length === 0) return unchanged("flagged", flagged);
    return removedOutcome(strongRuns, "removed-context", flagged);
  }

  // Try every repeat, then only the strong multi-line runs; the first set whose
  // removal makes the items add up wins.
  const candidates = [repeats, ...(strongRuns.length > 0 && strongRuns.length < repeats.length ? [strongRuns] : [])];
  for (const dropped of candidates) {
    // Once the list adds up, any repeat left in it is a real line on the paper.
    if (reconciles(without(dropped).list) === true) return removedOutcome(dropped, "removed-reconciled");
  }
  return unchanged("flagged", repeats);
}
