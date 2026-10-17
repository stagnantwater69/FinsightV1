import { categoriesCreatedByScan } from "../../../lib/categorySuggestion";
import { warningHeadline, warningPageSuffix, warningTone } from "../../../lib/receiptWarnings";
import type { ExpenseCategory } from "../../../lib/types";
import type { ReceiptScanResult, ReviewNotice } from "./types";

/**
 * Everything worth checking about this reading, in the order it matters.
 *
 * TWO SOURCES, AND ONLY ONE OF THEM AT A TIME.
 *
 * The server now emits machine-readable warning CODES, each carrying its
 * own actionable sentence (`guidance`). When a scan has them, they ARE this
 * list and their wording is the server's — which is the whole point of the
 * contract: the app and the website used to write their own prose for the
 * same signals, and the two had already drifted apart. A client that
 * rewrites a sentence here re-creates that bug.
 *
 * The hand-derived notices below it are the fallback for scans read before
 * warnings were recorded. They are NOT merged with the codes: a blurry page
 * reported once by the server and once by this screen reads as two separate
 * problems with the same photograph.
 *
 * The ORDER, in both cases, is the argument: the photograph comes first
 * because it has the cheapest answer on the screen and the camera is one tap
 * away, then the things that make figures wrong, then the things that only
 * make them uncertain.
 */
export function reviewNoticesFor(scan: ReceiptScanResult, categories: ExpenseCategory[]): ReviewNotice[] {
  const warnings = scan.warnings ?? [];
  const notices: ReviewNotice[] = [];

  /*
   * FinSight created categories in the owner's books for this receipt. Said
   * once, by name, so nothing new appears in their category list unexplained.
   */
  const created = categoriesCreatedByScan(scan.items, categories);
  if (created.length > 0) {
    notices.push({
      tone: "info",
      text: `New ${created.length === 1 ? "category" : "categories"} added for this receipt: ${created.join(", ")}.`,
    });
  }

  if (scan.receiptLikelihood?.outcome === "obvious-non-receipt") {
    notices.push({
      tone: "warn",
      text: "This may not be a receipt. Check every field before saving.",
    });
  } else if (scan.receiptLikelihood?.outcome === "uncertain") {
    notices.push({
      tone: "info",
      text: "This receipt was hard to identify. Check every field.",
    });
  }

  if (warnings.length > 0) {
    notices.push(...warnings.map((w) => ({
      tone: warningTone(w.code),
      text: [
        w.guidance ?? `${warningHeadline(w.code)}.`,
        warningPageSuffix(w),
      ]
        .filter(Boolean)
        .join(" "),
      detail: w.detail,
    })));
    return notices;
  }

  if (scan.captureQuality?.tooBlurredToTrust) {
    notices.push({
      tone: "warn",
      text: "Blurry receipt. Retake the photo or check the figures carefully.",
    });
  }

  // Page 1's own reading is already covered by captureQuality above.
  const blurryPages = (scan.pageQualities ?? [])
    .map((q, i) => (q?.tooBlurredToTrust ? i + 1 : null))
    .filter((n): n is number => n !== null && n !== 1);
  if ((scan.pageQualities?.length ?? 0) > 1 && blurryPages.length > 0) {
    notices.push({
      tone: "warn",
      text:
        `Page${blurryPages.length === 1 ? "" : "s"} ${blurryPages.join(", ")} came out blurry. Check the ` +
        `figures from ${blurryPages.length === 1 ? "that page" : "those pages"} carefully below.`,
    });
  }

  const duplicates = scan.duplicatePages ?? [];
  if (duplicates.length > 0) {
    notices.push({
      tone: "warn",
      text:
        `Pages ${duplicates.map((p) => `${p - 1} and ${p}`).join(", ")} look the same. Check for double-counted items.`,
    });
  }

  /*
   * Suppressed when duplicatePages already fired: a page flagged as a
   * repeat of its neighbour will also, necessarily, overlap it, and two
   * remarks about one pair of photographs read as two separate problems.
   */
  const overlaps = scan.overlappingPages ?? [];
  if (overlaps.length > 0 && duplicates.length === 0) {
    notices.push({
      tone: "info",
      text:
        `Sections ${overlaps.map((p) => `${p - 1} and ${p}`).join(", ")} overlap. Remove any repeated items.`,
    });
  }

  if (scan.looksLikeMultipleReceipts) {
    notices.push({
      tone: "warn",
      text: "There may be two receipts here. Scan each separately if so.",
    });
  }

  /*
   * Three-way split, same as the web confirm screen. The amounts on a
   * merely vision-ASSISTED read were still read off the paper and add up to
   * the printed total; only the wording came from a model. Showing the
   * stronger warning there would be false, and false in the direction that
   * teaches owners to skip warnings.
   */
  if (scan.items.some((i) => i.extractedByVision)) {
    notices.push({
      tone: "warn",
      text: "AI interpreted these values. Check every field and the total against the receipt.",
    });
  } else if (scan.visionAssisted) {
    notices.push({
      tone: "warn",
      text: "AI helped read item names. Check them against the receipt.",
    });
  }

  return notices;
}
