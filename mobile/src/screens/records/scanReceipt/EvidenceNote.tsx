import { T } from "../../../components/ui";
import { evidenceSummary, type FieldEvidence } from "../../../lib/receiptWarnings";
import { space } from "../../../theme/tokens";

/**
 * Where one extracted value came from, in the owner's own terms.
 *
 * "From page 2: TOTAL 1,250.00" is the difference between a figure taken on
 * faith and one that can be found on the paper. Rendered only where the server
 * actually located something — an absent origin says nothing rather than
 * "unknown".
 */
export function EvidenceNote({ evidence }: { evidence: FieldEvidence | null | undefined }) {
  const summary = evidenceSummary(evidence);
  if (!summary) return null;
  return (
    <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
      {summary}
    </T>
  );
}
