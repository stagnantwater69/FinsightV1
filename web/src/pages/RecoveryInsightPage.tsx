import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookmarkCheck,
  CalendarOff,
  CircleGauge,
  History,
  ListChecks,
  Minus,
  SlidersHorizontal,
  Target,
  type LucideIcon,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import {
  AskFinSightButton,
  useAskFinSight,
} from "../components/AskFinSightButton";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { StatTile } from "../components/StatTile";
import { DataTable, type Column } from "../components/DataTable";
import { Button, ButtonLink, classesFor } from "../components/Button";
import { Field, FormError, MoneyInput } from "../components/Field";
import { STATUS_TEXT_COLORS } from "../lib/chartPalette";
import type {
  DailyCoverageRow,
  DailyRowStatus,
  DayStatus,
  RecoveryCheckpoint,
  RecoveryCheckpointStatus,
  RecoveryInsight,
  RecoveryPlan,
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
import {
  SkeletonPanel,
  SkeletonRows,
  SkeletonStatTile,
} from "../components/Skeleton";
import { TextInput } from "../components/Field";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";

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
function dailyRowStatusLabel(status: DailyRowStatus): string {
  return status === "closed" ? "Closed" : statusLabel(status);
}

// The Status column as a themed Pill rather than a hand-rolled chip painted
// with an inline background colour — see the note on PILL_TONES in ui.tsx.
// "at" reads as informational rather than a warning: reaching the target
// exactly is a good outcome, not a caution. "closed" is neutral — a
// configured non-operating day is neither good nor bad news, so it must not
// borrow the danger/info/ok tones the other three statuses use.
const STATUS_TONE: Record<DailyRowStatus, PillTone> = {
  below: "danger",
  at: "info",
  above: "ok",
  closed: "neutral",
};

function DailyStatusIcon({ status }: { status: DailyRowStatus }) {
  const Icon =
    status === "below"
      ? ArrowDown
      : status === "at"
        ? Minus
        : status === "closed"
          ? CalendarOff
          : ArrowUp;
  return <Icon aria-hidden className="size-3.5" strokeWidth={2} />;
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
  return (
    <div className="rounded-xl border border-paper-200 bg-paper-100 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
          {label}
        </p>
        <Pill tone={CHECKPOINT_STATUS_TONE[checkpoint.status]}>
          {checkpointStatusLabel(checkpoint.status)}
        </Pill>
      </div>
      <p className="mt-1 text-sm font-medium text-ink-700">
        {formatCheckpointDate(checkpoint.endDate)}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-500">Cumulative target</dt>
          <dd className="figure font-semibold text-ink-900">
            {formatMoney(checkpoint.cumulativeTarget)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Recorded amount</dt>
          <dd className="figure font-semibold text-ink-900">
            {isPending || checkpoint.recordedAmount === null ? (
              <span className="text-ink-400">Not yet reached</span>
            ) : (
              formatMoney(checkpoint.recordedAmount)
            )}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-ink-500">Variance</dt>
          <dd
            className="figure font-semibold"
            style={{
              color: checkpointStatusColor(checkpoint.status) || undefined,
            }}
          >
            {isPending || checkpoint.variance === null ? (
              <span className="text-ink-400">—</span>
            ) : (
              formatMoney(checkpoint.variance, { signed: true })
            )}
          </dd>
        </div>
      </dl>
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
        <span className="text-ink-400">Not yet reached</span>
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
        <span className="text-ink-400">—</span>
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
}: {
  checkpoints: RecoveryCheckpoint[];
  todayKey: string;
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
      eyebrow="Cumulative open-day targets for this month"
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
      <div className="grid gap-4 sm:grid-cols-2">
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
            caption="All weekly checkpoints for this month."
            itemNoun="checkpoints"
            initialSort={{ key: "endDate", direction: "asc" }}
            empty={
              <p className="p-4 text-sm text-ink-500">
                No checkpoints yet this month.
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
    header: "Needed target",
    width: "content",
    align: "right",
    // Sorts closed days (null) to the low end rather than throwing on the
    // comparison — DataTable's sort just needs any stable, finite ordering.
    sortValue: (d) => d.neededTarget ?? -1,
    cell: (d) =>
      d.neededTarget === null ? (
        <span className="text-ink-400">—</span>
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
        <span className="text-ink-400">—</span>
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

function RecoverySectionNav({
  showCheckpoints,
  showSavedPlan,
}: {
  showCheckpoints: boolean;
  showSavedPlan: boolean;
}) {
  const items: { href: string; label: string; icon: LucideIcon }[] = [
    { href: "#recovery-overview", label: "Overview", icon: CircleGauge },
    { href: "#remaining-recovery-target", label: "Daily plan", icon: Target },
    ...(showCheckpoints
      ? [
          {
            href: "#recovery-checkpoints",
            label: "Checkpoints",
            icon: ListChecks,
          },
        ]
      : []),
    ...(showSavedPlan
      ? [
          {
            href: "#recovery-saved-plan",
            label: "Saved plan",
            icon: BookmarkCheck,
          },
        ]
      : []),
    { href: "#recovery-scenario", label: "Scenario", icon: SlidersHorizontal },
    { href: "#daily-coverage", label: "Daily history", icon: History },
  ];

  return (
    <nav
      aria-label="Recovery target sections"
      className="scroll-slim -mx-1 overflow-x-auto px-1 pb-1"
    >
      <div className="flex min-w-max items-center gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1">
        <span className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
          Jump to
        </span>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              className="tap-inline inline-flex items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-ink-600 transition hover:bg-paper hover:text-brand-800 focus-visible:bg-paper"
            >
              <Icon aria-hidden className="size-3.5" strokeWidth={1.9} />
              {item.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
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
      <p className="mt-2 text-xs text-ink-400">
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
function ScenarioDeltaRow({
  label,
  current,
  hypothetical,
}: {
  label: string;
  current: number;
  hypothetical: number;
}) {
  const delta = hypothetical - current;
  const percent = Math.abs(current) >= 1 ? (delta / current) * 100 : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm first:pt-0 last:pb-0">
      <span className="text-tone-accent">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        <span className="figure text-ink-500 line-through decoration-1">
          {formatMoney(current)}
        </span>
        <span className="figure font-semibold text-ink-900">
          {formatMoney(hypothetical)}
        </span>
        <span className="figure text-xs text-tone-accent">
          ({formatMoney(delta, { signed: true })}
          {percent !== null
            ? `, ${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%`
            : ""}
          )
        </span>
      </span>
    </div>
  );
}

/** "YYYY-MM" for the current local month — the saved-plan surface always
 * targets the month the owner is looking at, matching the recovery
 * calculation itself being month-to-date with no period selector. */
function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
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
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-400">
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
      <p className="mb-3 text-xs text-ink-400">
        A note you saved for yourself. It has never changed, and does not
        change, your actual Recovery Target, business profile, or recorded
        sales.
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
                <span className="text-ink-400">—</span>
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
                <span className="text-ink-400">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Buffer</dt>
            <dd className="figure font-semibold text-ink-900">
              {plan.bufferPercent === null ? (
                <span className="text-ink-400">—</span>
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const value = Number(rawValue);
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
      title="What if my expected monthly expenses changed?"
      action={
        !expanded ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setExpanded(true)}
          >
            Try a scenario
          </Button>
        ) : null
      }
    >
      {!expanded ? (
        <p className="text-sm text-ink-500">
          See what your recovery target would look like under a different
          expected-monthly-expenses assumption — nothing here is saved or
          changes your business profile.
        </p>
      ) : (
        <div className="space-y-4">
          {/* noValidate: the JS check above (finite, >= 0) is the single
              source of the error message shown, same as
              ReductionSimulationModal's own form — native HTML5 constraint
              validation on a min-0 number input would otherwise silently
              swallow the submit instead of surfacing that message. */}
          <form
            onSubmit={handleSubmit}
            className="flex flex-wrap items-end gap-3"
            noValidate
          >
            <Field
              label="Assumed expected monthly expenses"
              htmlFor="recovery-scenario-value"
              hint="A hypothetical figure to test — your real, saved expected monthly expenses is unaffected."
              className="min-w-[14rem] flex-1"
            >
              <MoneyInput
                id="recovery-scenario-value"
                value={rawValue}
                min={0}
                onChange={(e) => setRawValue(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Calculating…" : "See hypothetical target"}
            </Button>
          </form>

          {error ? <FormError>{error}</FormError> : null}

          {scenario ? (
            // The distinct surface itself: a dashed ring and a different tint
            // from every other panel on this page, so it cannot be mistaken
            // for another read of the real target above.
            <div className="rounded-xl border-2 border-dashed border-edge-accent bg-tint-accent p-4">
              <Callout tone="warn">
                <b className="font-semibold">Hypothetical — not saved.</b> This
                does not change your business profile's expected monthly
                expenses. Assumed value used:{" "}
                <span className="figure font-semibold">
                  {formatMoney(scenario.assumedExpectedMonthlyExpenses)}
                </span>
                .
              </Callout>

              <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-accent">
                    Hypothetical daily needed target
                  </dt>
                  <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                    {formatMoney(scenario.hypothetical.dailyNeededTarget)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-accent">
                    Hypothetical remaining target
                  </dt>
                  <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                    {formatMoney(scenario.hypothetical.remainingTarget)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-accent">
                    Hypothetical adjusted daily target
                  </dt>
                  <dd className="figure mt-0.5 text-lg font-semibold text-ink-900">
                    {formatMoney(scenario.hypothetical.adjustedDailyTarget)}
                  </dd>
                </div>
              </dl>

              <p className="mt-3 text-xs text-tone-accent opacity-90">
                For comparison, your current (real, saved) daily needed target
                is{" "}
                <span className="figure font-semibold">
                  {formatMoney(scenario.current.dailyNeededTarget)}
                </span>{" "}
                — unchanged by this scenario. Want to actually change your
                expected monthly expenses? Edit your business profile directly;
                nothing here does that for you.
              </p>

              {/* Side-by-side current/hypothetical with deltas — plan §10.7. */}
              <div className="mt-4 border-t border-edge-accent/40 pt-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-accent">
                  Current vs. hypothetical
                </p>
                <div className="mt-2 divide-y divide-edge-accent/30">
                  <ScenarioDeltaRow
                    label="Expected monthly expenses"
                    current={scenario.current.expectedMonthlyExpenses}
                    hypothetical={scenario.hypothetical.expectedMonthlyExpenses}
                  />
                  <ScenarioDeltaRow
                    label="Remaining target"
                    current={scenario.current.remainingTarget}
                    hypothetical={scenario.hypothetical.remainingTarget}
                  />
                  <ScenarioDeltaRow
                    label="Adjusted daily target"
                    current={scenario.current.adjustedDailyTarget}
                    hypothetical={scenario.hypothetical.adjustedDailyTarget}
                  />
                </div>

                {/* §9.9: always null right now — say so plainly rather than
                    silently omitting a figure the plan otherwise promises. */}
                <p className="mt-3 text-xs text-tone-accent opacity-90">
                  <b className="font-semibold">
                    Estimated transactions per day:
                  </b>{" "}
                  Not available — FinSight can't yet tell whether your sales
                  records represent individual transactions or daily totals, so
                  it won't guess a transaction count.
                </p>
              </div>

              {/* Small, secondary — plan §10.7: "clearly optional/secondary".
                  Persists the assumed value above as a separate, owner-visible
                  RecoveryPlan; never touches the real business profile. */}
              <div className="mt-4 border-t border-edge-accent/40 pt-3">
                {!showSavePlanForm ? (
                  <button
                    type="button"
                    onClick={() => setShowSavePlanForm(true)}
                    className="tap-inline inline-flex items-center gap-1.5 text-xs font-semibold text-tone-accent underline underline-offset-2"
                  >
                    Save this as a plan
                    {hasSavedPlan
                      ? " (replaces your current one for this month)"
                      : ""}
                    <ArrowRight
                      aria-hidden
                      className="size-3.5"
                      strokeWidth={1.9}
                    />
                  </button>
                ) : (
                  <form onSubmit={handleSavePlan} className="space-y-3">
                    <p className="text-xs text-tone-accent opacity-90">
                      Saves the assumed expected monthly expenses above (
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
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-400">
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
                  <p className="mt-2 text-xs font-medium text-tone-accent">
                    Saved for reference — this doesn't change your business
                    profile or recorded sales.
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

export function RecoveryInsightPage() {
  const { selected } = useBusinessProfiles();
  const [data, setData] = useState<RecoveryInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the "expand on this" link below hands one through to
  // be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Recovery Target");
  // Guards against a slow response for a since-abandoned profile landing
  // after a newer one — without it, switching profiles quickly can let an
  // in-flight request for the PREVIOUS profile overwrite the current one's
  // freshly-loaded data.
  const requestId = useRef(0);

  // This month's saved plan — plan §7.5/§10.7. A cheap, optional extra fetch
  // that never blocks or affects the main recovery render: it starts
  // alongside `load()` below, and any failure (or simply no saved plan) just
  // leaves `plan` at `null`, which renders nothing.
  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  const planRequestId = useRef(0);
  const monthKey = currentMonthKey();

  async function loadPlan(businessProfileId: number) {
    const thisPlanRequestId = ++planRequestId.current;
    try {
      const { data } = await api.get<RecoveryPlan[]>(
        `/business-profiles/${businessProfileId}/recovery-plans`,
        {
          params: { month: monthKey },
        },
      );
      if (thisPlanRequestId !== planRequestId.current) return;
      setPlan(data[0] ?? null);
    } catch {
      if (thisPlanRequestId !== planRequestId.current) return;
      setPlan(null);
    }
  }

  async function load() {
    if (!selected) return;
    const thisRequestId = ++requestId.current;
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
    setPlan(null);
    if (selected) loadPlan(selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  if (!selected) return null;

  const isInitialLoad = loading && !data;
  const isRefreshing = loading && data !== null;

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
            See your current sales-coverage pace, the daily amount still needed,
            and what to review next.
          </>
        }
        actions={
          <Link
            to="/insights/recovery/month-end-review"
            className="tap-inline inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 underline underline-offset-2"
          >
            View last month's summary
            <ArrowRight aria-hidden className="size-4" strokeWidth={1.9} />
          </Link>
        }
      />

      <InsightsTabs />

      {/*
        Required product definition (plan §6.1) — must sit before or beside
        the first status, not only beneath the detailed formulas further down
        this page. Copy is exact; do not paraphrase.
      */}
      <p className="mb-5 text-sm text-ink-500">
        Your Sales Coverage Target compares recorded sales references with your
        expected monthly expense amount. It is a planning guide and does not
        calculate profit, cash flow, or formal break-even.
      </p>

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
                onClick={load}
                disabled={loading}
              >
                {loading ? "Retrying…" : "Retry"}
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
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={load}
              >
                Retry
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

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
            <b className="font-semibold">
              No sales are recorded for this month yet
            </b>
            , so every figure below compares your target against zero. It isn't
            a shortfall you've made — there's simply nothing in this month to
            measure.
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
              className="tap-inline inline-flex items-center gap-1.5 font-semibold text-brand-700 underline underline-offset-2"
            >
              See your records
              <ArrowRight aria-hidden className="size-4" strokeWidth={1.9} />
            </Link>
          </Callout>
        </div>
      ) : null}

      {isInitialLoad ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading your recovery target…</span>
          <div className="grid gap-4 sm:grid-cols-3">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
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
      ) : data ? (
        <div
          className={`space-y-6 transition-opacity duration-200 ${isRefreshing ? "opacity-60" : ""}`}
          aria-busy={isRefreshing}
        >
          {isRefreshing ? (
            <span className="sr-only">Refreshing your recovery target…</span>
          ) : null}

          <RecoverySectionNav
            showCheckpoints={Boolean(data.weeklyCheckpoints?.length)}
            showSavedPlan={plan !== null}
          />

          <div id="recovery-overview" className="scroll-mt-6">
            <Panel title="Month-to-date pace">
              <RecoveryMeter recoveryStatus={data} />
              <div className="mt-4 border-t border-paper-200 pt-4">
                <RecoveryPrimaryAction
                  status={data.status}
                  businessProfileId={selected.id}
                />
              </div>
            </Panel>
          </div>

          {/* This tracks the current calendar month — there is no period to
              choose, so the pill here just names what "today" means rather
              than offering a control that does nothing. */}
          <Panel
            title="Inputs"
            action={
              <span className="text-xs text-ink-400">
                {data.asOfDate
                  ? `As of ${new Date(data.asOfDate).toLocaleDateString(
                      undefined,
                      {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      },
                    )}${data.timezone ? `, ${data.timezone} time` : ""}`
                  : "Today"}
              </span>
            }
          >
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
              Daily needed target = expected monthly expenses ÷ operating days.
              This is a target-based recovery guide using your sales reference
              records — it does not calculate formal financial results.
            </p>
          </Panel>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            <StatTile
              label="Today's target"
              value={formatMoney(data.todaysTarget)}
            />
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

          <RecoveryChangeSincePreviousDay
            change={data.changeSincePreviousDay}
          />

          {/* `tabIndex={-1}` makes this focusable-by-script-only (not part of
              the normal tab order) so `focusSection` above can move keyboard
              focus here after the "View today's plan" anchor scrolls to it —
              WCAG 2.4.3. */}
          <div
            id="remaining-recovery-target"
            tabIndex={-1}
            className="scroll-mt-6 focus:outline-none"
          >
            <Panel
              title="Remaining recovery target"
              eyebrow="Recalculated across your remaining operating days"
            >
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
                Remaining target = expected monthly expenses − sales reference
                recorded so far. Adjusted daily target updates as you record
                more sales references — it's a planning guide, not a guarantee
                of any result.
              </p>
              {data.remainingOperatingDaysIsApproximated ? (
                <p className="mt-1 text-xs text-ink-400">
                  Remaining operating days is an estimate: your profile records
                  how many days a month you operate, not which days of the week,
                  so this scales your monthly count by how much of the month is
                  left.{" "}
                  <Link
                    to={`/business-profiles/${selected.id}/operating-schedule`}
                    className="tap-inline inline-flex items-center gap-1.5 font-semibold text-brand-700 underline underline-offset-2"
                  >
                    Edit operating schedule
                    <ArrowRight
                      aria-hidden
                      className="size-3.5"
                      strokeWidth={1.9}
                    />
                  </Link>
                </p>
              ) : data.operatingScheduleConfigured ? (
                <p className="mt-1 text-xs text-ink-400">
                  Based on your configured operating days
                  {typeof data.operatingDaysThisMonth === "number"
                    ? ` — ${data.operatingDaysThisMonth} open this month`
                    : ""}
                  .
                </p>
              ) : null}
              {/* Purely an added disclosure — the salesThisMonth figure above is
                untouched, plan §8.2/§10.5. */}
              {data.dataWarnings &&
              data.dataWarnings.length > 0 &&
              typeof data.provisionalSalesThisMonth === "number" ? (
                <p className="mt-1 text-xs text-ink-400">
                  Includes {formatMoney(data.provisionalSalesThisMonth)} pending
                  review or flagged as a possible duplicate.
                </p>
              ) : null}
            </Panel>
          </div>

          {data.weeklyCheckpoints && data.weeklyCheckpoints.length > 0 ? (
            <div id="recovery-checkpoints" className="scroll-mt-6">
              <RecoveryCheckpoints
                checkpoints={data.weeklyCheckpoints}
                todayKey={data.asOfDate ?? data.today.slice(0, 10)}
              />
            </div>
          ) : null}

          {plan ? (
            <div id="recovery-saved-plan" className="scroll-mt-6">
              <SavedRecoveryPlanPanel
                key={`${selected.id}-${monthKey}`}
                businessProfileId={selected.id}
                monthKey={monthKey}
                plan={plan}
                onPlanChange={setPlan}
              />
            </div>
          ) : null}

          <div id="recovery-scenario" className="scroll-mt-6">
            <RecoveryScenarioPanel
              // Forces a remount on profile switch so the scenario's local
              // state (input, result) can't leak from one business into another.
              key={selected.id}
              businessProfileId={selected.id}
              currentExpectedMonthlyExpenses={data.expectedMonthlyExpenses}
              monthKey={monthKey}
              hasSavedPlan={plan !== null}
              onPlanSaved={setPlan}
            />
          </div>

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
                className="scroll-mt-6 text-sm font-semibold text-ink-700 focus:outline-none"
              >
                Daily coverage
              </h2>
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
              empty={
                <p className="p-4 text-sm text-ink-500">
                  No days recorded yet this month.
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
                          <Money value={d.neededTarget} bare /> needed
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

          <AiCard
            title="FinSight explanation"
            subtitle="Scoped to Recovery Target — composed from your records, not AI-written"
            footer={
              <button
                type="button"
                onClick={() => askFinSight(expandQuestion)}
                className="tap-inline inline-flex items-center gap-1.5 font-semibold text-accent-200 underline-offset-2 hover:underline"
              >
                Ask about this gap
                <ArrowRight
                  aria-hidden
                  className="size-3.5"
                  strokeWidth={1.9}
                />
              </button>
            }
          >
            Your sales reference for today is{" "}
            <Kw>
              <span className="figure">
                {formatMoney(Math.abs(data.todaysGap))}
              </span>
            </Kw>{" "}
            {statusLabel(data.todaysStatus).toLowerCase()}. Based on your
            expected monthly expenses and recorded sales references so far,
            FinSight estimates that you need around{" "}
            <Kw>
              <span className="figure">
                {formatMoney(data.adjustedDailyTarget)}
              </span>
            </Kw>{" "}
            per remaining operating day to still reach the monthly target.
          </AiCard>
        </div>
      ) : null}

      <AskFinSightButton originModule="Recovery Target" />
    </div>
  );
}
