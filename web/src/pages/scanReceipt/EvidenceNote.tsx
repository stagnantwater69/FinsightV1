import type { FieldEvidence } from "../../lib/receiptWarnings";

/**
 * Where a value came from, quoted.
 *
 * "Read from page 2: 'TOTAL 1,220.00'" is the difference between asking the
 * owner to trust a number and showing them the line it came off. It is also
 * the honest way to mark a model's contribution: a value an AI interpreted
 * says so, in the same place, in the same shape.
 *
 * Renders nothing rather than something vague when the origin could not be
 * located — an invented provenance would be worse than none.
 */
export function EvidenceNote({ evidence }: { evidence?: FieldEvidence | null }) {
  if (!evidence || (!evidence.sourceText && evidence.pageNumber === null)) return null;
  const where =
    evidence.pageNumber === null ? "Read from the receipt" : `Read from page ${evidence.pageNumber}`;
  const how = evidence.source === "vision" ? " by AI, from the photo" : "";
  return (
    <span className="block text-ink-400">
      {where}
      {how}
      {evidence.sourceText ? (
        <>
          : <span className="figure text-ink-500">“{evidence.sourceText}”</span>
        </>
      ) : null}
    </span>
  );
}
