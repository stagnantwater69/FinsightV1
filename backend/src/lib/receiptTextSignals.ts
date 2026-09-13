const RECEIPT_START_MARKER = /\bdate\s*[:.]/gi;
const DUPLICATE_PAGE_OVERLAP = 0.6;
const MAX_SEAM_LINES = 12;
const MIN_SEAM_LINE_LENGTH = 3;

export interface PageSeam {
  pageNumber: number;
  lineCount: number;
}

export type ReconciliationReason =
  | "not-comparable"
  | "exact"
  | "matches-subtotal"
  | "explained-by-adjustment"
  | "unexplained";

export interface Reconciliation {
  itemsTotal: number | null;
  total: number | null;
  difference: number | null;
  reconciled: boolean;
  reason: ReconciliationReason;
}

export function looksLikeMultipleReceipts(text: string | null | undefined): boolean {
  if (!text) return false;
  return (text.match(RECEIPT_START_MARKER) ?? []).length >= 2;
}

export function looksLikeDuplicatePage(pageA: string, pageB: string): boolean {
  const significantLines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0);

  const a = significantLines(pageA);
  const b = significantLines(pageB);
  if (a.length === 0 || b.length === 0) return false;

  const bLines = new Set(b);
  const shared = a.filter((line) => bLines.has(line)).length;
  return shared / Math.min(a.length, b.length) >= DUPLICATE_PAGE_OVERLAP;
}

function seamKey(line: string): string {
  return line.trim().toLowerCase().replace(/\s+/g, " ");
}

function seamLines(text: string): string[] {
  return text
    .split("\n")
    .map(seamKey)
    .filter((line) => line.length >= MIN_SEAM_LINE_LENGTH);
}

export function seamOverlapLength(pageA: string, pageB: string): number {
  const a = seamLines(pageA);
  const b = seamLines(pageB);
  const limit = Math.min(MAX_SEAM_LINES, a.length, b.length);

  for (let run = limit; run >= 1; run--) {
    let matches = true;
    for (let index = 0; index < run; index++) {
      if (a[a.length - run + index] !== b[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return run;
  }
  return 0;
}

export function findPageSeams(pageTexts: string[]): PageSeam[] {
  const seams: PageSeam[] = [];
  for (let index = 1; index < pageTexts.length; index++) {
    const lineCount = seamOverlapLength(pageTexts[index - 1] ?? "", pageTexts[index] ?? "");
    if (lineCount > 0) seams.push({ pageNumber: index + 1, lineCount });
  }
  return seams;
}

/** Removes only anchored tail-to-head overlap; callers still validate the arithmetic. */
export function joinPagesWithoutSeams(pageTexts: string[]): string {
  if (pageTexts.length <= 1) return pageTexts.join("\n");

  const parts: string[] = [pageTexts[0] ?? ""];
  for (let index = 1; index < pageTexts.length; index++) {
    const page = pageTexts[index] ?? "";
    const overlap = seamOverlapLength(pageTexts[index - 1] ?? "", page);
    if (overlap === 0) {
      parts.push(page);
      continue;
    }

    const rawLines = page.split("\n");
    let significantSeen = 0;
    let cutAt = 0;
    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
      if (seamKey(rawLines[lineIndex] ?? "").length < MIN_SEAM_LINE_LENGTH) continue;
      significantSeen++;
      if (significantSeen === overlap) {
        cutAt = lineIndex + 1;
        break;
      }
    }
    parts.push(rawLines.slice(cutAt).join("\n"));
  }
  return parts.join("\n");
}

const ADJUSTMENT_LINE = new RegExp(
  [
    String.raw`\b[vy]at\b`,
    String.raw`\b(tax|service\s*charge|svc\s*chg|rounding|round\s*off)\b`,
    String.raw`\b(discounts?|disc\.|less|senior|pwd|rebates?)\b`,
  ].join("|"),
  "i",
);
const SUBTOTAL_LINE = /\bsub\s*-?\s*total\b/i;
const RECONCILE_MONEY = /(\d+(?:,\d{3})*\.\d{2})/;

function moneyOnLine(line: string): number | null {
  const match = line.match(RECONCILE_MONEY);
  return match ? Number(match[1]!.replace(/,/g, "")) : null;
}

function centavos(amount: number): number {
  return Math.round(amount * 100);
}

/** Treats tax or discount gaps as reconciled only when the receipt prints them. */
export function reconcileItems(
  text: string,
  items: { amount: number }[],
  total: number | null,
): Reconciliation {
  if (total === null || items.length === 0) {
    return { itemsTotal: null, total, difference: null, reconciled: true, reason: "not-comparable" };
  }

  const itemsTotal = items.reduce((sum, item) => sum + centavos(item.amount), 0);
  const totalCentavos = centavos(total);
  const difference = (totalCentavos - itemsTotal) / 100;
  const base = { itemsTotal: itemsTotal / 100, total, difference };

  if (itemsTotal === totalCentavos) return { ...base, reconciled: true, reason: "exact" };

  const lines = text.split("\n");
  for (const line of lines) {
    if (!SUBTOTAL_LINE.test(line)) continue;
    const subtotal = moneyOnLine(line);
    if (subtotal !== null && centavos(subtotal) === itemsTotal) {
      return { ...base, reconciled: true, reason: "matches-subtotal" };
    }
  }

  const adjustments = lines
    .filter((line) => ADJUSTMENT_LINE.test(line) && !SUBTOTAL_LINE.test(line))
    .map(moneyOnLine)
    .filter((amount): amount is number => amount !== null)
    .map(centavos);
  const gap = Math.abs(totalCentavos - itemsTotal);
  const sum = adjustments.reduce((left, right) => left + right, 0);
  const explained = adjustments.some((amount) => amount === gap) || (adjustments.length > 1 && sum === gap);

  return explained
    ? { ...base, reconciled: true, reason: "explained-by-adjustment" }
    : { ...base, reconciled: false, reason: "unexplained" };
}

/** Lightweight API DTO check that avoids importing the OCR engine. */
export function receiptItemsReconcile(text: string, items: { amount: number }[], total: number | null): boolean {
  return reconcileItems(text, items, total).reconciled;
}
