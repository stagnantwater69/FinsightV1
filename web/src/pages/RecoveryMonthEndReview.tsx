import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { Callout, Card, PageHead, Panel } from "../components/ui";
import { formatMoney } from "../components/Money";
import { SkeletonPanel } from "../components/Skeleton";
import type { RecoveryMonthEndReview as RecoveryMonthEndReviewData } from "../lib/types";

/**
 * Plan §10.9/§11 Phase 7 — a read-only, deterministic recap of one
 * already-ended month. This page NEVER offers a way to apply
 * `suggestedQuestionsForNextMonth` to the business profile's settings — the
 * only call to action here is a plain link to the existing edit form, where
 * the owner makes their own manual change if they choose. See
 * `computeMonthEndReview` in insights.service.ts for the safety rationale;
 * do not add an "apply this suggestion" control to this page.
 */

/** "YYYY-MM" for the calendar month immediately before the current one —
 * the month an owner most likely wants to review right after it closes. */
function lastMonthKey(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function formatDayLabel(dateKey: string): string {
  // UTC-midnight-encoded date-only string, like every other date in this app.
  return new Date(`${dateKey}T00:00:00.000Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "₱X surplus" or "₱X shortfall" — never a negative-looking peso figure. */
function surplusOrShortfallText(amount: number): string {
  const label = amount < 0 ? "shortfall" : "surplus";
  return `${formatMoney(Math.abs(amount))} ${label}`;
}

export function RecoveryMonthEndReviewPage() {
  const { selected } = useBusinessProfiles();
  const [month, setMonth] = useState(lastMonthKey());
  const [data, setData] = useState<RecoveryMonthEndReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  async function load() {
    if (!selected) return;
    const thisRequestId = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<RecoveryMonthEndReviewData>("/insights/recovery/month-end-review", {
        params: { businessProfileId: selected.id, month },
      });
      if (thisRequestId !== requestId.current) return;
      setData(data);
    } catch (err) {
      if (thisRequestId !== requestId.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (thisRequestId === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, month]);

  if (!selected) return null;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Month-end review"
        subtitle={
          <>
            A recap of one already-ended month, for reflecting on what changed — not a place to apply
            anything automatically.
          </>
        }
      />

      <InsightsTabs />

      <Card className="mb-5 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <Field label="Month to review" htmlFor="month-end-review-month">
            <TextInput
              id="month-end-review-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="secondary" size="sm">
            {loading ? "Loading…" : "Review this month"}
          </Button>
        </form>
      </Card>

      {error ? (
        <Callout tone="warn">
          <b className="font-semibold">Couldn't load this month's review.</b> {error}
          <div className="mt-2">
            <Button type="button" variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <SkeletonPanel lines={3} />
          <SkeletonPanel lines={3} />
        </div>
      ) : data?.status === "not_yet_reviewable" ? (
        <Callout tone="info">
          <b className="font-semibold">{formatMonthLabel(data.month)} hasn't ended yet.</b> Once this month
          closes on your business's own local calendar, come back here and its review will be ready.
        </Callout>
      ) : data?.status === "reviewable" ? (
        <div className="space-y-5">
          <Panel title={formatMonthLabel(data.month)} eyebrow="Month-end review">
            <p className="text-sm text-ink-700">
              You covered{" "}
              <span className="figure font-semibold">{Math.round(data.coveragePercent)}%</span> of your
              expected expenses that month — a{" "}
              <span className="figure font-semibold">{surplusOrShortfallText(data.surplusOrShortfall)}</span>{" "}
              against your coverage goal.
            </p>
          </Panel>

          <Panel title="Strongest and weakest open days">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="eyebrow mb-0.5">Strongest</div>
                {data.strongestOpenDay ? (
                  <p className="text-sm text-ink-900">
                    <span className="font-semibold">{formatDayLabel(data.strongestOpenDay.date)}</span>{" "}
                    — <span className="figure">{formatMoney(data.strongestOpenDay.sales)}</span>
                  </p>
                ) : (
                  <p className="text-sm text-ink-500">No open days recorded that month.</p>
                )}
              </div>
              <div>
                <div className="eyebrow mb-0.5">Weakest</div>
                {data.weakestOpenDay ? (
                  <p className="text-sm text-ink-900">
                    <span className="font-semibold">{formatDayLabel(data.weakestOpenDay.date)}</span>{" "}
                    — <span className="figure">{formatMoney(data.weakestOpenDay.sales)}</span>
                  </p>
                ) : (
                  <p className="text-sm text-ink-500">No open days recorded that month.</p>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Missing or provisional days">
            <p className="text-sm text-ink-700">
              <span className="figure font-semibold">{data.missingOrProvisionalDayCount}</span> of{" "}
              <span className="figure font-semibold">{data.openDayCount}</span> open days that month were
              either missing sales references or still needed review.
            </p>
          </Panel>

          <Panel title="Original vs. final adjusted daily target">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                  Original daily target
                </dt>
                <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                  {formatMoney(data.originalDailyTarget)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                  Final adjusted daily target
                </dt>
                {data.finalAdjustedDailyTarget !== null ? (
                  <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                    {formatMoney(data.finalAdjustedDailyTarget)}
                  </dd>
                ) : (
                  <dd className="mt-0.5 text-sm text-ink-500">
                    Not available — the month's last day was a closed day, so no per-day rate applies.
                  </dd>
                )}
              </div>
            </dl>
          </Panel>

          {data.baselineAppearsOffFromPattern ? (
            <Callout tone="info">
              Your configured expected monthly expenses may not closely match the sales pattern recorded
              this month. This is just an observation — nothing about your settings has changed.
            </Callout>
          ) : null}

          <Panel title="Questions to consider for next month">
            {data.suggestedQuestionsForNextMonth.length > 0 ? (
              <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-700">
                {data.suggestedQuestionsForNextMonth.map((question, i) => (
                  <li key={i}>{question}</li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-500">No questions to consider for next month.</p>
            )}
            <p className="mt-3 text-xs text-ink-500">
              These are prompts to think about — nothing here changes your settings automatically. Want to
              make a change yourself?{" "}
              <Link
                to={`/business-profiles/${selected.id}/edit`}
                className="tap-inline font-semibold text-brand-700 underline underline-offset-2"
              >
                Edit business profile →
              </Link>
            </p>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
