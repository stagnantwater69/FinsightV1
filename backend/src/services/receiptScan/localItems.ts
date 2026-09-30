import {
  joinPagesWithoutSeams,
  parseLineItems,
  parseLocatedLineItems,
  reconcileItems,
  type ParsedLineItem,
} from "../ocr.service";
import { resolveSeamRepeats } from "../../lib/receiptOverlapItems";
import type { ProviderSeamRepeats } from "../receiptProviderContract";

export interface LocalItemReading {
  /** The items the local read stands behind, in printed order. */
  items: ParsedLineItem[];
  /** How overlap between photographs was settled: "none", "seam-text" or "removed-reconciled". */
  overlapResolution: string;
  /** What the item-level seam match removed, for the owner-facing warning. */
  seamReport?: ProviderSeamRepeats;
  /** The page texts joined with exact tail-to-head repeats cut. */
  seamFreeText: string;
}

/** The 1-indexed page each line of `pageTexts.join("\n")` was read from. */
export function linePageNumbers(pageTexts: string[]): number[] {
  return pageTexts.flatMap((text, index) => text.split("\n").map(() => index + 1));
}

/**
 * Reads the items of a receipt photographed in one or more sections.
 *
 * One continuous document, not N photographs: every parser reads a receipt as
 * lines of text with no concept of a photograph boundary, so page texts are
 * concatenated in order. That is what lets a total printed on page 3
 * reconcile against items spanning pages 1 and 2, and what lets a two-line
 * item whose figures end one photograph take its description from the top of
 * the next.
 *
 * OVERLAP BETWEEN SECTIONS, and why removing it needs permission. The camera
 * asks for overlap between the sections of a long receipt so the owner can
 * see where to continue photographing, and those lines are read twice. The
 * obvious fix — find the repeat, drop it — is a heuristic deciding which money
 * lines survive, so it is settled by an OBJECTIVE test: the receipt's own
 * printed total. If the plain reading fails to account for it and a
 * de-overlapped reading does, that is arithmetic agreeing with the paper. Where
 * both fail, the plain reading stands and the gap reaches the owner — a
 * duplicate they can see and delete beats a real purchase this deleted.
 *
 * `combinedText` — the full, unedited concatenation — is what the caller
 * stores as rawText regardless, so the audit trail keeps every line.
 */
export function readLocalItems(pageTexts: string[], total: number | null): LocalItemReading {
  const combinedText = pageTexts.join("\n");
  const seamFreeText = joinPagesWithoutSeams(pageTexts);
  const plainItems = parseLineItems(combinedText);
  if (reconcileItems(combinedText, plainItems, total).reconciled) {
    return { items: plainItems, overlapResolution: "none", seamFreeText };
  }

  if (seamFreeText !== combinedText) {
    const seamFreeItems = parseLineItems(seamFreeText);
    if (reconcileItems(seamFreeText, seamFreeItems, total).reconciled) {
      return { items: seamFreeItems, overlapResolution: "seam-text", seamFreeText };
    }
  }

  /*
   * The exact-line seam above misses overlap whenever the two photographs OCR
   * the repeated lines slightly differently, which is the usual case. Matching
   * items at the seam (lib/receiptOverlapItems.ts) tolerates that noise. Same
   * objective test, and stricter: only a removal that makes the items add up
   * to the printed total is used.
   *
   * The items are read from the JOINED text and attributed to the page their
   * amount was printed on. Reading each page on its own lost items twice
   * over: a two-line row split across a page break has no name on either
   * page, and a page without a TOTAL line takes its largest figure as the
   * total, which the structural guard then removes as a payment line.
   */
  if (total !== null && pageTexts.length > 1) {
    const pageOfLine = linePageNumbers(pageTexts);
    const pageItems = parseLocatedLineItems(combinedText).map(({ lineIndex, ...item }) => ({
      ...item,
      pageNumber: pageOfLine[lineIndex] ?? null,
    }));
    const seamOutcome = resolveSeamRepeats(pageItems, (list) =>
      list.length > 0 && reconcileItems(combinedText, list, total).reconciled);
    if (seamOutcome.resolution === "removed-reconciled") {
      // The earlier copy is the one kept. Where the photograph cut its
      // description off and it carries only its product code, the repeat
      // that was dropped still has the printed description: keep that.
      const describedBy = new Map(seamOutcome.removed.map((repeat) => [repeat.originalIndex, pageItems[repeat.repeatIndex]!]));
      return {
        items: seamOutcome.keptInputIndexes.map((index) => {
          const { name, quantity, unitPrice, amount, code } = pageItems[index]!;
          const repeat = describedBy.get(index);
          const described = code !== null && name === code && repeat && repeat.name !== repeat.code ? repeat.name : name;
          return { name: described, quantity, unitPrice, amount };
        }),
        overlapResolution: seamOutcome.resolution,
        seamReport: {
          resolution: seamOutcome.resolution,
          removed: seamOutcome.removed.map((repeat) => ({
            name: pageItems[repeat.repeatIndex]!.name,
            quantity: pageItems[repeat.repeatIndex]!.quantity,
            amount: pageItems[repeat.repeatIndex]!.amount,
            pageNumber: repeat.pageNumber,
            originalPageNumber: repeat.originalPageNumber,
          })),
          flagged: [],
        },
        seamFreeText,
      };
    }
  }

  return { items: plainItems, overlapResolution: "none", seamFreeText };
}
