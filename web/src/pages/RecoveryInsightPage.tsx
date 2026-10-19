import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { IconTile } from "../components/IconTile";
import { ListDisclosureControl, useListDisclosure } from "../components/ListDisclosure";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookmarkCheck,
  BookmarkPlus,
  CalendarCheck,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronUp,
  CircleGauge,
  CircleHelp,
  Flag,
  FlaskConical,
  History,
  Info,
  ListChecks,
  Minus,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import {
  ReportingPeriodScope,
  useReportingPeriod,
} from "../context/ReportingPeriodContext";
import { api } from "../lib/api";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import {
  AskFinSightButton,
  useAskFinSight,
} from "../components/AskFinSightButton";
import { monthToneAndCopy } from "../lib/recoveryMonthState";
import { PeriodFilter } from "../components/PeriodFilter";
import { DataTable, type Column } from "../components/DataTable";
import { Button, ButtonLink, classesFor } from "../components/Button";
import { PageTip } from "../components/PageTip";
import { Field, FormError, MoneyInput } from "../components/Field";
import {
  STATUS_COLORS,
  STATUS_INK,
  STATUS_TEXT_COLORS,
} from "../lib/chartPalette";
import {
  CumulativeSalesChart,
  DailySalesChart,
  ProgressRing,
  TargetBreakdown,
} from "./recovery/RecoveryCharts";
import { buildCumulativeSeries, shortDay } from "./recovery/recoverySeries";
import type {
  DailyCoverageRow,
  DailyCoverageStatus,
  DayStatus,
  MonthlyExpenseBasis,
  RecoveryCheckpoint,
  RecoveryCheckpointStatus,
  RecoveryInsight,
  RecoveryPlan,
  RecoveryReportingPeriod,
  RecoveryScenario,
  RecoveryStatus,
} from "../lib/types";
import {
  AiCard,
  Callout,
  Card,
  Kw,
  PageHead,
  Panel,
  Pill,
  type PillTone,
} from "../components/ui";
import { Money, formatMoney } from "../components/Money";
import { EmptyState } from "../components/EmptyState";
import { SectionNav, type SectionNavItem } from "../components/SectionNav";
import {
  SkeletonPanel,
  SkeletonRows,
  SkeletonStatTile,
} from "../components/Skeleton";
import { TextInput } from "../components/Field";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import {
  THIS_WEEK,
  monthLabel,
  periodKey,
  periodParams,
  type PeriodSelection,
} from "../lib/reportingPeriod";

// Text-variant colors: used for the Gap column, which stays a plain coloured
// figure rather than a chip — see the Pill mapping below for the Status
// column, which IS a chip.
//
// `statusColor` only ever needs to answer for the three statuses a figure is
// actually drawn for — a closed day renders "—" instead (see
// DAILY_COVERAGE_COLUMNS' Gap cell), so it never reaches here.
function statusColor(status: DayStatus): string {
  return status === "below"
    ? STATUS_TEXT_COLORS.critical
    : status === "at"
      ? STATUS_TEXT_COLORS.warning
      : STATUS_TEXT_COLORS.good;
}

function statusLabel(status: DayStatus): string {
  return status === "below"
    ? "Below target"
    : status === "at"
      ? "Reached target"
      : "Above target";
}

/** Same wording, extended for the daily table's `"closed"` row status —
 * plan §8.3. Kept separate from `statusLabel` above because every OTHER call
 * site (today's status, the scenario summaries) only ever has a `DayStatus`
 * and can never be handed `"closed"`. */
function dailyRowStatusLabel(status: DailyCoverageStatus): string {
  return status === "closed" ? "Closed" : statusLabel(status);
}

function recoveryPeriodLabel(period: RecoveryReportingPeriod): string {
  if (period.kind === "week") return "This week";
  return monthLabel(period.month ?? period.start.slice(0, 7));
}

function recoveryPeriodPhrase(period: RecoveryReportingPeriod): string {
  if (period.kind === "week") return "this week";
  return `in ${recoveryPeriodLabel(period)}`;
}

function recoveryPeriodStatusLabel(period: RecoveryReportingPeriod): string {
  switch (period.status) {
    case "needs_setup":
      return "Recovery Target isn't ready yet";
    case "no_data":
      return period.kind === "week"
        ? "No sales recorded this week"
        : `No sales recorded in ${recoveryPeriodLabel(period)}`;
    case "covered":
      return "Sales coverage target reached";
    case "ahead":
      return period.isComplete ? "Finished above target" : "Ahead of pace";
    case "on_pace":
      return period.isComplete ? "Finished on target" : "On pace";
    case "behind":
      return period.isComplete ? "Finished below target" : "Behind pace";
  }
}

function formatOperatingDayNumber(value: number, approximated: boolean): string {
  return approximated
    ? (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "")
    : String(Math.round(value));
}

function formatOperatingDays(value: number, approximated: boolean): string {
  const rounded = formatOperatingDayNumber(value, approximated);
  return approximated ? `≈ ${rounded}` : rounded;
}

function basisRecordSource(basis: MonthlyExpenseBasis): string {
  const records = `${basis.eligibleRecordCount} confirmed expense ${basis.eligibleRecordCount === 1 ? "record" : "records"}`;
  return basis.sourceMonth
    ? `${records} in ${monthLabel(basis.sourceMonth)}`
    : records;
}

function reportingPeriodBasisSource(
  data: RecoveryInsight,
  period: RecoveryReportingPeriod,
): string {
  const entries = period.monthlyExpenseBases ?? [];

  if (entries.length > 1) {
    const sources = entries.map(({ targetMonth, basis }) =>
      basis.source === "previous_complete_month"
        ? `${monthLabel(targetMonth)} (${basisRecordSource(basis)})`
        : `${monthLabel(targetMonth)} (starting estimate)`,
    );
    return `Prorated across ${sources.join(" and ")}.`;
  }

  const selectedMonth = period.start.slice(0, 7) === period.end.slice(0, 7);
  const basis =
    entries[0]?.basis ??
    (!data.reportingPeriod || (period.isCurrent && selectedMonth)
      ? data.monthlyExpenseBasis
      : undefined);

  if (!basis) {
    return period.targetBasis === "prorated_monthly_expenses"
      ? "Prorated from the monthly expense basis"
      : "Monthly expense basis from the server";
  }

  if (basis.source === "previous_complete_month") {
    const source = basisRecordSource(basis);
    return period.targetBasis === "prorated_monthly_expenses"
      ? `Prorated from ${source}.`
      : `From ${source}.`;
  }

  return period.targetBasis === "prorated_monthly_expenses"
    ? "Prorated from your starting estimate."
    : "Starting estimate from your business profile.";
}

function legacyReportingPeriod(data: RecoveryInsight): RecoveryReportingPeriod {
  const start = data.monthStart.slice(0, 10);
  const month = start.slice(0, 7);
  const end = `${month}-${String(data.daysInMonth).padStart(2, "0")}`;
  const status: RecoveryReportingPeriod["status"] =
    data.status === "no_current_month_data" || data.status === "data_incomplete"
      ? "no_data"
      : data.status ?? (data.needsSetup ? "needs_setup" : data.onTrack ? "on_pace" : "behind");
  const operatingDays = data.operatingDaysThisMonth ?? data.operatingDays;

  return {
    kind: "month",
    month,
    start,
    end,
    asOfDate: data.asOfDate ?? data.today.slice(0, 10),
    timezone: data.timezone ?? "UTC",
    isCurrent: true,
    isComplete: false,
    targetBasis: "monthly_expenses",
    target: data.expectedMonthlyExpenses,
    sales: data.salesThisMonth,
    confirmedSales: data.confirmedSalesThisMonth ?? data.salesThisMonth,
    provisionalSales: data.provisionalSalesThisMonth ?? 0,
    remainingTarget: data.remainingTarget,
    coveragePercent: data.monthCoveragePercent,
    dailyTarget: data.dailyNeededTarget,
    adjustedDailyTarget: data.adjustedDailyTarget,
    operatingDays,
    elapsedOperatingDays: Math.max(0, operatingDays - data.remainingOperatingDays),
    remainingOperatingDays: data.remainingOperatingDays,
    operatingScheduleConfigured: data.operatingScheduleConfigured ?? false,
    operatingDaysIsApproximated: data.remainingOperatingDaysIsApproximated,
    expectedSalesToDate: data.expectedSalesToDate ?? 0,
    paceVarianceAmount: data.paceVarianceAmount ?? 0,
    status,
    confidence: data.confidence ?? "unavailable",
    recordCount: data.dailyCoverage.length,
    dataWarnings: data.dataWarnings ?? [],
  };
}

// The Status column as a themed Pill rather than a hand-rolled chip painted
// with an inline background colour — see the note on PILL_TONES in ui.tsx.
// "at" reads as informational rather than a warning: reaching the target
// exactly is a good outcome, not a caution. "closed" is neutral — a
// configured non-operating day is neither good nor bad news, so it must not
// borrow the danger/info/ok tones the other three statuses use.
const STATUS_TONE: Record<DailyCoverageStatus, PillTone> = {
  below: "danger",
  at: "info",
  above: "ok",
  closed: "neutral",
};

function DailyStatusIcon({ status }: { status: DailyCoverageStatus }) {
  const Icon =
    status === "below"
      ? ArrowDown
      : status === "at"
        ? Minus
        : status === "closed"
          ? CalendarOff
          : ArrowUp;
  return <Icon aria-hidden className="size-3.5" />;
}

// Weekly checkpoints — plan §10.4. Same tone/colour convention as the daily
// coverage table's own STATUS_TONE above: "behind" reads like "below",
// "on_pace" reads like "at" (informational, not a warning — matching pace is
// good news), "ahead" reads like "above", and "pending" (a checkpoint whose
// endDate hasn't arrived yet) is neutral, the same way a closed day is.
const CHECKPOINT_STATUS_TONE: Record<RecoveryCheckpointStatus, PillTone> = {
  behind: "danger",
  on_pace: "info",
  ahead: "ok",
  pending: "neutral",
};

function checkpointStatusColor(status: RecoveryCheckpointStatus): string {
  return status === "behind"
    ? STATUS_TEXT_COLORS.critical
    : status === "on_pace"
      ? STATUS_TEXT_COLORS.warning
      : status === "ahead"
        ? STATUS_TEXT_COLORS.good
        : "";
}

function checkpointStatusLabel(status: RecoveryCheckpointStatus): string {
  switch (status) {
    case "behind":
      return "Behind pace";
    case "on_pace":
      return "On pace";
    case "ahead":
      return "Ahead of pace";
    case "pending":
      return "Pending";
  }
}

/** Surface treatment per checkpoint status, from the themed status tokens. */
const CHECKPOINT_LOOK: Record<
  RecoveryCheckpointStatus,
  { wash: string; ring: string; track: string; fill: string }
> = {
  behind: {
    wash: "from-tint-danger",
    ring: "ring-edge-danger",
    track: "bg-edge-danger",
    fill: "bg-tone-danger",
  },
  on_pace: {
    wash: "from-tint-info",
    ring: "ring-edge-info",
    track: "bg-edge-info",
    fill: "bg-tone-info",
  },
  ahead: {
    wash: "from-tint-brand",
    ring: "ring-edge-brand",
    track: "bg-edge-brand",
    fill: "bg-tone-brand",
  },
  pending: {
    wash: "from-tint-neutral",
    ring: "ring-paper-200",
    track: "bg-paper-200",
    fill: "bg-tone-neutral",
  },
};

function formatCheckpointDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * One checkpoint, shown prominently — plan §10.4: "Show at most the current
 * and next checkpoint prominently." A `pending` checkpoint (its `endDate` is
 * still in the future) has no `recordedAmount`/`variance` yet, so those cells
 * read "Not yet reached"/"—" instead of a null or a false zero.
 */
function CheckpointCard({
  label,
  checkpoint,
}: {
  label: string;
  checkpoint: RecoveryCheckpoint;
}) {
  const isPending = checkpoint.status === "pending";
  const look = CHECKPOINT_LOOK[checkpoint.status];
  const reached =
    !isPending && checkpoint.recordedAmount !== null && checkpoint.cumulativeTarget > 0
      ? (checkpoint.recordedAmount / checkpoint.cumulativeTarget) * 100
      : null;
  return (
    <div
      className={`relative flex h-full flex-col rounded-xl bg-gradient-to-br ${look.wash} to-paper p-4 ring-1 ${look.ring}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={Flag} />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-600">
              {label}
            </p>
            <p className="text-sm font-semibold text-ink-900">
              {formatCheckpointDate(checkpoint.endDate)}
            </p>
          </div>
        </div>
        <Pill tone={CHECKPOINT_STATUS_TONE[checkpoint.status]}>
          {checkpointStatusLabel(checkpoint.status)}
        </Pill>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-600">Cumulative target</dt>
          <dd className="figure font-semibold text-ink-900">
            {formatMoney(checkpoint.cumulativeTarget)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-600">Recorded amount</dt>
          <dd className="figure font-semibold text-ink-900">
            {isPending || checkpoint.recordedAmount === null ? (
              <span className="text-ink-600">Not yet reached</span>
            ) : (
              formatMoney(checkpoint.recordedAmount)
            )}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-ink-600">Variance</dt>
          <dd
            className="figure font-semibold"
            style={{
              color: checkpointStatusColor(checkpoint.status) || undefined,
            }}
          >
            {isPending || checkpoint.variance === null ? (
              <span className="text-ink-600">—</span>
            ) : (
              formatMoney(checkpoint.variance, { signed: true })
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-auto pt-3">
        <div aria-hidden className={`h-1.5 w-full overflow-hidden rounded-full ${look.track}`}>
          {reached !== null ? (
            <div
              className={`h-full rounded-full ${look.fill}`}
              style={{ width: `${Math.min(Math.max(reached, reached > 0 ? 3 : 0), 100)}%` }}
            />
          ) : null}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-500">
          {reached !== null
            ? `${Math.round(reached)}% of this checkpoint's target recorded`
            : "Counts once this date arrives"}
        </p>
      </div>
    </div>
  );
}

// Secondary, full list — plan §10.4: "keep the full list secondary". Reuses
// the DataTable convention every other tabular surface on this page already
// uses, rather than hand-rolling a second table shape.
const CHECKPOINT_COLUMNS: Column<RecoveryCheckpoint>[] = [
  {
    key: "endDate",
    header: "End date",
    width: "content",
    sortValue: (c) => c.endDate,
    cell: (c) => (
      <span className="whitespace-nowrap font-medium text-ink-700">
        {formatCheckpointDate(c.endDate)}
      </span>
    ),
  },
  {
    key: "cumulativeTarget",
    header: "Cumulative target",
    width: "content",
    align: "right",
    sortValue: (c) => c.cumulativeTarget,
    cell: (c) => (
      <span className="text-ink-600">
        <Money value={c.cumulativeTarget} />
      </span>
    ),
  },
  {
    key: "recordedAmount",
    header: "Recorded amount",
    width: "content",
    align: "right",
    sortValue: (c) => c.recordedAmount ?? -1,
    cell: (c) =>
      c.recordedAmount === null ? (
        <span className="text-ink-500">Not yet reached</span>
      ) : (
        <span className="text-ink-600">
          <Money value={c.recordedAmount} />
        </span>
      ),
  },
  {
    key: "variance",
    header: "Variance",
    width: "content",
    align: "right",
    sortValue: (c) => c.variance ?? 0,
    cell: (c) =>
      c.variance === null ? (
        <span className="text-ink-500">—</span>
      ) : (
        <span
          className="font-medium"
          style={{ color: checkpointStatusColor(c.status) || undefined }}
        >
          <Money value={c.variance} signed />
        </span>
      ),
  },
  {
    key: "status",
    header: "Status",
    width: "content",
    sortValue: (c) => c.status,
    cell: (c) => (
      <Pill tone={CHECKPOINT_STATUS_TONE[c.status]}>
        {checkpointStatusLabel(c.status)}
      </Pill>
    ),
  },
];

/**
 * "Current" is the most recent checkpoint whose `endDate` has already
 * arrived, or the first checkpoint if none have — plan §10.4. Checkpoints
 * arrive from the server sorted ascending by `endDate`, so a single forward
 * scan keeping the last one at-or-before `todayKey` is enough.
 */
function findCurrentAndNextCheckpoints(
  checkpoints: RecoveryCheckpoint[],
  todayKey: string,
): { current: RecoveryCheckpoint | null; next: RecoveryCheckpoint | null } {
  let current: RecoveryCheckpoint | null = null;
  let next: RecoveryCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.endDate <= todayKey) {
      current = checkpoint;
    } else if (!next) {
      next = checkpoint;
    }
  }
  if (!current) current = checkpoints[0] ?? null;
  // The rare early-month case where the very first checkpoint hasn't
  // happened yet: it is both the "current" fallback and the "next"
  // checkpoint, so it is shown once rather than twice — mirrors mobile's
  // RecoveryCheckpointsCard, which carries the same guard.
  if (next && current && next.endDate === current.endDate) next = null;
  return { current, next };
}

/**
 * Weekly checkpoints — plan §10.4. The current and next checkpoint are shown
 * prominently; the full month's list stays behind an expand toggle, the same
 * pattern `RecoveryScenarioPanel`'s own "Try a scenario" button already uses.
 */
function RecoveryCheckpoints({
  checkpoints,
  todayKey,
  periodName,
}: {
  checkpoints: RecoveryCheckpoint[];
  todayKey: string;
  periodName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (checkpoints.length === 0) return null;

  const { current, next } = findCurrentAndNextCheckpoints(
    checkpoints,
    todayKey,
  );

  return (
    <Panel
      title="Weekly checkpoints"
      eyebrow={`Cumulative open-day targets for ${periodName}`}
      action={
        !expanded ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setExpanded(true)}
          >
            Show all checkpoints
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setExpanded(false)}
          >
            Hide full list
          </Button>
        )
      }
    >
      <div className={`grid gap-4 ${current && next ? "sm:grid-cols-2" : ""}`}>
        {current ? (
          <CheckpointCard label="Current checkpoint" checkpoint={current} />
        ) : null}
        {next ? (
          <CheckpointCard label="Next checkpoint" checkpoint={next} />
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-4">
          <DataTable
            rows={checkpoints}
            columns={CHECKPOINT_COLUMNS}
            getRowKey={(c) => c.endDate}
            caption={`All weekly checkpoints for ${periodName}.`}
            itemNoun="checkpoints"
            initialSort={{ key: "endDate", direction: "asc" }}
            empty={
              <p className="p-4 text-sm text-ink-500">
                No checkpoints for {periodName}.
              </p>
            }
            mobileRow={(c) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">
                    {formatCheckpointDate(c.endDate)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {c.recordedAmount === null ? (
                      "Not yet reached"
                    ) : (
                      <>
                        <Money value={c.recordedAmount} bare /> of{" "}
                        <Money value={c.cumulativeTarget} bare /> target
                      </>
                    )}
                  </p>
                </div>
                <Pill tone={CHECKPOINT_STATUS_TONE[c.status]}>
                  {checkpointStatusLabel(c.status)}
                </Pill>
              </div>
            )}
          />
        </div>
      ) : null}
    </Panel>
  );
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
    cell: (d) => (
      <span className="whitespace-nowrap font-medium text-ink-700">
        {d.date}
      </span>
    ),
  },
  {
    key: "neededTarget",
    header: "Allocated target",
    width: "content",
    align: "right",
    // Sorts closed days (null) to the low end rather than throwing on the
    // comparison — DataTable's sort just needs any stable, finite ordering.
    sortValue: (d) => d.neededTarget ?? -1,
    cell: (d) =>
      d.neededTarget === null ? (
        <span className="text-ink-500">—</span>
      ) : (
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
    sortValue: (d) => d.gap ?? 0,
    cell: (d) =>
      d.gap === null || d.status === "closed" ? (
        <span className="text-ink-500">—</span>
      ) : (
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
        <DailyStatusIcon status={d.status} />
        {dailyRowStatusLabel(d.status)}
      </Pill>
    ),
  },
];

/**
 * The state-specific primary action — plan §10.1/§10.2.
 *
 * One prominent action driven entirely by `data.status`; nothing here infers
 * a state from numeric fields. Renders nothing for an older/cached response
 * that never sent `status`, and renders informational text (never a dead
 * button) for `ahead`, which has nothing to navigate to.
 *
 * The `behind`/`covered` destinations are in-page anchors — this page has no
 * secondary route for "today's plan" or "month summary", just the panels
 * already further down this same page — so they scroll rather than navigate.
 */
/**
 * Scrolls an in-page anchor target into view and moves keyboard focus to it —
 * WCAG 2.4.3. The target needs `tabIndex={-1}` so it's programmatically
 * focusable without joining the normal tab order; `preventScroll: true` on
 * `.focus()` avoids a second, competing scroll after `scrollIntoView` already
 * placed it.
 */
function focusSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduceMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
  el.focus({ preventScroll: true });
}

/**
 * "Saved plan" in `RecoverySectionNav` needs to open the (collapsed-by-
 * default) "Try a scenario" panel when there's no plan yet to jump to — a
 * DOM event rather than lifted state, since `RecoveryScenarioPanel` owns its
 * own `expanded` flag and nothing else on the page otherwise needs to know
 * about it.
 */
const EXPAND_SCENARIO_EVENT = "finsight:recovery-expand-scenario";

function RecoverySectionNav({
  showCheckpoints,
  showDailyPlan,
  showPlanning,
  hasSavedPlan,
}: {
  showCheckpoints: boolean;
  showDailyPlan: boolean;
  showPlanning: boolean;
  hasSavedPlan: boolean;
}) {
  const items: SectionNavItem[] = [
    { href: "#recovery-overview", label: "Overview", icon: CircleGauge },
    ...(showDailyPlan
      ? [
          {
            href: "#remaining-recovery-target",
            label: "Daily plan",
            icon: Target,
          },
        ]
      : []),
    ...(showCheckpoints
      ? [
          {
            href: "#recovery-checkpoints",
            label: "Checkpoints",
            icon: ListChecks,
          },
        ]
      : []),
    ...(showPlanning
      ? [
          // Plans and scenarios change the current monthly baseline, so they
          // stay out of weekly and historical views.
          hasSavedPlan
            ? {
                href: "#recovery-saved-plan",
                label: "Saved plan",
                icon: BookmarkCheck,
              }
            : {
                href: "#recovery-scenario",
                label: "Save a plan",
                icon: BookmarkCheck,
                onClick: (e: MouseEvent) => {
                  e.preventDefault();
                  window.dispatchEvent(new Event(EXPAND_SCENARIO_EVENT));
                  focusSection("recovery-scenario");
                },
              },
          {
            href: "#recovery-scenario",
            label: "Scenario",
            icon: SlidersHorizontal,
          },
        ]
      : []),
    { href: "#daily-coverage", label: "Daily history", icon: History },
  ];

  return <SectionNav ariaLabel="Recovery target sections" items={items} />;
}

function RecoveryPrimaryAction({
  status,
  businessProfileId,
}: {
  status: RecoveryStatus | undefined;
  businessProfileId: number;
}) {
  const anchorClassName = classesFor("primary", "sm", false, "");

  switch (status) {
    case "needs_setup":
      return (
        <ButtonLink
          to={`/business-profiles/${businessProfileId}/edit`}
          variant="primary"
          size="sm"
        >
          Complete setup
        </ButtonLink>
      );
    case "no_current_month_data":
      return (
        <ButtonLink to="/records" variant="primary" size="sm">
          Record or import sales
        </ButtonLink>
      );
    // Not emitted by the server yet — wired ahead of time per the task, same
    // destination as no_current_month_data until the server distinguishes them.
    case "data_incomplete":
      return (
        <ButtonLink to="/records" variant="primary" size="sm">
          Review sales
        </ButtonLink>
      );
    case "behind":
      return (
        <a
          href="#remaining-recovery-target"
          className={anchorClassName}
          onClick={(event) => {
            event.preventDefault();
            focusSection("remaining-recovery-target");
          }}
        >
          View today's plan
        </a>
      );
    case "on_pace":
      return (
        <ButtonLink to="/records/sales/new" variant="primary" size="sm">
          Record today's sales
        </ButtonLink>
      );
    case "ahead":
      // Informational only — there is nothing to navigate to, so this is
      // plain text rather than a button that goes nowhere.
      return (
        <p className="text-sm font-medium text-ink-600">
          Maintain current pace
        </p>
      );
    case "covered":
      return (
        <a
          href="#daily-coverage"
          className={anchorClassName}
          onClick={(event) => {
            event.preventDefault();
            focusSection("daily-coverage");
          }}
        >
          Review month summary
        </a>
      );
    default:
      return null;
  }
}

/** Plain-language mapping for `changeSincePreviousDay.primaryReason` — plan §10.3.
 *  `no_material_change` is handled by the caller, which renders nothing for it. */
function changeReasonCopy(
  reason: NonNullable<
    RecoveryInsight["changeSincePreviousDay"]
  >["primaryReason"],
): string | null {
  switch (reason) {
    case "sales_added":
      return "Recorded sales are helping close the gap.";
    case "open_day_elapsed":
      return "A day has passed, and the remaining amount is now spread across fewer days.";
    case "baseline_changed":
    case "schedule_changed":
    case "data_changed":
      return "Your setup or schedule changed.";
    case "no_material_change":
      return null;
  }
}

/**
 * "Why your target changed" — plan §10.3.
 *
 * Deterministic and server-computed, same discipline as the rest of this
 * page: no arithmetic happens here, just formatting of fields the backend
 * already returned. Renders nothing when there is nothing worth explaining —
 * either the field is absent/null, or its own reason says so.
 */
function RecoveryChangeSincePreviousDay({
  change,
}: {
  change: RecoveryInsight["changeSincePreviousDay"];
}) {
  if (!change) return null;
  const reasonCopy = changeReasonCopy(change.primaryReason);
  if (!reasonCopy) return null;

  const increased = change.adjustedDailyTargetDelta > 0;
  const unchanged = change.adjustedDailyTargetDelta === 0;

  return (
    <Panel title="Why your target changed">
      <p className="text-sm text-ink-700">
        {unchanged ? (
          "Your adjusted daily target is unchanged from yesterday."
        ) : (
          <>
            Your adjusted daily target {increased ? "increased" : "decreased"}{" "}
            by{" "}
            <span className="figure font-semibold">
              {formatMoney(Math.abs(change.adjustedDailyTargetDelta), {
                decimals: true,
              })}
            </span>
            .
          </>
        )}{" "}
        {reasonCopy}
      </p>
      {change.salesAdded !== 0 ? (
        <p className="mt-1 text-sm text-ink-700">
          {/* No Math.abs needed: salesAdded is algebraically todaysSales, a
              sum of positive()-validated amounts, so it's currently always
              >= 0 server-side. If refunds/negative adjustments ever make it
              negative, this copy will need a distinct negative-value phrasing. */}
          You recorded{" "}
          <span className="figure font-semibold">
            {formatMoney(change.salesAdded, { decimals: true })}
          </span>{" "}
          in sales since yesterday.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-ink-500">
        Composed from your records, not AI-written.
      </p>
    </Panel>
  );
}

/**
 * "What if?" — a hypothetical Recovery Target scenario, plan §13.2/§15
 * Phase 5.
 *
 * THE ONLY VALID HYPOTHETICAL, per the plan: an explicit, owner-typed change
 * to `expectedMonthlyExpenses`, never one derived from a reduction-opportunity
 * simulation or any other guess. `POST /insights/recovery-scenario` is
 * read-only — see insights.service.ts `simulateRecoveryScenario` — and this
 * component has no path to the real "edit business profile" flow at all: no
 * button here writes `assumedExpectedMonthlyExpenses` anywhere. An owner who
 * wants to make a hypothetical real has to go and edit the business profile
 * deliberately, elsewhere.
 *
 * Visually distinct from the real target on purpose (plan §13.1/§13.2's own
 * requirement): the real figures above use the ordinary `StatTile`/`Panel`
 * surface, so the result here renders inside a dashed, differently-toned box
 * with its own "hypothetical, not saved" label repeated beside every figure
 * it produces — not just once at the top, where it would be easy to scroll
 * past and then read the numbers below as real.
 */
/**
 * One current-vs-hypothetical comparison line inside the scenario result —
 * plan §10.7: "Absolute and percentage deltas." Guards the percentage against
 * a near-zero denominator: when `current` is within a peso of 0 (including
 * exactly 0), only the peso delta is shown, not a divide-by-zero
 * "Infinity%"/"NaN%" — or, just as bad, a technically-finite but meaningless
 * figure like "+99999900%" from dividing a normal-sized delta by a tiny
 * fraction of a peso near month-end. Mirrors mobile's `ScenarioRow` floor —
 * keep the literal `1` (one peso) in sync with that file.
 */
function ScenarioCompareCard({
  label,
  current,
  hypothetical,
  emphasis = false,
}: {
  label: string;
  current: number;
  hypothetical: number;
  /** The figure that answers "what would I need per day?" gets the frame. */
  emphasis?: boolean;
}) {
  const delta = hypothetical - current;
  const percent = Math.abs(current) >= 1 ? (delta / current) * 100 : null;
  const unchanged = Math.abs(delta) < 0.5;
  // Every figure here is a target, so a lower one is the easier outcome.
  const Arrow = unchanged ? Minus : delta < 0 ? ArrowDown : ArrowUp;
  const chipTone = unchanged
    ? "bg-tint-neutral text-tone-neutral"
    : delta < 0
      ? "bg-tint-brand text-tone-brand"
      : "bg-tint-danger text-tone-danger";
  return (
    <div
      className={`min-w-0 rounded-xl bg-paper p-3.5 shadow-sm ring-1 ${
        emphasis ? "ring-2 ring-edge-accent" : "ring-paper-200"
      }`}
    >
      <p className="text-xs font-semibold text-ink-600">{label}</p>
      <p className="figure mt-1.5 break-words text-xl font-semibold leading-tight text-ink-900">
        {formatMoney(hypothetical)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="figure text-ink-500">Now {formatMoney(current)}</span>
        <span
          className={`figure inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${chipTone}`}
        >
          <Arrow aria-hidden className="size-3" />
          {unchanged
            ? "No change"
            : `${formatMoney(delta, { signed: true })}${
                percent !== null
                  ? ` (${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%)`
                  : ""
              }`}
        </span>
      </div>
    </div>
  );
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });
}

/**
 * A small, optional form for the fields a `RecoveryPlan` can hold — plan
 * §7.5/§10.7. Shared between "Save this as a plan" (seeded from the
 * scenario's assumed value) and editing an already-saved plan, so the two
 * flows can't drift in what fields they expose or how they validate.
 */
function RecoveryPlanFields({
  ownerTargetAmount,
  deadline,
  bufferPercent,
  onOwnerTargetAmountChange,
  onDeadlineChange,
  onBufferPercentChange,
}: {
  ownerTargetAmount: string;
  deadline: string;
  bufferPercent: string;
  onOwnerTargetAmountChange: (value: string) => void;
  onDeadlineChange: (value: string) => void;
  onBufferPercentChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Target amount" htmlFor="plan-owner-target-amount" optional>
        <MoneyInput
          id="plan-owner-target-amount"
          value={ownerTargetAmount}
          min={0}
          onChange={(e) => onOwnerTargetAmountChange(e.target.value)}
        />
      </Field>
      <Field label="Deadline" htmlFor="plan-deadline" optional>
        <TextInput
          id="plan-deadline"
          type="date"
          value={deadline}
          onChange={(e) => onDeadlineChange(e.target.value)}
        />
      </Field>
      <Field
        label="Buffer"
        htmlFor="plan-buffer-percent"
        optional
        hint="A percentage, for your own reference."
      >
        <div className="relative">
          <TextInput
            id="plan-buffer-percent"
            type="number"
            min={0}
            step={1}
            value={bufferPercent}
            onChange={(e) => onBufferPercentChange(e.target.value)}
            className="pr-8"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-500">
            %
          </span>
        </div>
      </Field>
    </div>
  );
}

/**
 * "This month's saved plan" — plan §7.5/§10.7. A purely owner-visible
 * planning artifact rendered separately from every real Recovery Target
 * figure above it; edit/delete are the only actions here, both explicit.
 * Renders nothing when there's no saved plan for the current month, per the
 * task: this is a secondary surface, not a prompt to create one.
 */
function SavedRecoveryPlanPanel({
  businessProfileId,
  monthKey,
  plan,
  onPlanChange,
}: {
  businessProfileId: number;
  monthKey: string;
  plan: RecoveryPlan;
  onPlanChange: (plan: RecoveryPlan | null) => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [ownerTargetAmount, setOwnerTargetAmount] = useState(
    plan.ownerTargetAmount !== null ? String(plan.ownerTargetAmount) : "",
  );
  const [deadline, setDeadline] = useState(plan.deadline ?? "");
  const [bufferPercent, setBufferPercent] = useState(
    plan.bufferPercent !== null ? String(plan.bufferPercent) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.put<RecoveryPlan>(
        `/business-profiles/${businessProfileId}/recovery-plans/${monthKey}`,
        {
          ownerTargetAmount:
            ownerTargetAmount.trim() === "" ? null : Number(ownerTargetAmount),
          deadline: deadline.trim() === "" ? null : deadline,
          bufferPercent:
            bufferPercent.trim() === "" ? null : Number(bufferPercent),
        },
      );
      onPlanChange(data);
      setEditing(false);
      toast(
        "Saved for reference — this doesn't change your business profile or recorded sales.",
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Remove your saved plan for ${formatMonthLabel(monthKey)}?`,
      body: "This only removes your reference notes — it never affected your actual Recovery Target.",
      confirmLabel: "Remove plan",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.delete(
        `/business-profiles/${businessProfileId}/recovery-plans/${monthKey}`,
      );
      onPlanChange(null);
      toast("Saved plan removed.");
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  return (
    <Panel
      eyebrow="For your reference only"
      title={`This month's saved plan — ${formatMonthLabel(monthKey)}`}
      action={
        !editing ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
            >
              Delete
            </Button>
          </div>
        ) : null
      }
    >
      <p className="mb-3 text-xs text-ink-500">
        Your note. It doesn’t change your target, profile or sales.
      </p>
      {editing ? (
        <form onSubmit={handleSave} className="space-y-3">
          <RecoveryPlanFields
            ownerTargetAmount={ownerTargetAmount}
            deadline={deadline}
            bufferPercent={bufferPercent}
            onOwnerTargetAmountChange={setOwnerTargetAmount}
            onDeadlineChange={setDeadline}
            onBufferPercentChange={setBufferPercent}
          />
          {error ? <FormError>{error}</FormError> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-500">Target amount</dt>
            <dd className="figure font-semibold text-ink-900">
              {plan.ownerTargetAmount === null ? (
                <span className="text-ink-500">—</span>
              ) : (
                formatMoney(plan.ownerTargetAmount)
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Deadline</dt>
            <dd className="font-semibold text-ink-900">
              {plan.deadline ? (
                new Date(plan.deadline).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })
              ) : (
                <span className="text-ink-500">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Buffer</dt>
            <dd className="figure font-semibold text-ink-900">
              {plan.bufferPercent === null ? (
                <span className="text-ink-500">—</span>
              ) : (
                `${plan.bufferPercent}%`
              )}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

function RecoveryScenarioPanel({
  businessProfileId,
  currentExpectedMonthlyExpenses,
  monthKey,
  hasSavedPlan,
  onPlanSaved,
}: {
  businessProfileId: number;
  currentExpectedMonthlyExpenses: number;
  monthKey: string;
  hasSavedPlan: boolean;
  onPlanSaved: (plan: RecoveryPlan) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rawValue, setRawValue] = useState(
    String(currentExpectedMonthlyExpenses),
  );
  // Once the owner types into the field, a background refresh that changes
  // the real expected-monthly-expenses must not silently overwrite what
  // they're mid-way through entering.
  const touchedRef = useRef(false);
  useEffect(() => {
    if (touchedRef.current) return;
    setRawValue(String(currentExpectedMonthlyExpenses));
  }, [currentExpectedMonthlyExpenses]);
  // Lets `RecoverySectionNav`'s "Save a plan" jump-link open this
  // collapsed-by-default panel from outside, without lifting `expanded`
  // state up through the page just for that one cross-component nudge.
  useEffect(() => {
    function onExpand() {
      setExpanded(true);
    }
    window.addEventListener(EXPAND_SCENARIO_EVENT, onExpand);
    return () => window.removeEventListener(EXPAND_SCENARIO_EVENT, onExpand);
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<RecoveryScenario | null>(null);
  // Guards against out-of-order responses: native form submission via Enter
  // in the money input isn't blocked by the submit button's `disabled`, so
  // two rapid submits with different assumed values can race — without this,
  // an earlier (e.g. smaller) request resolving AFTER a later (e.g. larger)
  // one would leave the displayed result mismatched with what was most
  // recently typed. Same pattern as `RecoveryInsightPage`'s own `requestId`
  // ref above, and as mobile's `RecoveryScenarioSheet`'s `seq` ref.
  const submitSeq = useRef(0);

  async function runScenario(value: number) {
    if (submitting) return;
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a number greater than or equal to 0.");
      return;
    }
    const thisSubmitSeq = ++submitSeq.current;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<RecoveryScenario>(
        "/insights/recovery-scenario",
        {
          businessProfileId,
          assumedExpectedMonthlyExpenses: value,
        },
      );
      if (thisSubmitSeq !== submitSeq.current) return;
      setScenario(res.data);
    } catch (err) {
      if (thisSubmitSeq !== submitSeq.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (thisSubmitSeq === submitSeq.current) setSubmitting(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runScenario(Number(rawValue));
  }

  // One-tap starting points relative to the real basis. They fill the field
  // and run the scenario, so the owner sees the result without typing.
  const presets = [
    { label: "−10%", factor: 0.9 },
    { label: "−20%", factor: 0.8 },
    { label: "+10%", factor: 1.1 },
  ];
  function applyPreset(factor: number) {
    const value = Math.round(currentExpectedMonthlyExpenses * factor);
    touchedRef.current = true;
    setRawValue(String(value));
    void runScenario(value);
  }

  const [showSavePlanForm, setShowSavePlanForm] = useState(false);
  const [planDeadline, setPlanDeadline] = useState("");
  const [planBufferPercent, setPlanBufferPercent] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [planSaveError, setPlanSaveError] = useState<string | null>(null);
  const [planSaveConfirmation, setPlanSaveConfirmation] = useState(false);

  async function handleSavePlan(e: FormEvent) {
    e.preventDefault();
    if (!scenario) return;
    setSavingPlan(true);
    setPlanSaveError(null);
    setPlanSaveConfirmation(false);
    try {
      const { data } = await api.put<RecoveryPlan>(
        `/business-profiles/${businessProfileId}/recovery-plans/${monthKey}`,
        {
          ownerTargetAmount: scenario.assumedExpectedMonthlyExpenses,
          deadline: planDeadline.trim() === "" ? null : planDeadline,
          bufferPercent:
            planBufferPercent.trim() === "" ? null : Number(planBufferPercent),
        },
      );
      onPlanSaved(data);
      setShowSavePlanForm(false);
      setPlanSaveConfirmation(true);
    } catch (err) {
      setPlanSaveError(getErrorMessage(err));
    } finally {
      setSavingPlan(false);
    }
  }

  return (
    <Panel
      eyebrow="Optional"
      title="What if my monthly expense basis changed?"
      action={
        expanded ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded
            aria-controls="recovery-scenario-body"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp aria-hidden className="size-4" />
            Hide
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={false}
            aria-controls="recovery-scenario-body"
            onClick={() => setExpanded(true)}
          >
            <ChevronDown aria-hidden className="size-4" />
            {scenario ? "Show scenario" : "Try a scenario"}
          </Button>
        )
      }
    >
      {!expanded ? (
        scenario ? (
          <p className="text-sm text-ink-600">
            Last result: at{" "}
            <span className="figure font-semibold text-ink-900">
              {formatMoney(scenario.assumedExpectedMonthlyExpenses)}
            </span>{" "}
            a month you would need{" "}
            <span className="figure font-semibold text-ink-900">
              {formatMoney(scenario.hypothetical.adjustedDailyTarget)}
            </span>{" "}
            a day. Not saved.
          </p>
        ) : (
          <p className="text-sm text-ink-500">
            Test a different monthly expense amount. Nothing is saved.
          </p>
        )
      ) : (
        <div id="recovery-scenario-body" className="space-y-4">
          {/* noValidate: the JS check in runScenario (finite, >= 0) is the
              single source of the error message shown, same as
              ReductionSimulationModal's own form — native HTML5 constraint
              validation on a min-0 number input would otherwise silently
              swallow the submit instead of surfacing that message. */}
          <form
            onSubmit={handleSubmit}
            className="flex flex-wrap items-end gap-3"
            noValidate
          >
            <Field
              label="Assumed monthly expense basis"
              htmlFor="recovery-scenario-value"
              hint="Your saved figure is unaffected."
              className="min-w-[14rem] flex-1"
            >
              <MoneyInput
                id="recovery-scenario-value"
                value={rawValue}
                min={0}
                onChange={(e) => {
                  touchedRef.current = true;
                  setRawValue(e.target.value);
                }}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Calculating…" : "See hypothetical target"}
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-500">Quick try:</span>
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={submitting}
                onClick={() => applyPreset(preset.factor)}
                className="tap-inline figure rounded-full bg-paper-100 px-3 py-1 text-xs font-semibold text-ink-700 ring-1 ring-paper-200 transition hover:bg-tint-brand hover:text-tone-brand hover:ring-edge-brand disabled:opacity-50"
              >
                {preset.label}
              </button>
            ))}
            <span className="text-xs text-ink-500">of your current basis</span>
          </div>

          {error ? <FormError>{error}</FormError> : null}

          {scenario ? (
            // The distinct surface itself: a dashed amber frame unlike every
            // other panel on this page, so it cannot be mistaken for another
            // read of the real target above (plan §13.1/§13.2).
            <div className="rounded-2xl border-2 border-dashed border-edge-accent bg-tint-accent/60 p-4 motion-safe:animate-fade-up sm:p-5">
              <div className="flex items-start gap-3">
                <IconTile icon={FlaskConical} />
                <p className="text-sm leading-relaxed text-ink-700">
                  <b className="font-semibold text-tone-accent">Hypothetical. Not saved.</b>{" "}
                  This does not change your records, starting estimate, or
                  active monthly expense basis. Assumed value used:{" "}
                  <span className="figure font-semibold text-ink-900">
                    {formatMoney(scenario.assumedExpectedMonthlyExpenses)}
                  </span>
                  .
                </p>
              </div>

              {/* Side-by-side current/hypothetical with deltas — plan §10.7. */}
              <div className="mt-4">
                <p className="text-xs font-semibold text-ink-700">
                  Current vs. hypothetical
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <ScenarioCompareCard
                    label="Monthly expense basis"
                    current={scenario.current.expectedMonthlyExpenses}
                    hypothetical={scenario.hypothetical.expectedMonthlyExpenses}
                  />
                  <ScenarioCompareCard
                    label="Remaining target"
                    current={scenario.current.remainingTarget}
                    hypothetical={scenario.hypothetical.remainingTarget}
                  />
                  <ScenarioCompareCard
                    label="Adjusted daily target"
                    current={scenario.current.adjustedDailyTarget}
                    hypothetical={scenario.hypothetical.adjustedDailyTarget}
                    emphasis
                  />
                </div>
              </div>

              <div className="mt-4 space-y-2 border-t border-edge-accent/50 pt-3 text-xs leading-relaxed text-ink-600">
                <p>
                  Daily needed target in this scenario:{" "}
                  <span className="figure font-semibold text-ink-900">
                    {formatMoney(scenario.hypothetical.dailyNeededTarget)}
                  </span>
                  . For comparison, your current (real, saved) daily needed
                  target is{" "}
                  <span className="figure font-semibold text-ink-900">
                    {formatMoney(scenario.current.dailyNeededTarget)}
                  </span>{" "}
                  and remains unchanged in this scenario.
                </p>
                {/* §9.9: always null right now — say so plainly rather than
                    silently omitting a figure the plan otherwise promises. */}
                <p className="flex items-start gap-1.5">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-500" />
                  <span>
                    <b className="font-semibold text-ink-700">
                      Estimated transactions per day:
                    </b>{" "}
                    Not available. FinSight can't yet tell whether your sales
                    records represent individual transactions or daily totals,
                    so it won't guess a transaction count.
                  </span>
                </p>
              </div>

              {/* Secondary — plan §10.7: "clearly optional/secondary".
                  Persists the assumed value above as a separate, owner-visible
                  RecoveryPlan; never touches the real business profile. */}
              <div className="mt-4 border-t border-edge-accent/50 pt-4">
                {!showSavePlanForm ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowSavePlanForm(true)}
                  >
                    <BookmarkPlus aria-hidden className="size-4" />
                    Save this as a plan
                    {hasSavedPlan
                      ? " (replaces your current one for this month)"
                      : ""}
                  </Button>
                ) : (
                  <form onSubmit={handleSavePlan} className="space-y-3">
                    <p className="text-xs text-ink-600">
                      Saves the assumed monthly expense basis above (
                      {formatMoney(scenario.assumedExpectedMonthlyExpenses)}) as
                      this month's target amount for your own reference.
                      Optionally add a deadline and a buffer percentage. This
                      never changes your business profile or recorded sales.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Deadline"
                        htmlFor="scenario-plan-deadline"
                        optional
                      >
                        <TextInput
                          id="scenario-plan-deadline"
                          type="date"
                          value={planDeadline}
                          onChange={(e) => setPlanDeadline(e.target.value)}
                        />
                      </Field>
                      <Field
                        label="Buffer"
                        htmlFor="scenario-plan-buffer"
                        optional
                        hint="A percentage, for your own reference."
                      >
                        <div className="relative">
                          <TextInput
                            id="scenario-plan-buffer"
                            type="number"
                            min={0}
                            step={1}
                            value={planBufferPercent}
                            onChange={(e) =>
                              setPlanBufferPercent(e.target.value)
                            }
                            className="pr-8"
                          />
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-600">
                            %
                          </span>
                        </div>
                      </Field>
                    </div>
                    {planSaveError ? (
                      <FormError>{planSaveError}</FormError>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowSavePlanForm(false)}
                        disabled={savingPlan}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        disabled={savingPlan}
                      >
                        {savingPlan ? "Saving…" : "Save plan"}
                      </Button>
                    </div>
                  </form>
                )}
                {planSaveConfirmation ? (
                  <p className="mt-2 text-xs font-medium text-tone-brand">
                    Saved. Your profile and sales are unchanged.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

type HeroTone = "setup" | "info" | "good" | "critical";

const HERO_TONE_SOLID: Record<HeroTone, string> = {
  setup: STATUS_TEXT_COLORS.warning,
  info: "#149e8d",
  good: STATUS_TEXT_COLORS.good,
  critical: STATUS_TEXT_COLORS.critical,
};

const HERO_TONE_FILL: Record<HeroTone, string> = {
  setup: STATUS_COLORS.warning,
  info: "#2ec2ac",
  good: STATUS_COLORS.good,
  critical: STATUS_COLORS.critical,
};

function periodHeroState(period: RecoveryReportingPeriod): {
  tone: HeroTone;
  label: string;
  icon: typeof Check;
} {
  const label = recoveryPeriodStatusLabel(period);
  switch (period.status) {
    case "needs_setup":
      return { tone: "setup", label, icon: CircleHelp };
    case "no_data":
      return { tone: "info", label, icon: Info };
    case "behind":
      return { tone: "critical", label, icon: AlertTriangle };
    default:
      return { tone: "good", label, icon: Check };
  }
}

/**
 * The page's focal point: where the period stands and the one number that
 * says what to do next. On a fixed deep-teal gradient (brand colours do not
 * change between themes) so it reads as the headline above every panel.
 * The amber figure is the Recovery Meter's sanctioned accent moment.
 */
function RecoveryHero({
  title,
  period,
  currentMonthStatus,
}: {
  title: string;
  period: RecoveryReportingPeriod;
  /** Present only for the current month, where the meter's own status copy applies. */
  currentMonthStatus: RecoveryStatus | undefined | null;
}) {
  const state =
    currentMonthStatus !== null
      ? monthToneAndCopy(
          currentMonthStatus,
          period.status === "ahead" ||
            period.status === "on_pace" ||
            period.status === "covered",
          period.status === "needs_setup",
        )
      : periodHeroState(period);
  const StatusIcon = state.icon;
  const coverage = Math.min(Math.max(period.coveragePercent, 0), 100);
  const isCurrentMonth = currentMonthStatus !== null;
  const showDailyAsk =
    !period.isComplete &&
    period.status !== "needs_setup" &&
    period.adjustedDailyTarget !== null &&
    period.remainingTarget > 0;

  return (
    <section
      aria-labelledby="recovery-hero-title"
      className="relative flex min-w-0 flex-col overflow-hidden rounded-2xl bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950 p-5 text-white shadow-md sm:p-6"
    >
      <svg
        aria-hidden
        viewBox="0 0 200 200"
        className="pointer-events-none absolute -right-14 -top-14 h-56 w-56 text-white/[0.06]"
      >
        <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeWidth="14" />
        <circle cx="100" cy="100" r="58" fill="none" stroke="currentColor" strokeWidth="14" />
        <circle cx="100" cy="100" r="22" fill="currentColor" />
      </svg>

      <div className="relative flex items-start gap-4">
        <IconTile icon={Target} size="lg" className="hidden sm:inline-flex" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2
              id="recovery-hero-title"
              className="font-display text-lg font-semibold tracking-[-0.01em]"
            >
              {title}
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 py-1 pl-1 pr-2.5 text-xs font-semibold ring-1 ring-white/15">
              <span
                aria-hidden
                className="inline-flex h-4 w-4 items-center justify-center rounded-full"
                style={{ backgroundColor: HERO_TONE_SOLID[state.tone] }}
              >
                <StatusIcon className="size-2.5" />
              </span>
              {state.label}
            </span>
          </div>

          {period.status === "needs_setup" ? (
            <p className="mt-4 max-w-md text-sm text-brand-100">
              Add a starting monthly expense estimate to calculate your target.
            </p>
          ) : showDailyAsk ? (
            <>
              <p className="mt-4 text-xs font-medium text-brand-200">
                Adjusted daily target
              </p>
              <p className="figure mt-0.5 text-3xl font-semibold text-accent-200 sm:text-4xl">
                {formatMoney(period.adjustedDailyTarget!)}
              </p>
              <p className="mt-1 max-w-md text-sm text-brand-100">
                needed on each of the next{" "}
                {formatOperatingDays(
                  period.remainingOperatingDays,
                  period.operatingDaysIsApproximated,
                )}{" "}
                operating days to cover the{" "}
                <span className="figure">{formatMoney(period.target)}</span> target.
              </p>
            </>
          ) : (
            <>
              <p className="mt-4 text-xs font-medium text-brand-200">
                Sales reference {recoveryPeriodPhrase(period)}
              </p>
              <p className="figure mt-0.5 text-3xl font-semibold text-accent-200 sm:text-4xl">
                {formatMoney(period.sales)}
              </p>
              <p className="mt-1 text-sm text-brand-100">
                recorded against a{" "}
                <span className="figure">{formatMoney(period.target)}</span> target.
              </p>
            </>
          )}
        </div>
      </div>

      {!period.isComplete && period.status !== "needs_setup" ? (
        <dl className="relative mt-6 grid grid-cols-3 divide-x divide-white/10 rounded-xl bg-white/[0.06] py-3 ring-1 ring-white/10">
          {[
            { label: "Recorded", value: formatMoney(period.sales) },
            { label: "Still needed", value: formatMoney(period.remainingTarget) },
            {
              label: "Days left",
              value: formatOperatingDays(
                period.remainingOperatingDays,
                period.operatingDaysIsApproximated,
              ),
            },
          ].map((item) => (
            <div key={item.label} className="min-w-0 px-3 sm:px-4">
              <dt className="text-[11px] font-medium text-brand-200">{item.label}</dt>
              <dd className="figure mt-0.5 truncate text-sm font-semibold text-white sm:text-base">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="relative mt-auto pt-6">
        <div
          className="h-2.5 w-full overflow-hidden rounded-full bg-white/15"
          role="progressbar"
          aria-valuenow={Math.round(coverage)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            isCurrentMonth
              ? "Month-to-date coverage of monthly expense basis"
              : `${recoveryPeriodLabel(period)} sales coverage of the recovery target`
          }
        >
          <div
            className="h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
            style={{
              width: `${coverage}%`,
              backgroundColor: HERO_TONE_FILL[state.tone],
            }}
          />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 text-xs text-brand-100">
          <span>
            <span className="figure font-semibold text-white">
              {formatMoney(period.sales)}
            </span>{" "}
            of <span className="figure">{formatMoney(period.target)}</span> recorded
          </span>
          <span className="figure font-semibold text-white">
            {period.coveragePercent.toFixed(0)}%
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Recorded sales against what the plan expected by now, as two bars on one
 * scale. The gap between them is the whole story of "behind pace", so it is
 * drawn rather than left as two figures to subtract.
 */
function PaceComparison({
  recorded,
  expected,
}: {
  recorded: number;
  expected: number;
}) {
  const max = Math.max(recorded, expected, 1);
  const behind = recorded < expected;
  const rows = [
    {
      label: "Recorded",
      value: recorded,
      fill: behind ? STATUS_COLORS.critical : STATUS_COLORS.good,
    },
    { label: "Expected by now", value: expected, fill: "rgb(var(--ink-300))" },
  ];
  return (
    <dl className="space-y-2">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex items-baseline justify-between gap-3 text-[11px]">
            <dt className="text-ink-500">{row.label}</dt>
            <dd className="figure font-semibold text-ink-800">{formatMoney(row.value)}</dd>
          </div>
          <div aria-hidden className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-paper-200">
            <div
              className="h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
              style={{
                width: `${row.value > 0 ? Math.max((row.value / max) * 100, 2) : 0}%`,
                backgroundColor: row.fill,
              }}
            />
          </div>
        </div>
      ))}
    </dl>
  );
}

/** The figures behind the hero, plus the state's one primary action. */
function RecoveryPaceCard({
  period,
  action,
}: {
  period: RecoveryReportingPeriod;
  action: ReactNode;
}) {
  const variance = period.isComplete
    ? period.sales - period.target
    : period.paceVarianceAmount;
  return (
    <Card className="flex min-w-0 flex-col p-5 motion-safe:animate-fade-up">
      <div className="flex items-start gap-3.5">
        <IconTile icon={CalendarRange} />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-600">
            Target for{" "}
            {period.kind === "week" ? "this week" : recoveryPeriodLabel(period)}
          </p>
          <p className="figure mt-1 text-2xl font-semibold leading-none text-ink-900">
            {formatMoney(period.target)}
          </p>
          <p className="mt-1.5 text-xs text-ink-500">
            <span className="figure">{formatMoney(period.dailyTarget)}</span> per
            operating day
          </p>
        </div>
      </div>
      <div className="my-4 border-t border-dashed border-paper-200" />
      <div className="flex items-start gap-3.5">
        <IconTile icon={Flag} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink-600">
            {period.isComplete ? "Final difference" : "Against expected pace"}
          </p>
          <p
            className="figure mt-1 text-2xl font-semibold leading-none"
            style={{
              color:
                variance < 0
                  ? STATUS_INK.critical
                  : variance > 0
                    ? STATUS_INK.good
                    : undefined,
            }}
          >
            {variance === 0
              ? "On pace"
              : `${formatMoney(Math.abs(variance))} ${
                  period.isComplete
                    ? variance < 0
                      ? "short"
                      : "over"
                    : variance < 0
                      ? "behind"
                      : "ahead"
                }`}
          </p>
          <p className="mt-1.5 text-xs text-ink-500">
            {period.isComplete
              ? `${recoveryPeriodLabel(period)} is closed`
              : `${formatOperatingDays(
                  period.remainingOperatingDays,
                  period.operatingDaysIsApproximated,
                )} operating days left`}
          </p>
          {!period.isComplete && period.expectedSalesToDate > 0 ? (
            <div className="mt-3">
              <PaceComparison
                recorded={period.sales}
                expected={period.expectedSalesToDate}
              />
            </div>
          ) : null}
        </div>
      </div>
      {action ? (
        <div className="mt-auto pt-5">
          <div className="border-t border-paper-200 pt-4">{action}</div>
        </div>
      ) : null}
    </Card>
  );
}

// Each tone is a matched set from the themed tint/tone/edge tokens, used for
// the tile's wash only; the icon itself is the shared, uniform IconTile.
const INPUT_TILE_TONES = {
  brand: {
    wash: "from-tint-brand",
    ring: "ring-edge-brand",
    mark: "text-tone-brand",
  },
  info: {
    wash: "from-tint-info",
    ring: "ring-edge-info",
    mark: "text-tone-info",
  },
  danger: {
    wash: "from-tint-danger",
    ring: "ring-edge-danger",
    mark: "text-tone-danger",
  },
  neutral: {
    wash: "from-tint-neutral",
    ring: "ring-paper-200",
    mark: "text-tone-neutral",
  },
} as const;

/**
 * One input to the target. Each tile carries a small picture of its own
 * figure (elapsed days, the target's drift, today's progress) so the row
 * says something at a glance instead of being four boxed numbers. The faint
 * oversized glyph repeats the tile's icon to give each tile its own
 * silhouette; it is decoration only, so it sits behind the text, aria-hidden.
 */
function InputTile({
  icon: Icon,
  label,
  value,
  sublabel,
  tone,
  visual,
  order = 0,
}: {
  icon: typeof Check;
  label: string;
  value: string;
  sublabel?: ReactNode;
  tone: keyof typeof INPUT_TILE_TONES;
  visual?: ReactNode;
  /** Position in the row, used to stagger the entrance in reading order. */
  order?: number;
}) {
  const t = INPUT_TILE_TONES[tone];
  return (
    <div
      className={`relative isolate flex min-w-0 flex-col overflow-hidden rounded-2xl bg-gradient-to-br ${t.wash} to-paper p-4 shadow-sm ring-1 ${t.ring} motion-safe:animate-fade-up sm:p-5`}
      style={{ animationDelay: `${order * 70}ms` }}
    >
      <Icon
        aria-hidden
        className={`pointer-events-none absolute -bottom-6 -right-6 -z-10 size-32 -rotate-12 opacity-[0.07] ${t.mark}`}
      />
      <div className="flex items-center gap-3">
        <IconTile icon={Icon} />
        <p className="min-w-0 text-xs font-semibold text-ink-700">{label}</p>
      </div>
      <p className="figure mt-4 break-words text-[1.7rem] font-semibold leading-none text-ink-900">
        {value}
      </p>
      {sublabel ? <p className="mt-2 text-xs text-ink-600">{sublabel}</p> : null}
      {visual ? <div className="mt-auto pt-4">{visual}</div> : null}
    </div>
  );
}

/** One dot per operating day in the period: filled for elapsed, hollow for left. */
function OperatingDayDots({
  total,
  elapsed,
  approximated,
}: {
  total: number;
  elapsed: number;
  approximated: boolean;
}) {
  const count = Math.max(0, Math.min(Math.round(total), 31));
  const done = Math.max(0, Math.min(Math.round(elapsed), count));
  if (count === 0) return null;
  const left = count - done;
  return (
    <div>
      <div
        role="img"
        aria-label={`${done} of ${count} operating days elapsed${approximated ? " (estimated)" : ""}`}
        className="flex flex-wrap gap-[3px]"
      >
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={`h-2 w-2 rounded-full ${
              i < done ? "bg-tone-info" : "bg-paper ring-1 ring-inset ring-edge-info"
            }`}
          />
        ))}
      </div>
      <p aria-hidden className="mt-1.5 text-[11px] font-medium text-tone-info">
        {done} elapsed, {left} left
      </p>
    </div>
  );
}

/** How far the per-day ask has moved from the plan, now that some days are gone. */
function DailyTargetDrift({
  dailyTarget,
  adjusted,
}: {
  dailyTarget: number;
  adjusted: number;
}) {
  const percent = dailyTarget > 0 ? ((adjusted - dailyTarget) / dailyTarget) * 100 : 0;
  const up = adjusted > dailyTarget;
  const Arrow = up ? ArrowUp : adjusted < dailyTarget ? ArrowDown : Minus;
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-paper/80 px-3 py-2 ring-1 ring-edge-brand">
      <span className="text-[11px] text-ink-600">
        Now{" "}
        <span className="figure font-semibold text-ink-900">{formatMoney(adjusted)}</span>{" "}
        a day
      </span>
      {Math.abs(percent) >= 0.5 ? (
        <span
          className={`figure inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
            up ? "bg-tint-danger text-tone-danger" : "bg-tint-brand text-tone-brand"
          }`}
        >
          <Arrow aria-hidden className="size-3" />
          {up ? "+" : "−"}
          {Math.abs(percent).toFixed(0)}%
        </span>
      ) : null}
    </div>
  );
}

/** A thin labelled bar for today's progress inside the status tile. */
function TileProgress({ percent, tone }: { percent: number; tone: "danger" | "brand" }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <div
      aria-hidden
      className={`h-2 w-full overflow-hidden rounded-full ${
        tone === "danger" ? "bg-edge-danger" : "bg-edge-brand"
      }`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${
          tone === "danger" ? "bg-tone-danger" : "bg-tone-brand"
        }`}
        style={{ width: `${Math.max(clamped, clamped > 0 ? 4 : 0)}%` }}
      />
    </div>
  );
}

/** Today's sales reference against today's target (current month only). */
function TodayProgressCard({ data }: { data: RecoveryInsight }) {
  const percent =
    data.todaysTarget > 0
      ? (data.todaysSales / data.todaysTarget) * 100
      : data.todaysSales > 0
        ? 100
        : 0;
  const ringColor =
    data.todaysStatus === "below"
      ? STATUS_COLORS.critical
      : STATUS_COLORS.good;
  return (
    <Panel title="Today" className="h-full">
      <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row">
        <ProgressRing
          percent={percent}
          color={ringColor}
          label={`${Math.round(percent)}% of today's target recorded`}
        />
        <dl className="grid w-full min-w-0 gap-2.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-ink-500">Sales reference today</dt>
            <dd className="figure font-semibold text-ink-900">
              {formatMoney(data.todaysSales)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-ink-500">Today's target</dt>
            <dd className="figure font-semibold text-ink-900">
              {formatMoney(data.todaysTarget)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t border-paper-200 pt-2.5">
            <dt className="text-xs text-ink-500">Today's gap</dt>
            <dd
              className="figure font-semibold"
              style={{ color: statusColor(data.todaysStatus) }}
            >
              {data.todaysStatus === "at"
                ? "Reached"
                : `${formatMoney(Math.abs(data.todaysGap))} ${data.todaysStatus}`}
            </dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

/**
 * Plain facts read straight off the daily rows and checkpoints. Nothing is
 * inferred or predicted here, so nothing needs an AI disclaimer.
 */
function RecoveryHighlights({ rows }: { rows: DailyCoverageRow[] }) {
  const openRows = rows.filter((r) => r.status !== "closed");
  const hitRows = openRows.filter((r) => r.status === "at" || r.status === "above");
  const best = rows.reduce<DailyCoverageRow | null>(
    (top, r) => (r.sales > 0 && (!top || r.sales > top.sales) ? r : top),
    null,
  );
  const closedCount = rows.length - openRows.length;

  const items: { icon: typeof Check; title: string; body: ReactNode }[] = [];
  if (openRows.length > 0) {
    items.push({
      icon: CalendarCheck,
      title: "Open days on target",
      body: `${hitRows.length} of ${openRows.length} open ${openRows.length === 1 ? "day" : "days"} so far reached the allocated target.`,
    });
  }
  if (best) {
    items.push({
      icon: TrendingUp,
      title: "Highest sales day",
      body: (
        <>
          {shortDay(best.date)}, with{" "}
          <span className="figure font-semibold text-ink-700">{formatMoney(best.sales)}</span>{" "}
          recorded.
        </>
      ),
    });
  }
  if (closedCount > 0) {
    items.push({
      icon: CalendarOff,
      title: "Closed days",
      body: `${closedCount} ${closedCount === 1 ? "day was" : "days were"} closed on your schedule and carry no target.`,
    });
  }

  return (
    <Panel title="Highlights" eyebrow="From your daily records" className="h-full">
      {items.length === 0 ? (
        <p className="text-sm text-ink-500">
          Highlights appear once this period has recorded days.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map(({ icon: Icon, title, body }) => (
            <li
              key={title}
              className="flex items-start gap-3 rounded-xl border border-paper-200 bg-paper-50 p-3"
            >
              <IconTile icon={Icon} size="sm" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-900">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-600">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** One figure in the daily-plan strip. */
function PlanFigure({
  label,
  value,
  sublabel,
  emphasis = false,
}: {
  label: string;
  value: string;
  sublabel?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl p-3.5 ${
        emphasis ? "bg-tint-brand ring-1 ring-edge-brand" : ""
      }`}
    >
      <p className={`text-xs font-medium ${emphasis ? "text-tone-brand" : "text-ink-500"}`}>
        {label}
      </p>
      <p className="figure mt-1 break-words text-lg font-semibold text-ink-900">
        {value}
      </p>
      {sublabel ? <p className="mt-0.5 text-xs text-ink-500">{sublabel}</p> : null}
    </div>
  );
}

export function RecoveryInsightPage() {
  return (
    <ReportingPeriodScope scope="recovery-target">
      <RecoveryInsightContent />
    </ReportingPeriodScope>
  );
}

function RecoveryInsightContent() {
  const { selected } = useBusinessProfiles();
  const {
    selection: sharedSelection,
    setSelection,
    ready: periodReady,
  } = useReportingPeriod();
  const selection: PeriodSelection =
    sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  const selectionKey = periodKey(selection);
  const recoveryScopeKey = JSON.stringify({
    businessProfileId: selected?.id ?? null,
    period: selection,
    periodReady,
  });
  const activeRecoveryScopeRef = useRef(recoveryScopeKey);
  activeRecoveryScopeRef.current = recoveryScopeKey;

  useEffect(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [setSelection, sharedSelection]);

  const [recoveryResult, setRecoveryResult] = useState<{
    scopeKey: string | null;
    data: RecoveryInsight | null;
    updatedAt: number | null;
  }>({ scopeKey: null, data: null, updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [errorResult, setErrorResult] = useState<{
    scopeKey: string | null;
    message: string | null;
  }>({ scopeKey: null, message: null });
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the "expand on this" link below hands one through to
  // be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Recovery Target");
  // Guards against a slow response for a since-abandoned profile landing
  // after a newer one — without it, switching profiles quickly can let an
  // in-flight request for the PREVIOUS profile overwrite the current one's
  // freshly-loaded data.
  const requestId = useRef(0);
  const ownsRecoveryResult = recoveryResult.scopeKey === recoveryScopeKey;
  const data = ownsRecoveryResult ? recoveryResult.data : null;
  const dailyCoverageDisclosure = useListDisclosure({
    total: data?.dailyCoverage.length ?? 0,
    resetKey: recoveryScopeKey,
  });
  const dailyCoverageRows = data?.dailyCoverage ?? [];
  const visibleDailyCoverage = dailyCoverageDisclosure.expanded
    ? dailyCoverageRows
    : [...dailyCoverageRows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, dailyCoverageDisclosure.visibleCount);
  const dataUpdatedAt = ownsRecoveryResult ? recoveryResult.updatedAt : null;
  const recoveryLoading = ownsRecoveryResult ? loading : true;
  const error =
    errorResult.scopeKey === recoveryScopeKey ? errorResult.message : null;
  const reportingPeriod = data
    ? data.reportingPeriod ?? legacyReportingPeriod(data)
    : null;
  const isCurrentMonthView = Boolean(
    reportingPeriod?.kind === "month" && reportingPeriod.isCurrent,
  );
  const monthKey =
    reportingPeriod?.kind === "month" && reportingPeriod.month
      ? reportingPeriod.month
      : null;
  const planScopeKey =
    selected && isCurrentMonthView && monthKey
      ? `${selected.id}:${monthKey}`
      : null;
  const [planResult, setPlanResult] = useState<{
    scopeKey: string | null;
    plan: RecoveryPlan | null;
    state: "loading" | "ready" | "stale" | "unavailable";
    updatedAt: number | null;
  }>({ scopeKey: null, plan: null, state: "ready", updatedAt: null });
  const [planLoading, setPlanLoading] = useState(false);
  const planRequestId = useRef(0);
  const ownsPlanResult = planScopeKey !== null && planResult.scopeKey === planScopeKey;
  const plan = ownsPlanResult ? planResult.plan : null;
  const planState = ownsPlanResult ? planResult.state : "ready";
  const planUpdatedAt = ownsPlanResult ? planResult.updatedAt : null;

  async function loadPlan(
    businessProfileId: number,
    planMonth: string,
    signal?: AbortSignal,
    force = false,
  ) {
    const thisPlanRequestId = ++planRequestId.current;
    const requestPlanScopeKey = `${businessProfileId}:${planMonth}`;
    const url = `/business-profiles/${businessProfileId}/recovery-plans`;
    const params = { month: planMonth };
    const scope = {
      businessProfileId,
      period: { month: planMonth },
      tags: ["recovery-plan", "financial"],
    };
    const cached = peekCachedApiData<RecoveryPlan[]>(url, { params }, scope);
    const retainedPlan = cached?.data[0] ?? (
      planResult.scopeKey === requestPlanScopeKey ? planResult.plan : null
    );
    const retainedUpdatedAt = cached?.updatedAt ?? (
      planResult.scopeKey === requestPlanScopeKey ? planResult.updatedAt : null
    );

    setPlanLoading(!cached || cached.stale || force);
    if (cached) {
      setPlanResult({
        scopeKey: requestPlanScopeKey,
        plan: cached.data[0] ?? null,
        state: "ready",
        updatedAt: cached.updatedAt,
      });
    } else if (!force) {
      setPlanResult({ scopeKey: requestPlanScopeKey, plan: null, state: "loading", updatedAt: null });
    }
    try {
      const { data } = await cachedApiGet<RecoveryPlan[]>(
        url,
        { signal, params },
        scope,
        { force },
      );
      if (
        signal?.aborted ||
        thisPlanRequestId !== planRequestId.current ||
        planScopeKey !== requestPlanScopeKey
      ) return;
      const snapshot = peekCachedApiData<RecoveryPlan[]>(url, { params }, scope);
      setPlanResult({
        scopeKey: requestPlanScopeKey,
        plan: data[0] ?? null,
        state: "ready",
        updatedAt: snapshot?.updatedAt ?? Date.now(),
      });
    } catch {
      if (
        signal?.aborted ||
        thisPlanRequestId !== planRequestId.current ||
        planScopeKey !== requestPlanScopeKey
      ) return;
      setPlanResult({
        scopeKey: requestPlanScopeKey,
        plan: retainedPlan,
        state: cached || retainedUpdatedAt !== null ? "stale" : "unavailable",
        updatedAt: retainedUpdatedAt,
      });
    } finally {
      if (!signal?.aborted && thisPlanRequestId === planRequestId.current) setPlanLoading(false);
    }
  }

  function applyPlanChange(nextPlan: RecoveryPlan | null) {
    if (!planScopeKey) return;
    setPlanResult({
      scopeKey: planScopeKey,
      plan: nextPlan,
      state: "ready",
      updatedAt: Date.now(),
    });
  }

  async function load(signal?: AbortSignal, force = false) {
    const requestScopeKey = recoveryScopeKey;
    if (activeRecoveryScopeRef.current !== requestScopeKey) return;
    const thisRequestId = ++requestId.current;
    /*
     * No business — an owner who chose "Skip for now". Settles rather than
     * bails: `loading` starts true and `isInitialLoad` is `loading && !data`,
     * so returning silently pinned this page to its skeleton for good.
    */
    if (!selected) {
      setRecoveryResult({ scopeKey: requestScopeKey, data: null, updatedAt: null });
      setErrorResult({ scopeKey: requestScopeKey, message: null });
      setLoading(false);
      return;
    }
    if (!periodReady) {
      setRecoveryResult({ scopeKey: requestScopeKey, data: null, updatedAt: null });
      setErrorResult({ scopeKey: requestScopeKey, message: null });
      setLoading(true);
      return;
    }
    const businessProfileId = selected.id;
    const params = {
      businessProfileId,
      coverageDays: 31,
      ...periodParams(selection),
    };
    const scope = {
      businessProfileId,
      period: selection,
      tags: ["recovery", "financial"],
    };
    const cached = peekCachedApiData<RecoveryInsight>(
      "/insights/recovery",
      { params },
      scope,
    );

    setLoading(!cached || cached.stale || force);
    setErrorResult({ scopeKey: requestScopeKey, message: null });
    if (cached) {
      setRecoveryResult({
        scopeKey: requestScopeKey,
        data: cached.data,
        updatedAt: cached.updatedAt,
      });
    } else if (!force) {
      setRecoveryResult({ scopeKey: requestScopeKey, data: null, updatedAt: null });
    }
    try {
      const { data: nextData } = await cachedApiGet<RecoveryInsight>(
        "/insights/recovery",
        {
          signal,
          // The server bounds this to the selected interval through its as-of
          // date. Asking for the 31-day ceiling keeps every calendar month
          // available to the daily table without hiding older rows.
          params,
        },
        scope,
        { force },
      );
      if (
        signal?.aborted ||
        thisRequestId !== requestId.current ||
        activeRecoveryScopeRef.current !== requestScopeKey
      ) return;
      const snapshot = peekCachedApiData<RecoveryInsight>(
        "/insights/recovery",
        { params },
        scope,
      );
      setRecoveryResult({
        scopeKey: requestScopeKey,
        data: nextData,
        updatedAt: snapshot?.updatedAt ?? Date.now(),
      });
    } catch (err) {
      if (
        signal?.aborted ||
        (err as { name?: string })?.name === "AbortError" ||
        thisRequestId !== requestId.current ||
        activeRecoveryScopeRef.current !== requestScopeKey
      ) return;
      setErrorResult({
        scopeKey: requestScopeKey,
        message: getErrorMessage(err),
      });
    } finally {
      if (
        !signal?.aborted &&
        thisRequestId === requestId.current &&
        activeRecoveryScopeRef.current === requestScopeKey
      ) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selectionKey, periodReady]);

  useEffect(() => {
    const controller = new AbortController();
    if (selected && planScopeKey && monthKey) {
      void loadPlan(selected.id, monthKey, controller.signal);
    } else {
      planRequestId.current += 1;
      setPlanResult({
        scopeKey: null,
        plan: null,
        state: "ready",
        updatedAt: null,
      });
      setPlanLoading(false);
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planScopeKey]);

  const isInitialLoad = recoveryLoading && !data;
  const isRefreshing = recoveryLoading && data !== null;

  const currentMonthMeterData =
    data && reportingPeriod && isCurrentMonthView
      ? {
          ...data,
          expectedMonthlyExpenses: reportingPeriod.target,
          operatingDays: reportingPeriod.operatingDays,
          dailyNeededTarget: reportingPeriod.dailyTarget,
          salesThisMonth: reportingPeriod.sales,
          remainingTarget: reportingPeriod.remainingTarget,
          remainingOperatingDays: Number(
            formatOperatingDayNumber(
              reportingPeriod.remainingOperatingDays,
              reportingPeriod.operatingDaysIsApproximated,
            ),
          ),
          remainingOperatingDaysIsApproximated:
            reportingPeriod.operatingDaysIsApproximated,
          adjustedDailyTarget:
            reportingPeriod.adjustedDailyTarget ?? data.adjustedDailyTarget,
          monthCoveragePercent: reportingPeriod.coveragePercent,
          onTrack:
            reportingPeriod.status === "ahead" ||
            reportingPeriod.status === "on_pace" ||
            reportingPeriod.status === "covered",
          status:
            data.reportingPeriod
              ? reportingPeriod.status === "no_data"
                ? ("no_current_month_data" as const)
                : reportingPeriod.status
              : data.status,
        }
      : null;
  const inputAsOfDate = data?.reportingPeriod?.asOfDate ?? data?.asOfDate;
  const inputTimezone = data?.reportingPeriod?.timezone ?? data?.timezone;

  // Names the exact gap and target the card below just described, rather
  // than a generic "how much more sales do I need?".
  const expandQuestion = reportingPeriod
    ? `Why are my recorded sales ${formatMoney(Math.abs(reportingPeriod.paceVarianceAmount))} ${
        reportingPeriod.paceVarianceAmount < 0
          ? "behind"
          : reportingPeriod.paceVarianceAmount > 0
            ? "ahead of"
            : "on"
      } pace ${recoveryPeriodPhrase(reportingPeriod)}, and what should I review?`
    : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Recovery target"
        subtitle={selected ? selected.name : undefined}
        actions={<PeriodFilter showAllTime={false} />}
      />

      <InsightsTabs />

      <PageTip id="recovery-target" title="What the recovery target is">
        It is the sales you need this month to cover your expected monthly expenses. FinSight spreads what is left
        over your remaining operating days, so the daily target changes as you record sales.
      </PageTip>

      {error && !data ? (
        <div className="mb-5">
          <Callout tone="warn">
            <b className="font-semibold">Couldn't load your recovery target.</b>{" "}
            {error}
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void load(undefined, true)}
                disabled={recoveryLoading}
              >
                {recoveryLoading ? "Retrying…" : "Retry"}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}
      {error && data ? (
        <div className="mb-4">
          <Callout tone="warn">
            <b className="font-semibold">Showing the last successful result.</b>{" "}
            Refreshing failed: {error}
            {dataUpdatedAt ? (
              <> Last updated at {new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}.</>
            ) : null}
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void load(undefined, true)}
              >
                Retry
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {isInitialLoad ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading your recovery target…</span>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <SkeletonPanel lines={4} />
            <SkeletonPanel lines={4} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SkeletonPanel lines={6} />
            </div>
            <SkeletonPanel lines={6} />
          </div>
          <Card>
            <SkeletonRows rows={5} />
          </Card>
        </div>
      ) : !selected ? (
        /* A recovery target needs a selected business and its monthly basis. */
        <EmptyState
          image="/mascot/04-empty-states/nosalesrecords.webp"
          title="No recovery target yet"
          action={
            <ButtonLink to="/onboarding" variant="primary">
              Finish business setup
            </ButtonLink>
          }
        >
          Set up your business to track your sales target.
        </EmptyState>
      ) : data && reportingPeriod ? (
        <div
          className={`space-y-6 transition-opacity duration-200 ${isRefreshing ? "opacity-60" : ""}`}
          aria-busy={isRefreshing}
        >
          {isRefreshing ? (
            <span className="sr-only">Refreshing your recovery target…</span>
          ) : null}

          <RecoverySectionNav
            showCheckpoints={Boolean(
              reportingPeriod.kind === "month" &&
                data.weeklyCheckpoints?.length,
            )}
            showDailyPlan={!reportingPeriod.isComplete}
            showPlanning={isCurrentMonthView}
            hasSavedPlan={plan !== null}
          />

          <div
            id="recovery-overview"
            className="grid scroll-mt-6 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
          >
            <RecoveryHero
              title={
                isCurrentMonthView
                  ? "Month-to-date pace"
                  : reportingPeriod.kind === "week"
                    ? "This week's pace"
                    : `${recoveryPeriodLabel(reportingPeriod)} result`
              }
              period={reportingPeriod}
              currentMonthStatus={
                currentMonthMeterData ? currentMonthMeterData.status : null
              }
            />
            <RecoveryPaceCard
              period={reportingPeriod}
              action={
                isCurrentMonthView ? (
                  <RecoveryPrimaryAction
                    status={currentMonthMeterData?.status}
                    businessProfileId={selected.id}
                  />
                ) : null
              }
            />
          </div>

          <section aria-labelledby="recovery-inputs-title">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2
                id="recovery-inputs-title"
                className="text-base font-semibold text-ink-900"
              >
                Inputs
              </h2>
              <span className="text-xs text-ink-500">
                {inputAsOfDate
                  ? `As of ${new Date(inputAsOfDate).toLocaleDateString(
                      undefined,
                      {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      },
                    )}${inputTimezone ? `, ${inputTimezone} time` : ""}`
                  : "Today"}
              </span>
            </div>
            <div
              className={`grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 ${
                isCurrentMonthView ? "xl:grid-cols-4" : "xl:grid-cols-3"
              }`}
            >
              <InputTile
                icon={Wallet}
                tone="neutral"
                label={
                  reportingPeriod.kind === "month"
                    ? "Monthly expense basis"
                    : "This week's target"
                }
                value={formatMoney(reportingPeriod.target)}
                sublabel={reportingPeriodBasisSource(data, reportingPeriod)}
              />
              <InputTile
                order={1}
                visual={
                  <OperatingDayDots
                    total={reportingPeriod.operatingDays}
                    elapsed={reportingPeriod.elapsedOperatingDays}
                    approximated={reportingPeriod.operatingDaysIsApproximated}
                  />
                }
                icon={CalendarDays}
                tone="info"
                label={
                  reportingPeriod.kind === "month"
                    ? "Operating days / month"
                    : "Operating days this week"
                }
                value={formatOperatingDays(
                  reportingPeriod.operatingDays,
                  reportingPeriod.operatingDaysIsApproximated,
                )}
                sublabel={
                  reportingPeriod.operatingScheduleConfigured
                    ? "From your operating schedule"
                    : reportingPeriod.kind === "week"
                      ? "Estimated for this week from your business profile"
                      : "Estimated from your business profile"
                }
              />
              <InputTile
                icon={Target}
                tone="brand"
                label={
                  reportingPeriod.operatingDaysIsApproximated
                    ? "Open-day target"
                    : "Daily needed target"
                }
                value={formatMoney(reportingPeriod.dailyTarget)}
                sublabel="Computed from the two figures beside it"
                order={2}
                visual={
                  !reportingPeriod.isComplete &&
                  reportingPeriod.adjustedDailyTarget !== null ? (
                    <DailyTargetDrift
                      dailyTarget={reportingPeriod.dailyTarget}
                      adjusted={reportingPeriod.adjustedDailyTarget}
                    />
                  ) : undefined
                }
              />
              {isCurrentMonthView ? (
                <InputTile
                  icon={data.todaysStatus === "below" ? AlertTriangle : Check}
                  tone={data.todaysStatus === "below" ? "danger" : "brand"}
                  label="Status today"
                  order={3}
                  visual={
                    data.todaysTarget > 0 ? (
                      <TileProgress
                        percent={(data.todaysSales / data.todaysTarget) * 100}
                        tone={data.todaysStatus === "below" ? "danger" : "brand"}
                      />
                    ) : undefined
                  }
                  value={statusLabel(data.todaysStatus)}
                  sublabel={
                    data.todaysTarget > 0
                      ? `${((data.todaysSales / data.todaysTarget) * 100).toFixed(0)}% of today's target reached`
                      : undefined
                  }
                />
              ) : null}
            </div>
            <p className="mt-3 text-xs text-ink-500">
              {reportingPeriod.operatingDaysIsApproximated
                ? "Open-day target = period target ÷ estimated operating days."
                : "Daily needed target = period target ÷ operating days in the selected period."}
            </p>
            {reportingPeriod.kind === "month" && reportingPeriod.isComplete ? (
              <p className="mt-1 text-xs text-ink-500">
                Targets use your current business profile settings. Past
                versions are not stored.
              </p>
            ) : null}
          </section>

          {isCurrentMonthView ? (
            <RecoveryChangeSincePreviousDay
              change={data.changeSincePreviousDay}
            />
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel
              title="Sales vs. target"
              eyebrow={`Running totals, ${recoveryPeriodLabel(reportingPeriod)}`}
              className="min-w-0 lg:col-span-2"
            >
              <CumulativeSalesChart
                points={buildCumulativeSeries(
                  data.dailyCoverage,
                  reportingPeriod,
                  reportingPeriod.kind === "month"
                    ? data.weeklyCheckpoints ?? []
                    : [],
                )}
              />
            </Panel>
            <Panel title="Target breakdown" className="min-w-0">
              <TargetBreakdown
                sales={reportingPeriod.sales}
                target={reportingPeriod.target}
              />
            </Panel>
          </div>

          {/* `tabIndex={-1}` makes this focusable-by-script-only (not part of
              the normal tab order) so `focusSection` above can move keyboard
              focus here after the "View today's plan" anchor scrolls to it —
              WCAG 2.4.3. */}
          {!reportingPeriod.isComplete ? (
            <div
              id="remaining-recovery-target"
              tabIndex={-1}
              className="scroll-mt-6 focus:outline-none"
            >
              <Panel
                title={
                  reportingPeriod.kind === "month"
                    ? "Remaining recovery target"
                    : "Remaining weekly target"
                }
                eyebrow="Recalculated across your remaining operating days"
              >
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-5">
                  <PlanFigure
                    label={
                      reportingPeriod.kind === "month"
                        ? "Monthly expense basis"
                        : "This week's target"
                    }
                    value={formatMoney(reportingPeriod.target)}
                    sublabel={reportingPeriodBasisSource(data, reportingPeriod)}
                  />
                  <PlanFigure
                    label={
                      reportingPeriod.kind === "month"
                        ? "Sales reference so far this month"
                        : "Sales reference this week"
                    }
                    value={formatMoney(reportingPeriod.sales)}
                    sublabel="From your records"
                  />
                  <PlanFigure
                    label="Remaining target"
                    value={formatMoney(reportingPeriod.remainingTarget)}
                    sublabel="Computed from your records"
                  />
                  <PlanFigure
                    label="Remaining operating days"
                    value={formatOperatingDays(
                      reportingPeriod.remainingOperatingDays,
                      reportingPeriod.operatingDaysIsApproximated,
                    )}
                    sublabel={
                      reportingPeriod.operatingDaysIsApproximated
                        ? `About ${formatOperatingDayNumber(
                            reportingPeriod.elapsedOperatingDays,
                            true,
                          )} of ${formatOperatingDayNumber(
                            reportingPeriod.operatingDays,
                            true,
                          )} estimated operating days elapsed`
                        : `${formatOperatingDayNumber(
                            reportingPeriod.elapsedOperatingDays,
                            false,
                          )} of ${formatOperatingDayNumber(
                            reportingPeriod.operatingDays,
                            false,
                          )} operating days elapsed`
                    }
                  />
                  <PlanFigure
                    label="Adjusted daily target"
                    value={
                      reportingPeriod.adjustedDailyTarget === null
                        ? "Not applicable"
                        : formatMoney(reportingPeriod.adjustedDailyTarget)
                    }
                    sublabel="Remaining target ÷ remaining operating days"
                    emphasis
                  />
                </div>
                <p className="mt-3 text-xs text-ink-500">
                  Remaining target = selected-period target minus sales recorded
                  so far.
                </p>
                {reportingPeriod.operatingDaysIsApproximated ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Remaining operating days is an estimate: your profile
                    records how many days a month you operate, not which days of
                    the week, so this scales the count across the selected
                    period.{" "}
                    <Link
                      to={`/business-profiles/${selected.id}/operating-schedule`}
                      className="tap-inline inline-flex items-center gap-1.5 link"
                    >
                      Edit operating schedule
                      <ArrowRight
                        aria-hidden
                        className="size-3.5"
                      />
                    </Link>
                  </p>
                ) : reportingPeriod.operatingScheduleConfigured ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Based on your configured operating days
                    {` (${formatOperatingDayNumber(
                      reportingPeriod.operatingDays,
                      false,
                    )} in ${recoveryPeriodLabel(reportingPeriod)})`}.
                  </p>
                ) : null}
                {reportingPeriod.dataWarnings.length > 0 &&
                reportingPeriod.provisionalSales > 0 ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Includes {formatMoney(reportingPeriod.provisionalSales)}{" "}
                    pending review or flagged as a possible duplicate.
                  </p>
                ) : null}
              </Panel>
            </div>
          ) : null}

          {(() => {
            const showCheckpoints = Boolean(
              reportingPeriod.kind === "month" &&
                data.weeklyCheckpoints &&
                data.weeklyCheckpoints.length > 0,
            );
            if (!showCheckpoints && !isCurrentMonthView) return null;
            return (
              <div className="grid gap-4 lg:grid-cols-3">
                {showCheckpoints ? (
                  <div
                    id="recovery-checkpoints"
                    className={`min-w-0 scroll-mt-6 ${
                      isCurrentMonthView ? "lg:col-span-2" : "lg:col-span-3"
                    }`}
                  >
                    <RecoveryCheckpoints
                      key={recoveryScopeKey}
                      checkpoints={data.weeklyCheckpoints!}
                      todayKey={reportingPeriod.asOfDate}
                      periodName={recoveryPeriodLabel(reportingPeriod)}
                    />
                  </div>
                ) : null}
                {isCurrentMonthView ? (
                  <div
                    className={`min-w-0 ${showCheckpoints ? "" : "lg:col-span-3"}`}
                  >
                    <TodayProgressCard data={data} />
                  </div>
                ) : null}
              </div>
            );
          })()}

          {isCurrentMonthView &&
          monthKey &&
          (planState === "stale" || planState === "unavailable") ? (
            <div role="status">
              <Callout tone="warn">
                <b className="font-semibold">
                  {planState === "stale"
                    ? plan
                      ? "Showing the last loaded saved plan."
                      : "Showing the last saved-plan check."
                    : "Couldn't check for a saved plan."}
                </b>{" "}
                {planState === "stale"
                  ? `${plan ? "The latest refresh failed" : "It found no plan, but the latest refresh failed"}${
                      planUpdatedAt
                        ? `; last checked at ${new Date(planUpdatedAt).toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                          })}`
                        : ""
                    }.`
                  : "Your recovery target is still available, but saved-plan details are temporarily unavailable."}
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void loadPlan(selected.id, monthKey, undefined, true)
                    }
                    disabled={planLoading}
                  >
                    {planLoading ? "Retrying saved plan…" : "Retry saved plan"}
                  </Button>
                </div>
              </Callout>
            </div>
          ) : null}

          {isCurrentMonthView && monthKey && plan ? (
            <div id="recovery-saved-plan" className="scroll-mt-6">
              <SavedRecoveryPlanPanel
                key={`${selected.id}-${monthKey}`}
                businessProfileId={selected.id}
                monthKey={monthKey}
                plan={plan}
                onPlanChange={applyPlanChange}
              />
            </div>
          ) : null}

          {isCurrentMonthView && monthKey ? (
            <div id="recovery-scenario" className="scroll-mt-6">
              <RecoveryScenarioPanel
                // Forces a remount on profile or planning month switch so the
                // scenario's local input and result cannot leak across scope.
                key={`${selected.id}-${monthKey}`}
                businessProfileId={selected.id}
                currentExpectedMonthlyExpenses={reportingPeriod.target}
                monthKey={monthKey}
                hasSavedPlan={plan !== null}
                onPlanSaved={applyPlanChange}
              />
            </div>
          ) : null}

          <div className="scroll-mt-6">
            <div className="mb-3 flex items-center justify-between">
              {/* `id` moved here (from the old wrapping `<div>`) so the
                  "Review month summary" anchor scrolls to, and `focusSection`
                  focuses, the heading itself rather than an unlabelled div.
                  `tabIndex={-1}`: script-focusable only, not in tab order —
                  WCAG 2.4.3. */}
              <h2
                id="daily-coverage"
                tabIndex={-1}
                className="scroll-mt-6 text-base font-semibold text-ink-900 focus:outline-none"
              >
                Daily coverage
              </h2>
              <span className="text-xs text-ink-500">
                {recoveryPeriodLabel(reportingPeriod)}
              </span>
            </div>
            <div className="mb-4 grid gap-4 lg:grid-cols-3">
              <Panel
                title="Sales by day"
                headingLevel={3}
                className="min-w-0 lg:col-span-2"
              >
                <DailySalesChart rows={data.dailyCoverage} />
              </Panel>
              <div className="min-w-0">
                <RecoveryHighlights rows={data.dailyCoverage} />
              </div>
            </div>
            <div id={dailyCoverageDisclosure.contentId}>
              <DataTable
                key={`${recoveryScopeKey}:${dailyCoverageDisclosure.expanded}`}
                rows={visibleDailyCoverage}
                columns={DAILY_COVERAGE_COLUMNS}
                getRowKey={(d) => d.date}
                caption={`Daily sales reference against target for ${selected.name}, ${recoveryPeriodPhrase(reportingPeriod)}.`}
                itemNoun="days"
                storageKey="recovery-daily-coverage"
                initialSort={{ key: "date", direction: "desc" }}
                empty={
                  <p className="p-4 text-sm text-ink-500">
                    No days recorded {recoveryPeriodPhrase(reportingPeriod)}.
                  </p>
                }
                mobileRow={(d) => (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-900">{d.date}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {d.neededTarget === null ? (
                          <>
                            <Money value={d.sales} bare /> — closed day
                          </>
                        ) : (
                          <>
                            <Money value={d.sales} bare /> of{" "}
                            <Money value={d.neededTarget} bare /> allocated
                          </>
                        )}
                      </p>
                    </div>
                    <Pill tone={STATUS_TONE[d.status]}>
                      <DailyStatusIcon status={d.status} />
                      {dailyRowStatusLabel(d.status)}
                    </Pill>
                  </div>
                )}
              />
            </div>
            <ListDisclosureControl
              disclosure={dailyCoverageDisclosure}
              total={dailyCoverageRows.length}
              itemLabel="days"
              className="mt-3"
            />
          </div>

          <AiCard
            title="Summary"
            subtitle="Composed from your records, not AI-written"
            footer={
              <button
                type="button"
                onClick={() => askFinSight(expandQuestion)}
                className="tap-inline inline-flex items-center gap-1.5 font-semibold text-accent-200 underline-offset-2 hover:underline"
              >
                Ask about this period
                <ArrowRight
                  aria-hidden
                  className="size-3.5"
                />
              </button>
            }
          >
            Recorded sales {recoveryPeriodPhrase(reportingPeriod)} are{" "}
            <Kw>
              <span className="figure">
                {formatMoney(reportingPeriod.sales)}
              </span>
            </Kw>{" "}
            against a {formatMoney(reportingPeriod.target)} target. {" "}
            {recoveryPeriodStatusLabel(reportingPeriod)}.
            {!reportingPeriod.isComplete &&
            reportingPeriod.adjustedDailyTarget !== null ? (
              <>
                {" "}The remaining target is{" "}
                <Kw>
                  <span className="figure">
                    {formatMoney(reportingPeriod.remainingTarget)}
                  </span>
                </Kw>
                , or about{" "}
                <Kw>
                  <span className="figure">
                    {formatMoney(reportingPeriod.adjustedDailyTarget)}
                  </span>
                </Kw>{" "}
                per remaining operating day.
              </>
            ) : null}
          </AiCard>
        </div>
      ) : null}

      <AskFinSightButton originModule="Recovery Target" />
    </div>
  );
}
