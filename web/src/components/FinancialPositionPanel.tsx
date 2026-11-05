import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { getErrorMessage } from "../lib/errors";
import { monthLabel } from "../lib/reportingPeriod";
import type { BusinessProfile, FinancialPosition } from "../lib/types";
import { useServerStateRefresh } from "../lib/useServerStateRefresh";
import { Button } from "./Button";
import { FormError } from "./Field";
import { formatMoney } from "./Money";
import { useToast } from "./Toast";
import { Card } from "./ui";

function dateLabel(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00.000Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function FinancialPositionPanel({ profile }: { profile: BusinessProfile }) {
  const {
    getFinancialPosition,
    setExpenseRecordsCompleteThroughMonth,
  } = useBusinessProfiles();
  const toast = useToast();
  const [position, setPosition] = useState<FinancialPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const localCompletenessWrite = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getFinancialPosition(profile.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPosition(next);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Financial invalidations below cover same-profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, loadVersion]);

  useServerStateRefresh(
    [{
      resource: `/business-profiles/${profile.id}/financial-position`,
      businessProfileId: profile.id,
      tags: ["financial"],
    }],
    (_signal, target) => {
      const profileOnlyInvalidation =
        target.tags?.length === 1 && target.tags[0] === "financial";
      if (localCompletenessWrite.current && profileOnlyInvalidation) return;
      setLoadVersion((version) => version + 1);
    },
  );

  async function saveCompleteThrough(month: string | null) {
    setSaving(true);
    setError(null);
    localCompletenessWrite.current = true;
    try {
      const next = await setExpenseRecordsCompleteThroughMonth(
        profile.id,
        month,
      );
      setPosition(next);
      toast(month ? `${monthLabel(month)} marked complete` : "Complete mark removed");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
      queueMicrotask(() => {
        localCompletenessWrite.current = false;
      });
    }
  }

  if (loading && !position) {
    return (
      <Card className="p-5 shadow-none sm:p-7">
        <div className="skeleton h-5 w-44 rounded" aria-hidden />
        <div className="skeleton mt-5 h-16 rounded-xl" aria-hidden />
        <div className="skeleton mt-3 h-24 rounded-xl" aria-hidden />
        <span className="sr-only" role="status" aria-busy="true">
          Loading recorded financial position…
        </span>
      </Card>
    );
  }

  if (!position) {
    return (
      <Card className="p-5 shadow-none sm:p-7">
        <PanelHeading />
        <div className="mt-5">
          <FormError>{error ?? "Recorded financial position could not be loaded."}</FormError>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setLoadVersion((version) => version + 1)}
          >
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  const funds = position.availableFunds;
  const basis = position.monthlyExpenseBasis;
  const last = position.previousMonth;
  const lastLabel = monthLabel(last.month);
  const savedMonth = basis.recordsCompleteThroughMonth;
  // Only the month right before this one feeds Monthly costs, so an older mark no longer counts.
  const lastMarked = savedMonth !== null && savedMonth >= last.month;
  const usingRecords = basis.source === "previous_complete_month";

  return (
    <Card className="p-5 shadow-none sm:p-7">
      <PanelHeading />

      <div className="mt-6 grid gap-6 lg:grid-cols-2 lg:gap-8">
        <section className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-700">
            Recorded available funds
          </h3>
          <p className="figure mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink-900 [overflow-wrap:anywhere] sm:text-3xl">
            {formatMoney(funds.calculatedAmount)}
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <CalculationRow label="Opening balance" amount={funds.baselineAmount} />
            <CalculationRow label="Plus reviewed sales" amount={funds.confirmedSalesAdded} />
            <CalculationRow label="Less reviewed expenses" amount={funds.confirmedExpensesDeducted} />
          </dl>
          <p className="mt-4 max-w-[70ch] text-xs leading-relaxed text-ink-500">
            Records dated {dateLabel(funds.baselineDate)} to {dateLabel(funds.asOfDate)}.
            Records waiting for review are not counted.
          </p>
        </section>

        <section className="min-w-0 border-t border-paper-200 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <h3 className="text-sm font-semibold text-ink-700">
            Monthly costs
          </h3>
          <p className="figure mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink-900 [overflow-wrap:anywhere] sm:text-3xl">
            {formatMoney(basis.amount)}
          </p>
          <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-ink-600">
            {usingRecords && basis.sourceMonth
              ? `Actual costs for ${monthLabel(basis.sourceMonth)}, from ${basis.eligibleRecordCount} reviewed ${basis.eligibleRecordCount === 1 ? "expense" : "expenses"}.`
              : "Your starting estimate."}
          </p>
          <p className="mt-2 max-w-[60ch] text-xs leading-relaxed text-ink-500">
            Used for your Recovery Target.
          </p>
        </section>
      </div>

      <section
        aria-labelledby={`last-month-${profile.id}`}
        className="mt-7 border-t border-paper-200 pt-6"
      >
        <h3 id={`last-month-${profile.id}`} className="font-display text-base font-semibold text-ink-900">
          {lastMarked ? `${lastLabel} is marked complete` : `Is ${lastLabel} complete?`}
        </h3>

        {lastMarked ? (
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-ink-600">
            Monthly costs use its actual total. Next month, mark this month complete the same way.
          </p>
        ) : (
          <>
            <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-ink-600">
              Mark it complete once every {lastLabel} expense is entered and
              reviewed. Monthly costs then use its actual total instead of your estimate.
            </p>
            <dl className="mt-4 max-w-md space-y-2 text-sm">
              <CalculationRow label={`Reviewed expenses in ${lastLabel}`} amount={last.recordedAmount} />
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-baseline gap-4">
                <dt className="text-ink-500">Monthly costs would change</dt>
                <dd className="figure text-right font-medium text-ink-700">
                  {formatMoney(basis.amount)} → {formatMoney(last.recordedAmount)}
                </dd>
              </div>
            </dl>
            {last.awaitingReviewCount > 0 ? (
              <p className="mt-3 text-sm text-tone-accent">
                {last.awaitingReviewCount} {lastLabel}{" "}
                {last.awaitingReviewCount === 1 ? "expense still needs" : "expenses still need"} review.{" "}
                <Link to="/records/flagged" className="tap-inline font-semibold link-action">
                  Review now
                </Link>
              </p>
            ) : last.recordCount === 0 ? (
              <p className="mt-3 text-sm text-ink-500">No {lastLabel} expenses are recorded yet.</p>
            ) : null}
            {savedMonth ? (
              <p className="mt-2 text-xs text-ink-500">
                Last marked complete: {monthLabel(savedMonth)}.
              </p>
            ) : null}
          </>
        )}

        {error ? <div className="mt-3"><FormError>{error}</FormError></div> : null}

        <div className="mt-4">
          {lastMarked ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => void saveCompleteThrough(null)}
            >
              {saving ? "Saving…" : "Undo"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="brand"
              size="sm"
              disabled={saving || last.awaitingReviewCount > 0}
              onClick={() => void saveCompleteThrough(last.month)}
            >
              {saving ? "Saving…" : `Mark ${lastLabel} complete`}
            </Button>
          )}
        </div>
      </section>
    </Card>
  );
}

function PanelHeading() {
  return (
    <div className="min-w-0">
      <h2 className="font-display text-lg font-semibold text-ink-900">
        Recorded financial position
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-ink-500">
        Your starting figures plus reviewed records.
      </p>
    </div>
  );
}

function CalculationRow({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-baseline gap-4">
      <dt className="text-ink-500">{label}</dt>
      <dd className="figure text-right font-medium text-ink-700 [overflow-wrap:anywhere]">
        {formatMoney(amount)}
      </dd>
    </div>
  );
}
