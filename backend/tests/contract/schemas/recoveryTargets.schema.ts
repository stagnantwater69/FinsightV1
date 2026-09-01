import { z } from "zod";

/**
 * Shared schema fragments for the Recovery Target contract tests
 * (recoveryInsightContract.test.ts, recoveryScenarioContract.test.ts).
 *
 * Deliberately a plain (non-`.test.ts`) module: importing one `.test.ts`
 * file from another would re-register — and re-run — its `describe`/`it`
 * blocks as a side effect of the module import, which is not what either
 * contract test wants. This file has no tests of its own, only schemas.
 *
 * Mirrors analysis.service.ts's `RecoveryStatus` / `RecoveryConfidence` /
 * `RecoveryTargets` and insights.service.ts's `RecoveryScenarioDelta`
 * verbatim — see those files for the source of truth. Re-verify field
 * names/types against the live source before editing this file; do not
 * guess from a prior review's notes.
 */

// Mirrors RecoveryStatus in analysis.service.ts verbatim. data_incomplete is
// listed (never emitted as of Phase 4, but the type permits it — this schema
// should not need to change the day it starts being emitted).
export const statusSchema = z.enum([
  "needs_setup",
  "no_current_month_data",
  "data_incomplete",
  "ahead",
  "on_pace",
  "behind",
  "covered",
]);

export const confidenceSchema = z.enum(["unavailable", "limited", "moderate", "strong"]);

// Mirrors RecoveryCheckpointStatus in analysis.service.ts verbatim (plan
// §10.4, Phase 4).
export const recoveryCheckpointStatusSchema = z.enum(["ahead", "on_pace", "behind", "pending"]);

// Full shape, not passthrough — closes finding 5 of the Phase 4 QA follow-up
// (docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md): `weeklyCheckpoints` previously
// rode through unchecked under recoveryInsightContract.test.ts's top-level
// `.passthrough()`.
export const recoveryCheckpointSchema = z
  .object({
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cumulativeTarget: z.number().finite(),
    recordedAmount: z.union([z.number().finite(), z.null()]),
    variance: z.union([z.number().finite(), z.null()]),
    status: recoveryCheckpointStatusSchema,
  })
  .strict();

export const changeReasonSchema = z.enum([
  "sales_added",
  "open_day_elapsed",
  "baseline_changed",
  "schedule_changed",
  "data_changed",
  "no_material_change",
]);

// Full shape, not passthrough — this is exactly what finding 7 of the Phase 3
// QA review flagged as unchecked. `.strict()` so an added/removed/renamed
// field here fails loudly instead of silently passing through.
export const changeSincePreviousDaySchema = z
  .object({
    adjustedDailyTargetDelta: z.number().finite(),
    salesAdded: z.number().finite(),
    remainingOpenDaysDelta: z.number().finite(),
    primaryReason: changeReasonSchema,
  })
  .strict();

/**
 * Full `RecoveryTargets` shape (analysis.service.ts), `.strict()`. Used by
 * both contract test files: recoveryInsightContract.test.ts's
 * `GET /insights/recovery` response is `RecoveryTargets` plus several
 * endpoint-only additions (`monthStart`, `today`, `coverageDays`,
 * `dailyCoverage`, `monthHasNoRecords`, `latestSaleDate`, `computedAt`,
 * `changeSincePreviousDay`, `weeklyCheckpoints` — kept on that file's own
 * `.passthrough()`-based schema rather than duplicated here), and
 * recoveryScenarioContract.test.ts's `current`/`hypothetical` fields are
 * exactly this shape with nothing added.
 */
export const recoveryTargetsSchema = z
  .object({
    expectedMonthlyExpenses: z.number().finite(),
    operatingDays: z.number().finite(),
    dailyNeededTarget: z.number().finite(),
    salesThisMonth: z.number().finite(),
    remainingTarget: z.number().finite(),
    daysInMonth: z.number().finite(),
    calendarDaysLeftInMonth: z.number().finite(),
    remainingOperatingDays: z.number().finite(),
    remainingOperatingDaysIsApproximated: z.boolean(),
    adjustedDailyTarget: z.number().finite(),
    todaysTarget: z.number().finite(),
    todaysSales: z.number().finite(),
    todaysGap: z.number().finite(),
    todaysStatus: z.enum(["above", "at", "below"]),
    monthCoveragePercent: z.number().finite(),
    onTrack: z.boolean(),
    needsSetup: z.boolean(),
    status: statusSchema,
    confidence: confidenceSchema,
    expectedSalesToDate: z.number().finite(),
    paceVarianceAmount: z.number().finite(),
    contractVersion: z.literal(1),
    timezone: z.string().min(1),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    operatingScheduleConfigured: z.boolean(),
    operatingDaysThisMonth: z.number().finite(),
    confirmedSalesThisMonth: z.number().finite(),
    provisionalSalesThisMonth: z.number().finite(),
    dataWarnings: z.array(z.enum(["records_pending_review", "possible_duplicates"])),
    setupIssues: z.array(z.enum(["expected_expenses_missing", "operating_schedule_missing"])),
  })
  .strict();

// Mirrors RecoveryScenarioDelta in insights.service.ts verbatim (plan §8.4/
// §9.9, Phase 4).
export const recoveryScenarioDeltaSchema = z
  .object({
    totalCoverageGoal: z.number().finite(),
    remainingTarget: z.number().finite(),
    adjustedDailyTarget: z.number().finite(),
    estimatedTransactionsPerDay: z.null(),
    estimatedTransactionsPerDayUnavailableReason: z.literal("transaction_provenance_unknown"),
  })
  .strict();
