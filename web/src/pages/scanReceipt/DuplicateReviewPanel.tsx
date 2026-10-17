import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Field";
import { Money } from "../../components/Money";
import { Callout } from "../../components/ui";
import { IconCheck, IconDuplicate } from "../../components/icons";
import { DUPLICATE_REASON_COPY, type DuplicateCheckStatus, type DuplicateReviewState } from "./duplicateReview";

export function DuplicateReviewPanel({
  duplicateCheckStatus,
  duplicateReview,
  retryDuplicateCheck,
  duplicateListComplete,
  duplicateLoading,
  loadMoreDuplicateCandidates,
  duplicateAcknowledged,
  setReviewDirty,
  setDuplicateAcknowledged,
  setConfirmError,
}: {
  duplicateCheckStatus: DuplicateCheckStatus;
  duplicateReview: DuplicateReviewState | null;
  retryDuplicateCheck: () => void;
  duplicateListComplete: boolean;
  duplicateLoading: boolean;
  loadMoreDuplicateCandidates: () => Promise<void>;
  duplicateAcknowledged: boolean;
  setReviewDirty: (dirty: boolean) => void;
  setDuplicateAcknowledged: (acknowledged: boolean) => void;
  setConfirmError: (message: string | null) => void;
}) {
  return (
    <>
      {duplicateCheckStatus === "loading" && duplicateReview === null ? (
        <p className="text-xs text-ink-500" role="status">Checking for possible duplicate receipts…</p>
      ) : null}

      {duplicateCheckStatus === "error" ? (
        <div role="alert">
          <Callout tone="warn">
            <p>FinSight could not check for duplicate receipts. Try again before saving.</p>
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={retryDuplicateCheck}>
              Retry duplicate check
            </Button>
          </Callout>
        </div>
      ) : null}

      {duplicateReview ? (
        <section
          aria-labelledby="duplicate-review-title"
          className="space-y-3 rounded-xl border border-edge-warning bg-tint-warning p-4"
        >
          <div>
            <h2 id="duplicate-review-title" className="text-sm font-semibold text-ink-900">
              Possible duplicate {duplicateReview.candidateCount === 1 ? "receipt" : "receipts"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-600">
              {duplicateReview.changed
                ? "The matches changed while you were reviewing. Check this current list before choosing again."
                : "FinSight found an earlier record with matching details. Compare it before saving another copy."}
            </p>
          </div>
          <ul className="space-y-2">
            {duplicateReview.candidates.map((candidate) => (
              <li key={candidate.id} className="rounded-lg border border-paper-200 bg-paper px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium text-ink-800">
                    {candidate.vendor?.trim() || "Earlier expense"}
                  </span>
                  <Money value={candidate.total} />
                </div>
                <p className="mt-1 text-xs text-ink-600">
                  <time dateTime={candidate.date}>{candidate.date.slice(0, 10)}</time>
                  {candidate.reasons.length > 0
                    ? ` · ${candidate.reasons.map((reason) => DUPLICATE_REASON_COPY[reason]).join(", ")}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
          {!duplicateListComplete ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-600" role="status">
                Showing {duplicateReview.candidates.length} of {duplicateReview.candidateCount} matches.
                Load the rest before deciding.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={duplicateLoading}
                onClick={() => { void loadMoreDuplicateCandidates(); }}
              >
                {duplicateLoading ? "Loading matches…" : "Load remaining matches"}
              </Button>
            </div>
          ) : (
            <Checkbox
              checked={duplicateAcknowledged}
              onChange={(checked) => {
                setReviewDirty(true);
                setDuplicateAcknowledged(checked);
                if (checked) setConfirmError(null);
              }}
              label="I reviewed these matches and still want to save this receipt."
              hint="This choice applies to this full list. If the list changes, FinSight will ask again."
            />
          )}
        </section>
      ) : null}
    </>
  );
}

export function CompactDuplicateReviewPanel({
  duplicateCheckStatus,
  duplicateReview,
  retryDuplicateCheck,
  duplicateListComplete,
  duplicateLoading,
  loadMoreDuplicateCandidates,
  duplicateAcknowledged,
  setReviewDirty,
  setDuplicateAcknowledged,
  setConfirmError,
}: {
  duplicateCheckStatus: DuplicateCheckStatus;
  duplicateReview: DuplicateReviewState | null;
  retryDuplicateCheck: () => void;
  duplicateListComplete: boolean;
  duplicateLoading: boolean;
  loadMoreDuplicateCandidates: () => Promise<void>;
  duplicateAcknowledged: boolean;
  setReviewDirty: (dirty: boolean) => void;
  setDuplicateAcknowledged: (acknowledged: boolean) => void;
  setConfirmError: (message: string | null) => void;
}) {
  return (
    <>
      {duplicateCheckStatus === "loading" && duplicateReview === null ? (
        <p className="text-sm text-ink-500" role="status">Checking for possible duplicate receipts…</p>
      ) : null}

      {duplicateCheckStatus === "error" ? (
        <div role="alert">
          <Callout tone="warn">
            <p>FinSight could not check for duplicate receipts. Try again before saving.</p>
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={retryDuplicateCheck}>
              Retry duplicate check
            </Button>
          </Callout>
        </div>
      ) : null}

      {duplicateReview ? (
        <section
          aria-labelledby="compact-duplicate-review-title"
          className="space-y-3 rounded-xl bg-tint-accent p-4 ring-1 ring-edge-accent"
        >
          <div className="flex items-start gap-3">
            <IconDuplicate className="mt-0.5 h-5 w-5 shrink-0 text-tone-accent" />
            <div className="min-w-0">
              <h2 id="compact-duplicate-review-title" className="text-sm font-semibold text-ink-900">
                Possible duplicate {duplicateReview.candidateCount === 1 ? "receipt" : "receipts"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">
                Compare every match before saving another copy.
              </p>
            </div>
          </div>
          <details className="rounded-lg bg-paper px-3 py-2 ring-1 ring-paper-200">
            <summary className="disclosure text-sm">
              View {duplicateReview.candidateCount} match{duplicateReview.candidateCount === 1 ? "" : "es"}
            </summary>
            <ul className="mt-2 space-y-2">
              {duplicateReview.candidates.map((candidate) => (
                <li key={candidate.id} className="border-t border-paper-200 pt-2 first:border-0 first:pt-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-ink-800">
                      {candidate.vendor?.trim() || "Earlier expense"}
                    </span>
                    <Money value={candidate.total} />
                  </div>
                  <p className="mt-1 text-xs text-ink-600">
                    <time dateTime={candidate.date}>{candidate.date.slice(0, 10)}</time>
                    {candidate.reasons.length > 0
                      ? ` · ${candidate.reasons.map((reason) => DUPLICATE_REASON_COPY[reason]).join(", ")}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </details>
          {!duplicateListComplete ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-600" role="status">
                Showing {duplicateReview.candidates.length} of {duplicateReview.candidateCount} matches.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={duplicateLoading}
                onClick={() => { void loadMoreDuplicateCandidates(); }}
              >
                {duplicateLoading ? "Loading matches…" : "Load remaining matches"}
              </Button>
            </div>
          ) : (
            <Checkbox
              checked={duplicateAcknowledged}
              onChange={(checked) => {
                setReviewDirty(true);
                setDuplicateAcknowledged(checked);
                if (checked) setConfirmError(null);
              }}
              label="I reviewed these matches and still want to save this receipt."
              hint="If the list changes before saving, FinSight will ask you to review it again."
            />
          )}
        </section>
      ) : duplicateCheckStatus === "success" ? (
        <div className="flex items-center gap-2 text-sm text-ink-600">
          <IconCheck className="h-4 w-4 shrink-0 text-tone-brand" />
          <span>No possible duplicate was found in the current check.</span>
        </div>
      ) : null}
    </>
  );
}
