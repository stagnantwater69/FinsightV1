import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { IconTile } from "../../components/IconTile";
import { Button } from "../../components/Button";
import { Pill, type PillTone } from "../../components/ui";
import { formatMoney } from "../../components/Money";
import type {
  AnomalyFinding,
  AnomalyFindingFeedback,
  AnomalyFindingStatus,
  RecurringPattern,
} from "../../lib/types";

/*
 * The rows behind three Expense insight panels — findings, watched payments'
 * candidates, and their "See all" pages. One definition each, so a preview
 * and its full page cannot drift apart.
 */

const FINDING_SEVERITY_LOOK: Record<string, { pill: PillTone }> = {
  HIGH: { pill: "danger" },
  MEDIUM: { pill: "warn" },
  LOW: { pill: "neutral" },
};

export function FindingCard({
  finding,
  onReview,
}: {
  finding: AnomalyFinding;
  onReview: (
    id: number,
    status: AnomalyFindingStatus,
    feedback: AnomalyFindingFeedback,
  ) => void;
}) {
  return (
    <li className="rounded-xl border border-paper-200 bg-paper-50 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile icon={AlertTriangle} />
          <p className="text-sm font-semibold text-ink-900">{finding.title}</p>
        </div>
        <Pill tone={(FINDING_SEVERITY_LOOK[finding.severity] ?? FINDING_SEVERITY_LOOK.LOW!).pill}>
          {finding.severity.toLowerCase()}
        </Pill>
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-[3.75rem] text-xs text-ink-500">
        {finding.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {/*
        Only two of the five feedback values are offered here, on purpose: the
        full set of answers (including "wrong match", the one the duplicate
        detector most needs) lives on the review queue, which "More options"
        leads to.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
        <Button
          type="button"
          size="sm"
          onClick={() =>
            onReview(
              finding.id,
              "CONFIRMED",
              finding.type === "POSSIBLE_DUPLICATE" ? "DUPLICATE" : "CONFIRMED_UNUSUAL",
            )
          }
        >
          Confirm
          <span className="sr-only"> — {finding.title}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onReview(finding.id, "DISMISSED", "EXPECTED_TRANSACTION")}
        >
          Expected / dismiss
          <span className="sr-only"> — {finding.title}</span>
        </Button>
        <Link to="/records/flagged" className="tap-inline text-xs link-action">
          More options
          <span className="sr-only"> for {finding.title}, on the review queue</span>
        </Link>
      </div>
    </li>
  );
}

export function CandidateRow({
  pattern,
  canWatch,
  onWatch,
  onDismiss,
}: {
  pattern: RecurringPattern;
  /**
   * False when schedules are unavailable. "Watch this" is HIDDEN, not
   * disabled: its endpoint sits behind the same server gate as the schedules
   * read, so it would 404, and a disabled control still advertises a
   * capability. "Not recurring" uses an ungated endpoint and always stays.
   */
  canWatch: boolean;
  onWatch: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  return (
    <li className="rounded-xl border border-paper-200 bg-paper-100/60 px-3.5 py-3">
      <p className="text-sm font-semibold text-ink-900">{pattern.description}</p>
      <p className="mt-1 text-xs text-ink-600">
        {pattern.category.name} · about every {pattern.intervalDays} days ·{" "}
        <span className="figure">{formatMoney(pattern.expectedAmount)}</span>
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {canWatch ? (
          <Button type="button" size="sm" onClick={() => onWatch(pattern.id)}>
            Watch this
            <span className="sr-only"> — {pattern.description}</span>
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onDismiss(pattern.id)}
        >
          Not recurring
          <span className="sr-only"> — {pattern.description}</span>
        </Button>
      </div>
    </li>
  );
}
