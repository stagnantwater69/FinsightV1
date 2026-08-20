import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { AskFinSightButton, AskFinSightDrawer } from "../components/AskFinSightDrawer";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { StatTile } from "../components/StatTile";
import { DataTable, type Column } from "../components/DataTable";
import { STATUS_TEXT_COLORS } from "../lib/chartPalette";
import type { DailyCoverageRow, DayStatus, RecoveryInsight } from "../lib/types";
import { AiCard, Callout, Card, Kw, PageHead, Panel, Pill, type PillTone } from "../components/ui";
import { Money, formatMoney } from "../components/Money";
import { SkeletonPanel, SkeletonRows, SkeletonStatTile } from "../components/Skeleton";

// Text-variant colors: used for the Gap column, which stays a plain coloured
// figure rather than a chip — see the Pill mapping below for the Status
// column, which IS a chip.
function statusColor(status: DayStatus): string {
  return status === "below"
    ? STATUS_TEXT_COLORS.critical
    : status === "at"
      ? STATUS_TEXT_COLORS.warning
      : STATUS_TEXT_COLORS.good;
}

function statusLabel(status: DayStatus): string {
  return status === "below" ? "Below target" : status === "at" ? "Reached target" : "Above target";
}

// The Status column as a themed Pill rather than a hand-rolled chip painted
// with an inline background colour — see the note on PILL_TONES in ui.tsx.
// "at" reads as informational rather than a warning: reaching the target
// exactly is a good outcome, not a caution.
const STATUS_TONE: Record<DayStatus, PillTone> = {
  below: "danger",
  at: "info",
  above: "ok",
};

function statusGlyph(status: DayStatus): string {
  return status === "below" ? "▼" : status === "at" ? "＝" : "▲";
}

// Column defs live at module scope, same as every other DataTable call site —
// they don't close over component state, so there's no reason to recreate
// them on every render.
const DAILY_COVERAGE_COLUMNS: Column<DailyCoverageRow>[] = [
  {
    key: "date",
    header: "Day",
    width: "content",
    sortValue: (d) => d.date,
    cell: (d) => <span className="whitespace-nowrap font-medium text-ink-700">{d.date}</span>,
  },
  {
    key: "neededTarget",
    header: "Needed target",
    width: "content",
    align: "right",
    sortValue: (d) => d.neededTarget,
    cell: (d) => (
      <span className="text-ink-600">
        <Money value={d.neededTarget} />
      </span>
    ),
  },
  {
    key: "sales",
    header: "Sales reference",
    width: "content",
    align: "right",
    sortValue: (d) => d.sales,
    cell: (d) => (
      <span className="text-ink-600">
        <Money value={d.sales} />
      </span>
    ),
  },
  {
    key: "gap",
    header: "Gap",
    width: "content",
    align: "right",
    sortValue: (d) => d.gap,
    cell: (d) => (
      <span className="font-medium" style={{ color: statusColor(d.status) }}>
        {d.status === "at" ? (
          <Money value={0} />
        ) : (
          <>
            <Money value={Math.abs(d.gap)} /> {d.status}
          </>
        )}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    width: "content",
    sortValue: (d) => d.status,
    cell: (d) => (
      <Pill tone={STATUS_TONE[d.status]}>
        <span aria-hidden>{statusGlyph(d.status)}</span>
        {statusLabel(d.status)}
      </Pill>
    ),
  },
];

export function RecoveryInsightPage() {
  const { selected } = useBusinessProfiles();
  const [data, setData] = useState<RecoveryInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set only by the "expand on this" link — the plain header button opens
  // the drawer with this left undefined, same as always.
  const [drawerQuestion, setDrawerQuestion] = useState<string | undefined>(undefined);

  async function load() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<RecoveryInsight>("/insights/recovery", {
        // The server caps this at the days actually elapsed this month
        // (max 31) — asking for the ceiling every time is what gives the
        // Daily coverage table enough rows for pagination to mean anything,
        // rather than requesting a fixed 14 and hiding the rest.
        params: { businessProfileId: selected.id, coverageDays: 31 },
      });
      setData(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  if (!selected) return null;

  // Names the exact gap and target the card below just described, rather
  // than a generic "how much more sales do I need?".
  const expandQuestion = data
    ? `Why is today's sales reference ${formatMoney(Math.abs(data.todaysGap))} ${statusLabel(data.todaysStatus).toLowerCase()}, and how do I close it?`
    : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Recovery target"
        subtitle={
          <>
            Target-Based Recovery Insight — answers "Did my recorded sales reference reach the needed
            target, and how much is still needed?"
          </>
        }
      />

      <InsightsTabs />

      {error ? <p className="mb-4 text-sm text-tone-danger">{error}</p> : null}

      {/*
        SAID BEFORE THE FIGURES, because without it the figures are a false
        accusation.

        Recovery is month-to-date and has no period to select, so a business
        whose records were imported and stop months ago is shown zero sales
        against its full monthly target — a page confidently reporting that the
        owner has missed everything, for a month they never traded in. The
        numbers below are arithmetically correct and completely misleading on
        their own; this is the sentence that makes them honest.
      */}
      {!loading && data?.monthHasNoRecords ? (
        <div className="mb-5">
          <Callout tone="warn">
            <b className="font-semibold">No sales are recorded for this month yet</b>, so every figure
            below compares your target against zero. It isn't a shortfall you've made — there's simply
            nothing in this month to measure.
            {data.latestSaleDate ? (
              <>
                {" "}
                Your most recent sale is dated{" "}
                <span className="figure font-semibold">
                  {new Date(data.latestSaleDate).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </span>
                .
              </>
            ) : null}{" "}
            <Link
              to="/records"
              className="tap-inline font-semibold text-brand-700 underline underline-offset-2"
            >
              See your records →
            </Link>
          </Callout>
        </div>
      ) : null}

      {loading || !data ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading your recovery target…</span>
          <div className="grid gap-4 sm:grid-cols-3">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <SkeletonPanel lines={3} />
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <Card>
            <SkeletonRows rows={5} />
          </Card>
          <SkeletonPanel lines={3} />
        </div>
      ) : (
        <div className="space-y-6">
          {/* This tracks the current calendar month — there is no period to
              choose, so the pill here just names what "today" means rather
              than offering a control that does nothing. */}
          <Panel title="Inputs" action={<span className="text-xs text-ink-400">Today</span>}>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile
                label="Expected monthly expenses"
                value={formatMoney(data.expectedMonthlyExpenses)}
                sublabel="Owner-entered reference"
              />
              <StatTile
                label="Operating days / month"
                value={String(data.operatingDays)}
                sublabel="Owner-entered reference"
              />
              <StatTile
                label="Daily needed target"
                value={formatMoney(data.dailyNeededTarget)}
                sublabel="Computed from the two figures beside it"
                emphasis
              />
            </div>
            <p className="mt-3 text-xs text-ink-400">
              Daily needed target = expected monthly expenses ÷ operating days. This is a target-based
              recovery guide using your sales reference records — it does not calculate formal financial
              results.
            </p>
          </Panel>

          <div className="grid gap-4 sm:grid-cols-4">
            <StatTile label="Today's target" value={formatMoney(data.todaysTarget)} />
            <StatTile
              label="Sales reference today"
              value={formatMoney(data.todaysSales)}
              sublabel="From your records"
            />
            <StatTile
              label="Today's gap"
              value={formatMoney(Math.abs(data.todaysGap))}
              sublabel={statusLabel(data.todaysStatus).toLowerCase()}
            />
            <StatTile
              label="Status"
              value={statusLabel(data.todaysStatus)}
              sublabel={
                data.todaysTarget > 0
                  ? `${((data.todaysSales / data.todaysTarget) * 100).toFixed(0)}% of today's target reached`
                  : undefined
              }
            />
          </div>

          <Panel title="Month-to-date pace">
            <RecoveryMeter recoveryStatus={data} />
          </Panel>

          <Panel title="Remaining recovery target" eyebrow="Recalculated across your remaining operating days">
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile
                label="Expected monthly expenses"
                value={formatMoney(data.expectedMonthlyExpenses)}
                sublabel="Owner-entered reference"
              />
              <StatTile
                label="Sales reference so far this month"
                value={formatMoney(data.salesThisMonth)}
                sublabel="From your records"
              />
              <StatTile
                label="Remaining target"
                value={formatMoney(data.remainingTarget)}
                sublabel="Computed from your records"
              />
              <StatTile
                label="Remaining operating days"
                value={`≈ ${data.remainingOperatingDays}`}
                sublabel={`${data.calendarDaysLeftInMonth} of ${data.daysInMonth} calendar days left`}
              />
              <StatTile
                label="Adjusted daily target"
                value={formatMoney(data.adjustedDailyTarget)}
                sublabel="Remaining target ÷ remaining operating days"
                emphasis
              />
            </div>
            <p className="mt-3 text-xs text-ink-400">
              Remaining target = expected monthly expenses − sales reference recorded so far. Adjusted daily
              target updates as you record more sales references — it's a recovery guide, not a guaranteed
              outcome.
            </p>
            {data.remainingOperatingDaysIsApproximated ? (
              <p className="mt-1 text-xs text-ink-400">
                Remaining operating days is an estimate: your profile records how many days a month you
                operate, not which days of the week, so this scales your monthly count by how much of the
                month is left.
              </p>
            ) : null}
          </Panel>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-700">Daily coverage</h2>
              <span className="text-xs text-ink-400">Month to date</span>
            </div>
            <DataTable
              rows={data.dailyCoverage}
              columns={DAILY_COVERAGE_COLUMNS}
              getRowKey={(d) => d.date}
              caption={`Daily sales reference against target for ${selected.name}, month to date.`}
              itemNoun="days"
              storageKey="recovery-daily-coverage"
              initialSort={{ key: "date", direction: "desc" }}
              empty={<p className="p-4 text-sm text-ink-500">No days recorded yet this month.</p>}
              mobileRow={(d) => (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink-900">{d.date}</p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      <Money value={d.sales} bare /> of <Money value={d.neededTarget} bare /> needed
                    </p>
                  </div>
                  <Pill tone={STATUS_TONE[d.status]}>
                    <span aria-hidden>{statusGlyph(d.status)}</span>
                    {statusLabel(d.status)}
                  </Pill>
                </div>
              )}
            />
          </div>

          <AiCard
            title="FinSight explanation"
            subtitle="Scoped to Recovery Target — composed from your records, not AI-written"
            footer={
              <button
                type="button"
                onClick={() => {
                  setDrawerQuestion(expandQuestion);
                  setDrawerOpen(true);
                }}
                className="tap-inline font-semibold text-accent-200 underline-offset-2 hover:underline"
              >
                Ask about this gap →
              </button>
            }
          >
            Your sales reference for today is{" "}
            <Kw>
              <span className="figure">{formatMoney(Math.abs(data.todaysGap))}</span>
            </Kw>{" "}
            {statusLabel(data.todaysStatus).toLowerCase()}. Based on your expected monthly expenses and
            recorded sales references so far, FinSight estimates that you need around{" "}
            <Kw>
              <span className="figure">{formatMoney(data.adjustedDailyTarget)}</span>
            </Kw>{" "}
            per remaining operating day to still reach the monthly target.
          </AiCard>
        </div>
      )}

      <AskFinSightButton
        onClick={() => {
          setDrawerQuestion(undefined);
          setDrawerOpen(true);
        }}
      />

      <AskFinSightDrawer
        businessProfileId={selected.id}
        module="Recovery Target"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        initialQuestion={drawerQuestion}
      />
    </div>
  );
}
