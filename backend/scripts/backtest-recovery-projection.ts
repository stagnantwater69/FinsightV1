/**
 * Recovery Target projection backtest — SYNTHETIC-PATTERN SANITY CHECK ONLY.
 *
 * docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §11 Phase 5 ("Backtest the
 * projection against historical synthetic and privacy-safe representative
 * datasets"), §17 Gate E ("Forecast meets agreed backtesting threshold"),
 * §19 open question #9 ("What forecast error threshold is acceptable before
 * enabling projections?").
 *
 * WHAT THIS IS. A manual measurement tool, not a test. It generates several
 * representative SYNTHETIC daily-sales patterns for a 30-day month, runs
 * `deriveRecoveryProjection`'s exact production formula at several
 * checkpoints partway through that month, and compares the projected
 * month-end total against the KNOWN ground truth (since the data is
 * synthetic, the real answer is known in advance). It reports mean absolute
 * error (MAE) and mean absolute percentage error (MAPE) per pattern per
 * checkpoint.
 *
 * WHAT THIS IS NOT — READ BEFORE CITING THESE NUMBERS ANYWHERE. This
 * repository's house rule against presenting the mostly-synthetic OCR corpus
 * as real-receipt evidence (see CLAUDE.md) applies with equal force here:
 * these five hand-authored curves are not a sample of real FinSight
 * businesses, do not capture real seasonality/promotions/closures/reporting
 * lag, and passing or failing some hypothetical threshold on THIS data proves
 * nothing about real-world forecast accuracy. This script exists so that a
 * future, stakeholder-approved backtesting threshold (plan §19 #9) can be
 * evaluated against SOMETHING before being evaluated against real (consented,
 * privacy-safe) business data — it is a sanity check that the formula behaves
 * sensibly on known inputs, not a validation of real-world accuracy, and it
 * must never be cited as the latter.
 *
 * Usage (no database, no server, no live AI — pure arithmetic):
 *   npx tsx scripts/backtest-recovery-projection.ts
 *
 * Deliberately NOT part of `npm test` — this is a measurement tool with no
 * pass/fail assertion, because there is no approved threshold yet to gate
 * against (plan §16.2 step 9: "Gate forecasts behind backtesting
 * thresholds").
 */

import { deriveRecoveryProjection, PROJECTION_LOOKBACK_OPEN_DAYS } from "../src/services/analysis.service";

const DAYS_IN_MONTH = 30;
const CHECKPOINT_DAYS = [10, 15, 20];

/** One day's synthetic sales, split the same way real data is: confirmed vs. everything else. */
interface SyntheticDay {
  confirmed: number;
  provisional: number;
}

interface SyntheticPattern {
  name: string;
  describe: string;
  days: SyntheticDay[]; // length DAYS_IN_MONTH, index 0 = day 1
}

function day(confirmed: number, provisional = 0): SyntheticDay {
  return { confirmed, provisional };
}

/** Small deterministic pseudo-random generator — NOT cryptographic, just
 * reproducible across runs so this report doesn't change between invocations
 * without a code change. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function buildPatterns(): SyntheticPattern[] {
  const patterns: SyntheticPattern[] = [];

  // 1. Steady daily sales — the easiest case; the projection should be
  // nearly exact here since the rate genuinely doesn't change.
  patterns.push({
    name: "steady",
    describe: "Constant ~5,000/day every day, no weekly or trend structure.",
    days: Array.from({ length: DAYS_IN_MONTH }, () => day(5000)),
  });

  // 2. Weekday-heavy / weekend-light — a real sari-sari-store-like weekly
  // cadence. Day 1 of this synthetic month is treated as a Monday.
  patterns.push({
    name: "weekday-heavy",
    describe: "6,000/day Mon-Fri, 2,000/day Sat-Sun (day 1 = Monday).",
    days: Array.from({ length: DAYS_IN_MONTH }, (_, i) => {
      const weekday = (i % 7) + 1; // 1=Mon..7=Sun
      return day(weekday <= 5 ? 6000 : 2000);
    }),
  });

  // 3. Gradual ramp — a business genuinely growing (or declining) through
  // the month. The recent-window average should track this better than a
  // whole-month-to-date average would, which is the projection's whole
  // reason to exist over the existing pace figure.
  patterns.push({
    name: "gradual-ramp",
    describe: "Linearly rises from 2,000/day on day 1 to 8,000/day on day 30.",
    days: Array.from({ length: DAYS_IN_MONTH }, (_, i) => day(2000 + (6000 * i) / (DAYS_IN_MONTH - 1))),
  });

  // 4. Volatile / spiky — occasional large days (a bulk order, a festival)
  // against a modest daily baseline. This is the pattern most likely to
  // expose a fixed-lookback average's weakness: a spike inside the window
  // versus just outside it can swing the projection substantially.
  {
    const rand = seededRandom(42);
    patterns.push({
      name: "volatile-spiky",
      describe: "3,000/day baseline with ~15% chance of a 20,000 spike day.",
      days: Array.from({ length: DAYS_IN_MONTH }, () => day(rand() < 0.15 ? 20000 : 3000)),
    });
  }

  // 5. Provisional-mixed — roughly a third of each day's sales sit in
  // "Needs Review"/"Flagged" limbo, unresolved by the time of each
  // checkpoint. This is the case §9.8's confirmed-only average exists for:
  // measures whether excluding provisional sales from the RATE still
  // produces a usable projection against the TRUE (confirmed + provisional)
  // month-end total, which is what an owner actually experiences.
  patterns.push({
    name: "provisional-mixed",
    describe: "5,000/day total sales, but only 70% is confirmed by each checkpoint; 30% sits pending review.",
    days: Array.from({ length: DAYS_IN_MONTH }, () => day(3500, 1500)),
  });

  return patterns;
}

interface CheckpointResult {
  pattern: string;
  checkpointDay: number;
  status: string;
  projected: number | null;
  actual: number;
  absoluteError: number | null;
  absolutePercentError: number | null;
}

/**
 * Runs the exact production formula (`deriveRecoveryProjection`) at
 * `checkpointDay`, treating days `1..checkpointDay` as "elapsed" (today =
 * checkpointDay) and `checkpointDay+1..DAYS_IN_MONTH` as remaining. The
 * lookback window is every completed day (`1..checkpointDay-1`) — the same
 * "grows across the month" interpretation `computeRecoveryProjection` uses
 * in production; see that function's doc comment in insights.service.ts for
 * why a fixed trailing-N window was not chosen instead.
 */
function runCheckpoint(pattern: SyntheticPattern, checkpointDay: number): CheckpointResult {
  const completedDays = pattern.days.slice(0, checkpointDay - 1); // days 1..checkpointDay-1
  const lookbackConfirmedSalesSum = completedDays.reduce((s, d) => s + d.confirmed, 0);
  const lookbackProvisionalSalesSum = completedDays.reduce((s, d) => s + d.provisional, 0);

  const elapsedDays = pattern.days.slice(0, checkpointDay); // days 1..checkpointDay, inclusive of "today"
  const confirmedSalesThisMonth = elapsedDays.reduce((s, d) => s + d.confirmed, 0);

  const remainingOperatingDays = DAYS_IN_MONTH - checkpointDay + 1; // today counts as remaining, per §9.2/§9.4 convention

  // Recent calendar days before "today" that had ANY sales — every synthetic
  // pattern here has sales on every single day, so staleness never fires in
  // this backtest. That's intentional: staleness is a data-freshness guard
  // already covered by unit tests (tests/unit/recoveryProjection.test.ts),
  // not something this accuracy measurement needs to re-exercise.
  const hasRecentSales = true;

  const expectedMonthlyExpenses = 0; // irrelevant to accuracy — only offsets projectedVarianceAmount, not projectedMonthEndSales

  const projection = deriveRecoveryProjection({
    lookbackOperatingDaysAvailable: completedDays.length,
    lookbackConfirmedSalesSum,
    lookbackProvisionalSalesSum,
    hasRecentSales,
    confirmedSalesThisMonth,
    remainingOperatingDays,
    expectedMonthlyExpenses,
  });

  const actual = pattern.days.reduce((s, d) => s + d.confirmed + d.provisional, 0);
  const projected = projection.projectedMonthEndSales;
  const absoluteError = projected === null ? null : Math.abs(projected - actual);
  const absolutePercentError = projected === null || actual === 0 ? null : (Math.abs(projected - actual) / actual) * 100;

  return {
    pattern: pattern.name,
    checkpointDay,
    status: projection.status,
    projected,
    actual,
    absoluteError,
    absolutePercentError,
  };
}

function formatNumber(n: number | null): string {
  if (n === null) return "n/a";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatPercent(n: number | null): string {
  if (n === null) return "n/a";
  return `${n.toFixed(1)}%`;
}

function main() {
  const patterns = buildPatterns();
  const results: CheckpointResult[] = [];
  for (const pattern of patterns) {
    for (const checkpointDay of CHECKPOINT_DAYS) {
      results.push(runCheckpoint(pattern, checkpointDay));
    }
  }

  console.log("");
  console.log("Recovery Target projection backtest — SYNTHETIC-PATTERN SANITY CHECK, NOT a real-world accuracy claim.");
  console.log(`(${DAYS_IN_MONTH}-day synthetic month, projection lookback minimum = ${PROJECTION_LOOKBACK_OPEN_DAYS} completed open days)`);
  console.log("");

  for (const pattern of patterns) {
    console.log(`Pattern: ${pattern.name} — ${pattern.describe}`);
    console.log("  checkpoint | status           | projected   | actual      | abs error   | abs % error");
    console.log("  -----------|------------------|-------------|-------------|-------------|------------");
    for (const r of results.filter((x) => x.pattern === pattern.name)) {
      console.log(
        `  day ${String(r.checkpointDay).padStart(6)} | ${r.status.padEnd(16)} | ${formatNumber(r.projected).padStart(11)} | ${formatNumber(r.actual).padStart(11)} | ${formatNumber(r.absoluteError).padStart(11)} | ${formatPercent(r.absolutePercentError).padStart(11)}`,
      );
    }
    console.log("");
  }

  console.log("Summary — mean absolute error (MAE) and mean absolute percentage error (MAPE), by pattern:");
  console.log("  pattern            | MAE         | MAPE");
  console.log("  -------------------|-------------|--------");
  for (const pattern of patterns) {
    const rows = results.filter((r) => r.pattern === pattern.name && r.absoluteError !== null);
    const mae = rows.length ? rows.reduce((s, r) => s + r.absoluteError!, 0) / rows.length : null;
    const mape = rows.length ? rows.reduce((s, r) => s + r.absolutePercentError!, 0) / rows.length : null;
    console.log(`  ${pattern.name.padEnd(19)}| ${formatNumber(mae).padStart(11)} | ${formatPercent(mape)}`);
  }

  console.log("");
  console.log("Summary — MAE/MAPE by checkpoint day, across all patterns:");
  console.log("  checkpoint | MAE         | MAPE");
  console.log("  -----------|-------------|--------");
  for (const checkpointDay of CHECKPOINT_DAYS) {
    const rows = results.filter((r) => r.checkpointDay === checkpointDay && r.absoluteError !== null);
    const mae = rows.length ? rows.reduce((s, r) => s + r.absoluteError!, 0) / rows.length : null;
    const mape = rows.length ? rows.reduce((s, r) => s + r.absolutePercentError!, 0) / rows.length : null;
    console.log(`  day ${String(checkpointDay).padStart(6)} | ${formatNumber(mae).padStart(11)} | ${formatPercent(mape)}`);
  }

  console.log("");
  console.log("Reminder: the figures above describe five hand-authored synthetic curves only. They are a sanity");
  console.log("check that the formula behaves sensibly on known inputs, NOT evidence of real-world forecast");
  console.log("accuracy, and must not be used to set the plan §19 #9 release threshold on their own.");
}

/* c8 ignore start -- CLI entrypoint, a manual measurement tool, not exercised by the test suite */
if (require.main === module) {
  main();
}
/* c8 ignore stop */
