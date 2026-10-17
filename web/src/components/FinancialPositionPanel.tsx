import { useEffect, useRef, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { getErrorMessage } from "../lib/errors";
import { monthLabel } from "../lib/reportingPeriod";
import type { BusinessProfile, FinancialPosition } from "../lib/types";
import { useServerStateRefresh } from "../lib/useServerStateRefresh";
import { Button } from "./Button";
import { Field, FormError, TextInput } from "./Field";
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

function previousMonthKey(dateKey: string): string {
  const [year, month] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 2, 1)).toISOString().slice(0, 7);
}

export function FinancialPositionPanel({ profile }: { profile: BusinessProfile }) {
  const {
    getFinancialPosition,
    setExpenseRecordsCompleteThroughMonth,
  } = useBusinessProfiles();
  const toast = useToast();
  const [position, setPosition] = useState<FinancialPosition | null>(null);
  const [completeThroughMonth, setCompleteThroughMonth] = useState("");
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
        setCompleteThroughMonth(
          next.monthlyExpenseBasis.recordsCompleteThroughMonth ?? "",
        );
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
      setCompleteThroughMonth(
        next.monthlyExpenseBasis.recordsCompleteThroughMonth ?? "",
      );
      toast(month ? "Expense record coverage updated" : "Expense record coverage cleared");
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
  const maximumMonth = previousMonthKey(position.asOfDate);
  const savedMonth = basis.recordsCompleteThroughMonth ?? "";
  const monthIsValid =
    completeThroughMonth !== "" && completeThroughMonth <= maximumMonth;
  const monthChanged = completeThroughMonth !== savedMonth;
  const monthError =
    completeThroughMonth && completeThroughMonth > maximumMonth
      ? `Choose a completed month, no later than ${monthLabel(maximumMonth)}.`
      : undefined;

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
            <CalculationRow label="Starting funds" amount={funds.baselineAmount} />
            <CalculationRow label="Plus confirmed sales" amount={funds.confirmedSalesAdded} />
            <CalculationRow label="Less confirmed expenses" amount={funds.confirmedExpensesDeducted} />
          </dl>
          <p className="mt-4 max-w-[70ch] text-xs leading-relaxed text-ink-500">
            From records saved after {dateLabel(funds.baselineDate)}. Calculated
            through {dateLabel(funds.asOfDate)}.
          </p>
        </section>

        <section className="min-w-0 border-t border-paper-200 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <h3 className="text-sm font-semibold text-ink-700">
            Monthly expense basis
          </h3>
          <p className="figure mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink-900 [overflow-wrap:anywhere] sm:text-3xl">
            {formatMoney(basis.amount)}
          </p>
          <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-ink-600">
            {basis.source === "previous_complete_month" && basis.sourceMonth
              ? `From ${basis.eligibleRecordCount} confirmed expense ${basis.eligibleRecordCount === 1 ? "record" : "records"} in ${monthLabel(basis.sourceMonth)}.`
              : "Using your starting estimate because the previous month is not confirmed complete."}
          </p>
          <p className="mt-2 max-w-[60ch] text-xs leading-relaxed text-ink-500">
            Used to calculate Recovery Target for this business.
          </p>
        </section>
      </div>

      <section className="mt-7 grid gap-5 border-t border-paper-200 pt-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-8">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold text-ink-900">
            Record coverage
          </h3>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-600">
            Confirm only a month whose expense records are fully entered
            and reviewed. FinSight can then use records instead of your
            starting estimate.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            Coverage confirmation saves separately from your profile changes.
          </p>
        </div>

        <div className="min-w-0">
          <Field
            label="Expense records complete through"
            htmlFor={`expense-records-complete-through-${profile.id}`}
            hint={`Choose ${monthLabel(maximumMonth)} or an earlier month.`}
            error={monthError}
          >
            <TextInput
              type="month"
              max={maximumMonth}
              value={completeThroughMonth}
              onChange={(event) => {
                setCompleteThroughMonth(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (!saving && monthChanged && monthIsValid) {
                  void saveCompleteThrough(completeThroughMonth);
                }
              }}
            />
          </Field>

          {error ? <div className="mt-3"><FormError>{error}</FormError></div> : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              variant="brand"
              size="sm"
              disabled={saving || !monthChanged || !monthIsValid}
              onClick={() => void saveCompleteThrough(completeThroughMonth)}
            >
              {saving ? "Saving…" : "Save complete month"}
            </Button>
            {savedMonth ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => void saveCompleteThrough(null)}
              >
                Clear confirmation
              </Button>
            ) : null}
          </div>
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
        Calculated from your starting values and confirmed records.
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
