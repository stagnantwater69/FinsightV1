import { scanConfidenceBand } from "../../lib/confidenceBands";
import { fieldsNeedingAttention, type ReceiptField } from "../../lib/receiptWarnings";
import type { Origin, ScanResult } from "./types";

export function originOf(current: string, extracted: string | null): Origin {
  if (extracted === null || extracted === "") return current === "" ? "missing" : "edited";
  return current === extracted ? "read" : "edited";
}

/**
 * A field whose value FinSight guessed.
 *
 * The wash marks it as provisional and clears the moment the owner edits it,
 * so "FinSight said this" and "I said this" never look the same.
 *
 * `!bg-*` is deliberate: the base control class sets `bg-paper`, and two
 * background utilities in one class attribute resolve by stylesheet order, not
 * by the order they are written here. The important modifier is what makes the
 * override deterministic.
 */
export function provisionalClass(origin: Origin): string {
  if (origin === "read" || origin === "derived") return "!bg-tint-info";
  if (origin === "missing") return "!bg-tint-accent";
  return "";
}

/**
 * The exact fields to look at, so "Check a few fields" can name them.
 *
 * Three sources, in the order they are trusted: a warning that NAMES a field
 * (the server said so, and its guidance says what to do), an extracted value
 * that came back empty (there is nothing to compare against the paper), and —
 * for the single-total flow only — a page reading bad enough that the amount
 * itself is in doubt. Per-item confidence is handled on the item rows, where
 * the owner is already looking at that line.
 *
 * Module-level rather than inline so the focus effect and the render agree by
 * construction: the field that gets focus is the same one the callout names.
 */
export function attentionFieldsFor(scan: ScanResult | null): ReceiptField[] {
  if (!scan) return [];
  const named = new Set<ReceiptField>(fieldsNeedingAttention(scan.warnings ?? []));
  if (!scan.extractedDate) named.add("date");
  if (scan.extractedAmount === null || scan.extractedAmount === undefined) named.add("amount");
  if (scanConfidenceBand(scan) === "review" && (scan.items?.length ?? 0) <= 1) named.add("amount");
  const order: ReceiptField[] = ["date", "description", "vendor", "amount"];
  return order.filter((f) => named.has(f));
}
