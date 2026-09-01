import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleHelp,
  Info,
  type LucideIcon,
} from "lucide-react";
import {
  STATUS_COLORS,
  STATUS_INK,
  STATUS_TEXT_COLORS,
} from "../lib/chartPalette";
import { Money } from "./Money";
import type { RecoveryStatus, RecoveryTargets } from "../lib/types";

/**
 * The "info" severity's saturated solid — matching Alert.tsx's own `info`
 * kind (`solid: "#149e8d"`), which is this codebase's one other place an
 * informational (not warning, not critical) status needs a white-safe fill.
 * Not exported from chartPalette.ts alongside STATUS_COLORS/STATUS_TEXT_COLORS
 * because those four are specifically the good/warning/serious/critical
 * severity ramp; info sits outside that ramp the same way it does in Alert.tsx.
 */
const INFO_SOLID = "#149e8d";

/**
 * One of the month-status tones the meter can render — a fifth reading beyond
 * the amber/green/red triad the boolean-only contract could express. `info`
 * covers month states that are neither a warning nor a pass/fail verdict
 * (no sales yet this month; data still settling) — reusing the themed
 * `--sev-info-*` variables Alert.tsx's `info` kind already draws from, rather
 * than inventing a new palette entry.
 */
type MonthTone = "setup" | "info" | "good" | "critical";

/** Maps the server's discriminated `status` (plan §8.1) to this meter's tone
 *  and copy. Falls back to the boolean-derived tone when `status` is absent —
 *  a cached/older response won't carry it, though the real server always
 *  does now. */
function monthToneAndCopy(
  status: RecoveryStatus | undefined,
  onTrack: boolean,
  needsSetup: boolean | undefined,
): { tone: MonthTone; label: string; icon: LucideIcon; helper?: string } {
  switch (status) {
    case "needs_setup":
      return {
        tone: "setup",
        label: "Recovery Target isn't ready yet",
        icon: CircleHelp,
      };
    case "no_current_month_data":
      return {
        tone: "info",
        label: "No sales recorded yet this month",
        icon: Info,
      };
    // Not sent by the server yet (Phase 2+) — given the same informational
    // treatment as no_current_month_data until it is.
    case "data_incomplete":
      return {
        tone: "info",
        label: "No sales recorded yet this month",
        icon: Info,
      };
    case "covered":
      return {
        tone: "good",
        label: "Sales coverage target reached",
        icon: Check,
      };
    case "ahead":
      return { tone: "good", label: "Ahead of pace", icon: Check };
    case "on_pace":
      return { tone: "good", label: "On pace for the month", icon: Check };
    case "behind":
      return {
        tone: "critical",
        label: "Behind pace for the month",
        icon: AlertTriangle,
      };
    default:
      return needsSetup
        ? {
            tone: "setup",
            label: "Recovery Target isn't ready yet",
            icon: CircleHelp,
          }
        : onTrack
          ? { tone: "good", label: "On pace for the month", icon: Check }
          : {
              tone: "critical",
              label: "Behind pace for the month",
              icon: AlertTriangle,
            };
  }
}

/**
 * The Recovery Meter — FinSight's signature component, and one of only two
 * places the amber accent is allowed.
 *
 * Amber is used for the ADJUSTED DAILY TARGET specifically: it is the single
 * number that answers "what do I have to do from here?", and it is the reason
 * the whole screen exists. The month/today progress bars stay on the status
 * palette, because those encode good/bad and amber must not start meaning
 * "warning" — that job belongs to STATUS_TEXT_COLORS.
 *
 * Renders entirely from the backend's computed object; no arithmetic here, so
 * the Dashboard and the Insights page cannot drift apart.
 */
export function RecoveryMeter({
  recoveryStatus,
  compact = false,
}: {
  recoveryStatus: RecoveryTargets;
  /** Denser variant for the landing-page demo and small cards. */
  compact?: boolean;
}) {
  const {
    dailyNeededTarget,
    salesThisMonth,
    expectedMonthlyExpenses,
    remainingTarget,
    remainingOperatingDays,
    adjustedDailyTarget,
    todaysTarget,
    todaysSales,
    todaysGap,
    todaysStatus,
    monthCoveragePercent,
    onTrack,
    needsSetup,
    status,
  } = recoveryStatus;

  const monthState = monthToneAndCopy(status, onTrack, needsSetup);
  const MonthStatusIcon = monthState.icon;

  /*
   * The two bars already transition their width whenever `recoveryStatus`
   * changes (period switch, refetch) — but on the very first mount there was
   * nothing to transition FROM, so the meter's signature moment just
   * appeared fully filled. `animateIn` holds both bars at 0 for one paint,
   * then releases them to their real width on the next frame so the same
   * `transition-[width] duration-700` sweeps in on first load too, the way
   * the rest of the app treats an entrance as something to notice rather
   * than something that just happens. Runs once — later prop changes still
   * animate on their own via the width transition already in place.
   */
  const [animateIn, setAnimateIn] = useState(false);
  const innerFrame = useRef(0);
  useEffect(() => {
    // Two frames, not one: the first commits the 0% state to the DOM, the
    // second is where the browser has actually painted it — starting the
    // transition inside the first callback risks the two style writes
    // coalescing into a single paint, which would skip the sweep entirely.
    const outerFrame = requestAnimationFrame(() => {
      innerFrame.current = requestAnimationFrame(() => setAnimateIn(true));
    });
    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame.current);
    };
  }, []);

  const monthRatio = animateIn ? Math.min(monthCoveragePercent / 100, 1) : 0;
  // A missing baseline is neither "on pace" nor "behind" — it's incomplete
  // setup, so it gets its own neutral (amber) treatment rather than borrowing
  // the green success state or the red failure one. "No sales yet"/"data
  // incomplete" are a fourth, distinct reading — informational rather than a
  // warning or a verdict — so they get the teal `info` tone instead.
  const monthFill =
    monthState.tone === "setup"
      ? STATUS_COLORS.warning
      : monthState.tone === "info"
        ? INFO_SOLID
        : monthState.tone === "good"
          ? STATUS_COLORS.good
          : STATUS_COLORS.critical;
  // Two different colours for two different jobs — see STATUS_INK's note.
  // `monthSolid` fills the status disc and carries white text on it, so it has
  // to stay the saturated step in every theme. `monthInk` is the label beside
  // it, which has to follow the theme or it disappears on a dark card.
  const monthSolid =
    monthState.tone === "setup"
      ? STATUS_TEXT_COLORS.warning
      : monthState.tone === "info"
        ? INFO_SOLID
        : monthState.tone === "good"
          ? STATUS_TEXT_COLORS.good
          : STATUS_TEXT_COLORS.critical;
  const monthInk =
    monthState.tone === "setup"
      ? STATUS_INK.warning
      : monthState.tone === "info"
        ? "rgb(var(--sev-info-ink))"
        : monthState.tone === "good"
          ? STATUS_INK.good
          : STATUS_INK.critical;
  const todayFill =
    todaysStatus === "below"
      ? STATUS_COLORS.critical
      : todaysStatus === "at"
        ? STATUS_COLORS.warning
        : STATUS_COLORS.good;
  const todayInk =
    todaysStatus === "below"
      ? STATUS_INK.critical
      : todaysStatus === "at"
        ? STATUS_INK.warning
        : STATUS_INK.good;
  const todayRatio = animateIn
    ? todaysTarget > 0
      ? Math.min(todaysSales / todaysTarget, 1)
      : todaysSales > 0
        ? 1
        : 0
    : 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-ink-500">This month</span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
          style={{ backgroundColor: monthSolid }}
        >
          <MonthStatusIcon aria-hidden className="size-3" strokeWidth={2.2} />
        </span>
        <span className="text-sm font-medium" style={{ color: monthInk }}>
          {monthState.label}
        </span>
      </div>
      {monthState.tone === "setup" ? (
        <p className="mb-2 text-xs text-ink-500">
          Add your expected monthly expenses to calculate your target.
        </p>
      ) : null}

      <div
        className="h-3 w-full overflow-hidden rounded-full bg-ink-100"
        role="progressbar"
        aria-valuenow={Math.round(
          Math.min(Math.max(monthCoveragePercent, 0), 100),
        )}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Month-to-date coverage of expected monthly expenses"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${monthRatio * 100}%`, backgroundColor: monthFill }}
        />
      </div>
      <p className="mt-1.5 text-xs text-ink-500">
        <Money value={salesThisMonth} /> of{" "}
        <Money value={expectedMonthlyExpenses} /> needed this month (
        {monthCoveragePercent.toFixed(0)}%)
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-ink-500">Daily needed target</p>
          <p className="mt-0.5 text-sm font-medium text-ink-900">
            <Money value={dailyNeededTarget} />
          </p>
        </div>
        {/* The accent moment: the number that says what to do next. */}
        {/* Paired with the warning ink used on the two lines inside it, so the
            wash and the text stay in step across themes — ACCENT.surface is a
            fixed pale amber and would glare on the dark card. */}
        <div
          className="rounded-lg px-2.5 py-1.5"
          style={{ backgroundColor: "rgb(var(--sev-warning-bg))" }}
        >
          <p
            className="text-xs font-medium"
            style={{ color: "rgb(var(--sev-warning-ink))" }}
          >
            Adjusted daily target
          </p>
          <p
            className="mt-0.5 text-sm font-semibold"
            style={{ color: "rgb(var(--sev-warning-ink))" }}
          >
            <Money value={adjustedDailyTarget} />
          </p>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-ink-500">
        <Money value={remainingTarget} /> still needed across about{" "}
        {remainingOperatingDays} remaining operating day
        {remainingOperatingDays === 1 ? "" : "s"}.
      </p>

      {!compact ? (
        <div className="mt-4 border-t border-paper-200 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-xs text-ink-500">Today</span>
            <span className="text-xs font-medium" style={{ color: todayInk }}>
              {todaysStatus === "at" ? (
                "Reached target"
              ) : (
                <>
                  <Money value={Math.abs(todaysGap)} /> {todaysStatus} target
                </>
              )}
            </span>
          </div>
          <div
            className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ink-100"
            role="progressbar"
            aria-valuenow={Math.round(todayRatio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Today's progress toward the daily target"
          >
            <div
              className="h-full rounded-full transition-[width] duration-700 ease-out"
              style={{
                width: `${todayRatio * 100}%`,
                backgroundColor: todayFill,
              }}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-500">
            <Money value={todaysSales} /> recorded of{" "}
            <Money value={todaysTarget} /> needed today
          </p>
        </div>
      ) : null}
    </div>
  );
}
