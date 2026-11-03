import { useEffect, useRef, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { getErrorMessage } from "../lib/errors";
import type {
  AnomalyFinding,
  AnomalyFindingFeedback,
  AnomalyFindingPage,
  AnomalyFindingStatus,
} from "../lib/types";
import { Button, ButtonLink } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { SkeletonPanel } from "../components/Skeleton";
import { Callout, Panel } from "../components/ui";
import { ExpenseSubpageHead } from "./expenseInsight/ExpenseSubpageHead";
import { FindingCard } from "./expenseInsight/reviewItems";
import { openFindingsRequest } from "./expenseInsight/reviewRequests";

/**
 * Every open finding, on its own page. Expense insight previews the first
 * three; this reads the same cached request, so arriving from there shows the
 * list at once, and a review here clears the finding from both.
 */
export function ExpenseFindingsPage() {
  const { selected } = useBusinessProfiles();
  const [findings, setFindings] = useState<AnomalyFinding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const requestId = useRef(0);

  async function load(force = false) {
    if (!selected) {
      setFindings(null);
      setError(null);
      setLoading(false);
      return;
    }
    const thisRequestId = ++requestId.current;
    const { url, params, scope } = openFindingsRequest(selected.id);
    const cached = peekCachedApiData<AnomalyFindingPage>(url, { params }, scope);
    if (cached) setFindings(cached.data.items);
    setLoading(!cached);
    setError(null);
    try {
      const { data } = await cachedApiGet<AnomalyFindingPage>(url, { params }, scope, { force });
      if (thisRequestId !== requestId.current) return;
      setFindings(data.items);
    } catch (err) {
      if (thisRequestId !== requestId.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (thisRequestId === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function reviewFinding(
    id: number,
    status: AnomalyFindingStatus,
    feedback: AnomalyFindingFeedback,
  ) {
    if (!selected) return;
    setReviewError(null);
    try {
      await api.patch(
        `/insights/findings/${id}/review`,
        { status, feedback },
        { serverStateScope: { businessProfileId: selected.id } },
      );
      setFindings((current) => current?.filter((finding) => finding.id !== id) ?? null);
    } catch (err) {
      setReviewError(getErrorMessage(err));
    }
  }

  return (
    <div>
      <ExpenseSubpageHead
        title="Findings to review"
        subtitle="Open findings FinSight wants you to confirm or dismiss."
        backTo="/insights/expense-behavior#expense-review"
      />

      {error && !findings ? (
        <Callout tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Findings couldn’t load. {error}</span>
            <Button type="button" size="sm" variant="secondary" onClick={() => void load(true)}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : loading && !findings ? (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading findings…</span>
          <SkeletonPanel lines={6} />
        </div>
      ) : !findings || findings.length === 0 ? (
        <EmptyState
          compact
          title="Nothing to review"
          icon="✓"
          action={
            <ButtonLink to="/insights/expense-behavior" variant="secondary">
              Back to Expense insight
            </ButtonLink>
          }
        >
          There are no open findings right now.
        </EmptyState>
      ) : (
        <Panel title={`${findings.length} open ${findings.length === 1 ? "finding" : "findings"}`}>
          {error ? (
            <p role="status" className="mb-3 text-sm text-tone-accent">
              Showing recently loaded findings; the latest refresh failed.
            </p>
          ) : null}
          {reviewError ? (
            <p role="alert" className="mb-3 text-sm text-tone-danger">
              That review didn’t save. {reviewError}
            </p>
          ) : null}
          <ul className="grid gap-3 lg:grid-cols-2">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                onReview={(id, status, feedback) => void reviewFinding(id, status, feedback)}
              />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
