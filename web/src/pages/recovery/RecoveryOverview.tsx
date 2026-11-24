import type { ReactNode } from "react";
import { IconTile } from "../../components/IconTile";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Check,
  CircleHelp,
  Flag,
  Info,
  Minus,
  Target,
} from "lucide-react";
import { monthToneAndCopy } from "../../lib/recoveryMonthState";
import { Button, ButtonLink, classesFor } from "../../components/Button";
import { STATUS_COLORS, STATUS_INK, STATUS_TEXT_COLORS } from "../../lib/chartPalette";
import { ProgressRing } from "./RecoveryCharts";
import type {
  RecoveryInsight,
  RecoveryReportingPeriod,
  RecoveryStatus,
} from "../../lib/types";
import { Card, Panel } from "../../components/ui";
import { formatMoney } from "../../components/Money";
import {
  statusColor,
  recoveryPeriodLabel,
  recoveryPeriodPhrase,
  recoveryPeriodStatusLabel,
  formatOperatingDays,
  focusSection,
} from "./recoveryLabels";

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
export function RecoveryPrimaryAction({
  status,
  businessProfileId,
  onAddSale,
}: {
  status: RecoveryStatus | undefined;
  businessProfileId: number;
  onAddSale: () => void;
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
        <Button variant="primary" size="sm" onClick={onAddSale}>
          Record today's sales
        </Button>
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
export function RecoveryChangeSincePreviousDay({
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
export function RecoveryHero({
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
                New daily goal
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
                Sales recorded {recoveryPeriodPhrase(period)}
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
        <dl className="relative mt-6 grid grid-cols-1 divide-y divide-white/10 rounded-xl bg-white/[0.06] py-1 ring-1 ring-white/10 min-[440px]:grid-cols-3 min-[440px]:divide-x min-[440px]:divide-y-0 min-[440px]:py-3">
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
            <div key={item.label} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 min-[440px]:block min-[440px]:py-0 sm:px-4">
              <dt className="text-xs font-medium text-brand-200">{item.label}</dt>
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
              ? "Monthly costs paid by sales so far"
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
          <div className="flex items-baseline justify-between gap-3 text-xs">
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
export function RecoveryPaceCard({
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
    // The grid stretches this card to the hero's height. The two figures share
    // the space above the action and are centred in it, so they don't sit at
    // the top of a half-empty card.
    <Card className="flex min-w-0 flex-col p-5 motion-safe:animate-fade-up">
      <div className="flex flex-1 flex-col justify-center">
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
      </div>
      {action ? (
        <div className="pt-5">
          <div className="border-t border-paper-200 pt-4">{action}</div>
        </div>
      ) : null}
    </Card>
  );
}

// Tone no longer paints the tile (see `.stat-tile` in index.css); only a
// danger tone marks it, with the shared alert bar.
type InputTileTone = "brand" | "info" | "danger" | "neutral";

/**
 * One input to the target. Each tile carries a small picture of its own
 * figure (elapsed days, the target's drift, today's progress) so the row
 * says something at a glance instead of being four boxed numbers.
 */
export function InputTile({
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
  tone: InputTileTone;
  visual?: ReactNode;
  /** Position in the row, used to stagger the entrance in reading order. */
  order?: number;
}) {
  return (
    <div
      data-alert={tone === "danger" || undefined}
      className="stat-tile motion-safe:animate-fade-up"
      style={{ animationDelay: `${order * 70}ms` }}
    >
      <div className="flex items-center gap-3">
        <IconTile icon={Icon} size="sm" />
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
export function OperatingDayDots({
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
      <p aria-hidden className="mt-1.5 text-xs font-medium text-tone-info">
        {done} elapsed, {left} left
      </p>
    </div>
  );
}

/** How far the per-day ask has moved from the plan, now that some days are gone. */
export function DailyTargetDrift({
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
      <span className="text-xs text-ink-600">
        Now{" "}
        <span className="figure font-semibold text-ink-900">{formatMoney(adjusted)}</span>{" "}
        a day
      </span>
      {Math.abs(percent) >= 0.5 ? (
        <span
          className={`figure inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold ${
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
export function TileProgress({ percent, tone }: { percent: number; tone: "danger" | "brand" }) {
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
export function TodayProgressCard({ data }: { data: RecoveryInsight }) {
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
        <dl className="grid w-full min-w-0 max-w-md gap-2.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-ink-500">Sales recorded today</dt>
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

/**
 * The remaining target as two pictures instead of five boxed numbers: a bar
 * for how much of the target sales already cover, then the one sum that turns
 * what's left into a daily goal (still to go ÷ open days left = new goal).
 */
export function RemainingTargetVisual({
  targetLabel,
  target,
  targetSource,
  sales,
  remaining,
  daysLeft,
  operatingDays,
  elapsedDays,
  approximated,
  dailyGoal,
}: {
  targetLabel: string;
  target: number;
  targetSource: ReactNode;
  sales: number;
  remaining: number;
  daysLeft: string;
  operatingDays: number;
  elapsedDays: number;
  approximated: boolean;
  dailyGoal: number | null;
}) {
  const covered = target > 0 ? Math.min(Math.max((sales / target) * 100, 0), 100) : 0;
  const operator = (symbol: string) => (
    <span aria-hidden className="hidden text-center font-display text-2xl text-ink-500 sm:block">
      {symbol}
    </span>
  );
  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs font-medium text-ink-500">
            {targetLabel}{" "}
            <span className="figure text-sm font-semibold text-ink-900">{formatMoney(target)}</span>
          </p>
          <p className="text-xs text-ink-500">{targetSource}</p>
        </div>
        <div
          role="img"
          aria-label={`Sales so far ${formatMoney(sales)} of ${formatMoney(target)}. Still to go ${formatMoney(remaining)}.`}
          className="mt-2 h-3 w-full overflow-hidden rounded-full bg-paper-200"
        >
          <div
            className="h-full rounded-full bg-tone-brand transition-[width] duration-700 ease-out motion-reduce:transition-none"
            style={{ width: `${Math.max(covered, covered > 0 ? 2 : 0)}%` }}
          />
        </div>
        <div aria-hidden className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-ink-600">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-tone-brand" />
            Sales so far <span className="figure font-semibold text-ink-900">{formatMoney(sales)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-paper-200 ring-1 ring-inset ring-ink-300" />
            Still to go <span className="figure font-semibold text-ink-900">{formatMoney(remaining)}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <div className="rounded-xl ring-1 ring-paper-200">
          <PlanFigure label="Still to go" value={formatMoney(remaining)} />
        </div>
        {operator("÷")}
        <div className="rounded-xl ring-1 ring-paper-200">
          <PlanFigure label="Open days left" value={daysLeft} />
          <div className="px-3.5 pb-3.5">
            <OperatingDayDots total={operatingDays} elapsed={elapsedDays} approximated={approximated} />
          </div>
        </div>
        {operator("=")}
        <PlanFigure
          label="New daily goal"
          value={dailyGoal === null ? "Not applicable" : formatMoney(dailyGoal)}
          emphasis
        />
      </div>
    </div>
  );
}
