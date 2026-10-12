/**
 * Detector reasons, in the owner's language.
 *
 * The amount-outlier detector writes its reasons for auditability —
 * "Detected by iqr", "The category baseline average is 347.33" — and those
 * strings are stored as written. Shown verbatim they told an owner nothing
 * ("iqr"?), and Ask FinSight repeated them back word for word.
 *
 * Translated on the way OUT, never rewritten in the database: stored rows keep
 * the detector's exact wording for the audit trail, and every finding already
 * stored reads well without a backfill. Reasons this does not recognise pass
 * through unchanged — every other detector already writes plain sentences.
 */

const DETECTION_METHOD_TEXT: Record<string, string> = {
  iqr: "Well outside the usual range of amounts for this category",
  "z-score": "Much higher than the average for this category",
  both: "Two separate checks agreed this amount is unusual for this category",
};

function pesoText(value: number): string {
  return `PHP ${value.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function plainFindingReason(reason: string): string {
  const method = reason.match(/^Detected by (iqr|z-score|both)$/i);
  if (method) return DETECTION_METHOD_TEXT[method[1]!.toLowerCase()]!;

  const baseline = reason.match(/^The category baseline average is (-?\d+(?:\.\d+)?)$/);
  if (baseline) return `Your usual amount in this category is ${pesoText(Number(baseline[1]))}`;

  return reason;
}

/** Stored reasons are untyped JSON; anything that is not a string is dropped. */
export function plainFindingReasons(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((reason): reason is string => typeof reason === "string").map(plainFindingReason);
}
