import { useEffect, useRef, useState } from "react";
import { CalendarCheck2, WalletCards } from "lucide-react";
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
      <Card className="p-5 sm:p-6">
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
      <Card className="p-5 sm:p-6">
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
    <Card className="p-5 sm:p-6">
      <PanelHeading />

      <div className="mt-5 divide-y divide-paper-200">
        <div className="pb-4">
          <p className="text-xs font-semibold text-ink-500">
            Recorded available funds
          </p>
          <p className="figure mt-1 font-display text-2xl font-bold tracking-[-0.02em] text-ink-900">
            {formatMoney(funds.calculatedAmount)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-600">
            {formatMoney(funds.baselineAmount)} starting funds, plus{" "}
            {formatMoney(funds.confirmedSalesAdded)} confirmed sales, less{" "}
            {formatMoney(funds.confirmedExpensesDeducted)} confirmed expenses.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            From records saved after {dateLabel(funds.baselineDate)}. Calculated
            through {dateLabel(funds.asOfDate)}.
          </p>
        </div>

        <div className="py-4">
          <p className="text-xs font-semibold text-ink-500">
            Monthly expense basis
          </p>
          <p className="figure mt-1 text-lg font-semibold text-ink-900">
            {formatMoney(basis.amount)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {basis.source === "previous_complete_month" && basis.sourceMonth
              ? `From ${basis.eligibleRecordCount} confirmed expense ${basis.eligibleRecordCount === 1 ? "record" : "records"} in ${monthLabel(basis.sourceMonth)}.`
              : "Using your starting estimate because the previous month is not confirmed complete."}
          </p>
        </div>

        <div className="pt-4">
          <div className="mb-3 flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-paper-100 text-tone-brand">
              <CalendarCheck2 size={19} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-900">
                Record coverage
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                Confirm only a month whose expense records are fully entered
                and reviewed.
              </p>
            </div>
          </div>

          <Field
            label="Expense records complete through"
            htmlFor={`expense-records-complete-through-${profile.id}`}
            hint={`Choose ${monthLabel(maximumMonth)} or an earlier month. FinSight can then use records instead of the starting estimate.`}
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

          <div className="mt-3 flex flex-wrap gap-2">
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
      </div>
    </Card>
  );
}

function PanelHeading() {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-tint-brand text-tone-brand ring-1 ring-edge-brand">
        <WalletCards size={21} aria-hidden />
      </span>
      <div className="min-w-0 pt-0.5">
        <h2 className="font-display text-base font-semibold text-ink-900 sm:text-lg">
          Recorded financial position
        </h2>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-500">
          Calculated from your starting values and confirmed records.
        </p>
      </div>
    </div>
  );
}
