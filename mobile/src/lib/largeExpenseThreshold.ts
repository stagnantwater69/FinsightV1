/**
 * Turning the large-expense threshold from a percentage into an amount of money.
 *
 * WHY THIS EXISTS. The column, the API and every flagging rule store the
 * threshold as a PERCENT of expected monthly expenses — see
 * largeExpenseThresholdFor() in backend/src/services/expenseRecord.service.ts,
 * which multiplies the two. That storage choice is right: it rescales on its
 * own when a business grows, so an owner who doubles their monthly expenses
 * does not silently start getting every ordinary purchase flagged.
 *
 * But it is the wrong question to ASK. "What share of your expected monthly
 * expenses counts as large?" requires an owner to do arithmetic against a
 * figure they estimated thirty seconds earlier. "Flag anything over PHP X" is a
 * question a sari-sari store owner can answer from experience, because they
 * already know what a big purchase feels like.
 *
 * So the percent stays in the database and the pesos live in the UI, and these
 * two functions are the only place the two representations meet.
 *
 * Mirrored by web/src/lib/largeExpenseThreshold.ts, deliberately rather than
 * shared — the two apps have no build-time relationship, the same reason
 * fieldLimits.ts is duplicated.
 */

/** The server's own column default, and what we fall back to when no percentage can be derived. */
export const DEFAULT_THRESHOLD_PERCENT = 20;

/** Matches the API's `z.number().positive().max(999.99)` in businessProfile.controller.ts. */
const MIN_PERCENT = 0.01;
const MAX_PERCENT = 999.99;

/**
 * The peso amount a given percentage works out to.
 *
 * Rounded to whole pesos: this is a number an owner reads and retypes, and
 * "PHP 99,999.99999" would be noise. Sub-peso precision is meaningless for a
 * threshold whose entire job is to be a rough cutoff.
 */
export function thresholdPercentToPesos(expectedMonthlyExpenses: number, percent: number): number {
  if (!Number.isFinite(expectedMonthlyExpenses) || !Number.isFinite(percent)) return 0;
  return Math.round(expectedMonthlyExpenses * (percent / 100));
}

/**
 * The percentage a given peso amount works out to, ready for the API.
 *
 * THE ZERO CASE IS THE INTERESTING ONE. A percentage of zero expected monthly
 * expenses is undefined — there is no share of nothing — and the API rejects
 * anything <= 0, so an owner who has not filled in their monthly expenses yet
 * would otherwise get a validation error pointing at a field they never saw.
 * Falling back to the column default keeps them moving; the moment they enter
 * real expenses, the amount recomputes from that default.
 *
 * The result is clamped rather than rejected for the same reason: a threshold
 * larger than ten times monthly expenses is a strange choice, but it is a
 * survivable one, and it must not be the thing that blocks someone from
 * finishing setup.
 */
export function thresholdPesosToPercent(expectedMonthlyExpenses: number, pesos: number): number {
  if (!Number.isFinite(expectedMonthlyExpenses) || expectedMonthlyExpenses <= 0) {
    return DEFAULT_THRESHOLD_PERCENT;
  }
  if (!Number.isFinite(pesos) || pesos <= 0) return DEFAULT_THRESHOLD_PERCENT;

  const percent = (pesos / expectedMonthlyExpenses) * 100;
  const clamped = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
  // Two decimals is exactly what the column holds — Decimal(5, 2). Rounding
  // here rather than letting Postgres do it means the value read back is the
  // value that was sent, so a reopened form shows the same amount.
  return Math.round(clamped * 100) / 100;
}
