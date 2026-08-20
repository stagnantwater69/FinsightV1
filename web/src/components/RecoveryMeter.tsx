import { useEffect, useRef, useState } from "react";
import { STATUS_COLORS, STATUS_INK, STATUS_TEXT_COLORS } from "../lib/chartPalette";
import { Money } from "./Money";
import type { RecoveryTargets } from "../lib/types";

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
  } = recoveryStatus;

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
  const monthFill = onTrack ? STATUS_COLORS.good : STATUS_COLORS.critical;
  // Two different colours for two different jobs — see STATUS_INK's note.
  // `monthSolid` fills the status disc and carries white text on it, so it has
  // to stay the saturated step in every theme. `monthInk` is the label beside
  // it, which has to follow the theme or it disappears on a dark card.
  const monthSolid = onTrack ? STATUS_TEXT_COLORS.good : STATUS_TEXT_COLORS.critical;
  const monthInk = onTrack ? STATUS_INK.good : STATUS_INK.critical;
  const todayFill =
    todaysStatus === "below" ? STATUS_COLORS.critical : todaysStatus === "at" ? STATUS_COLORS.warning : STATUS_COLORS.good;
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
          {onTrack ? "✓" : "!"}
        </span>
        <span className="text-sm font-medium" style={{ color: monthInk }}>
          {onTrack ? "On pace for the month" : "Behind pace for the month"}
        </span>
      </div>

      <div
        className="h-3 w-full overflow-hidden rounded-full bg-ink-100"
        role="progressbar"
        aria-valuenow={Math.round(monthCoveragePercent)}
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
        <Money value={salesThisMonth} /> of <Money value={expectedMonthlyExpenses} /> needed this month (
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
        <div className="rounded-lg px-2.5 py-1.5" style={{ backgroundColor: "rgb(var(--sev-warning-bg))" }}>
          <p className="text-xs font-medium" style={{ color: "rgb(var(--sev-warning-ink))" }}>
            Adjusted daily target
          </p>
          <p className="mt-0.5 text-sm font-semibold" style={{ color: "rgb(var(--sev-warning-ink))" }}>
            <Money value={adjustedDailyTarget} />
          </p>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-ink-500">
        <Money value={remainingTarget} /> still needed across about {remainingOperatingDays} remaining operating day
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
              style={{ width: `${todayRatio * 100}%`, backgroundColor: todayFill }}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-500">
            <Money value={todaysSales} /> recorded of <Money value={todaysTarget} /> needed today
          </p>
        </div>
      ) : null}
    </div>
  );
}
