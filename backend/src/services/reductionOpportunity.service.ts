import { AnomalyFindingStatus, AnomalyFindingType, ReductionOpportunityFeedbackRating } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import { utcAddDays, utcDateKey, utcEndOfDay, utcToday } from "../lib/dates";
import { getExpenseBehavior } from "./insights.service";

/**
 * Expense Reduction Opportunities — deterministic detection engine.
 *
 * See docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md §6–§9 for the approved
 * design. This file implements exactly that plan: no AI involvement, no
 * record mutation, no reimplementation of the statistical anomaly detectors
 * already owned by `anomalyDetection/*`.
 *
 * ARCHITECTURE. `getReductionOpportunities` is the only DB-touching export —
 * it fetches the bounded inputs (one `getExpenseBehavior` call, one bounded
 * current-period record read, one previous-period count, one bounded
 * duplicate-finding read) and hands them to `computeReductionOpportunities`,
 * a pure function. Keeping the rules pure is what makes them unit-testable
 * without a database — see tests/unit/reductionOpportunity.test.ts.
 */

// ============================================================
// Types — §8.2 of the plan, verbatim
// ============================================================

export type ReductionOpportunityType = "CATEGORY_PRESSURE" | "FREQUENT_PURCHASE_ACCUMULATION" | "RECORD_REVIEW_FIRST";

export interface ReductionOpportunityEvidence {
  currentAmount: number;
  previousAmount: number | null;
  changeAmount: number | null;
  changePercent: number | null;
  expenseSharePercent: number;
  recordCount: number;
  unusualRecordCount: number;
  possibleDuplicateCount: number;
}

export type ExpenseCostBehaviorApi = "fixed" | "variable" | "mixed" | "unclassified";

export interface ReductionOpportunity {
  id: string;
  type: ReductionOpportunityType;
  categoryId: number;
  categoryName: string;
  priority: "high" | "medium" | "low";
  confidence: "strong" | "moderate" | "limited";
  observation: string;
  rationale: string;
  evidence: ReductionOpportunityEvidence;
  // [ADDED] Plan §5.2/§15 Phase 5 — the category's owner-controlled
  // cost-behavior classification (lowercased, matching the API convention
  // elsewhere in this response — see `id` below). Evidence/copy only, per the
  // task: it must never change eligibility or ranking (§4.2 "review, not
  // verdict").
  costBehavior: ExpenseCostBehaviorApi;
  suggestedChecks: string[];
  relatedRecordIds: number[];
  limitations: string[];
}

export interface ReductionOpportunityResponse {
  period: {
    days: number;
    start: string;
    end: string;
  };
  dataQuality: {
    status: "sufficient" | "limited" | "insufficient";
    currentRecordCount: number;
    previousRecordCount: number;
    message: string | null;
  };
  opportunities: ReductionOpportunity[];
  detectorVersion: string;
}

// ============================================================
// Configuration — §7.1. Centralized and named; nothing below this point
// should read a bare numeric literal for a threshold.
//
// THESE ARE CALIBRATION DEFAULTS, not tuned constants. The plan is explicit
// that they must be validated against seeded/UAT data before release — see
// §7.1 and §15 Phase 0. Changing any of them is a behavior change and must
// be called out, not slipped into an unrelated edit.
// ============================================================

export interface ReductionOpportunityConfig {
  /** Recommended default window; the caller (controller) owns the actual default/validation. */
  periodDays: number;
  maxOpportunities: number;
  maxRelatedRecordIds: number;
  minimumHistoryRecords: number;
  highSharePercent: number;
  meaningfulIncreasePercent: number;
  minimumMaterialAmount: number;
  expectedExpenseMaterialityFraction: number;
  frequentPurchaseMinimumCount: number;
  frequentCategorySharePercent: number;
}

export const DEFAULT_REDUCTION_OPPORTUNITY_CONFIG: Readonly<ReductionOpportunityConfig> = Object.freeze({
  periodDays: 30,
  maxOpportunities: 3,
  maxRelatedRecordIds: 10,
  minimumHistoryRecords: 3,
  highSharePercent: 20,
  meaningfulIncreasePercent: 20,
  minimumMaterialAmount: 500,
  expectedExpenseMaterialityFraction: 0.02,
  frequentPurchaseMinimumCount: 5,
  frequentCategorySharePercent: 10,
});

/**
 * The dominance boundary from §7.2: a single record contributing this much
 * (or more) of its category's current-period total is better explained as
 * one unusual purchase than as an accumulation pattern, so it disqualifies
 * `FREQUENT_PURCHASE_ACCUMULATION` for that category. Named and tested per
 * the plan's explicit instruction — see
 * tests/unit/reductionOpportunity.test.ts.
 */
export const DOMINANT_RECORD_SHARE_PERCENT = 50;

export const REDUCTION_OPPORTUNITY_DETECTOR_VERSION = "reduction-opportunity-v1";

/**
 * The effective materiality floor — §7.1. Prevents a tiny category with a
 * dramatic percentage from outranking a financially meaningful one.
 */
export function materialityFloor(expectedMonthlyExpenses: number, config: ReductionOpportunityConfig): number {
  return Math.max(config.minimumMaterialAmount, expectedMonthlyExpenses * config.expectedExpenseMaterialityFraction);
}

// ============================================================
// Controlled suggested-check catalogue — §9.4. Plain lookup, never
// AI-generated, copy stays a review checklist (§4.2).
// ============================================================

export const SUGGESTED_CHECK_CATALOGUE: Readonly<Record<ReductionOpportunityType, readonly string[]>> = Object.freeze({
  CATEGORY_PRESSURE: Object.freeze([
    "Review the records contributing most to this category.",
    "Check whether the increase came from a one-time need or a repeating change.",
    "Compare the category with the previous equivalent period.",
  ]),
  FREQUENT_PURCHASE_ACCUMULATION: Object.freeze([
    "Check whether repeated purchases include duplicated fees or avoidable repeat trips.",
    "Review whether ordering frequency matches how quickly the items are used.",
    "Confirm that repeated records were not entered more than once.",
  ]),
  RECORD_REVIEW_FIRST: Object.freeze([
    "Verify the flagged records before planning any reduction.",
    "Confirm the date, amount, category, and source.",
    "Resolve possible duplicates through the existing review workflow.",
  ]),
});

/**
 * [ADDED] Plan §5.2/§15 Phase 5 — cost-behavior-aware additions to the
 * suggested-check catalogue. Plain lookup keyed by the category's
 * owner-controlled `costBehavior`, appended to (never replacing) the
 * type-based catalogue above. `UNCLASSIFIED` intentionally adds nothing —
 * current default behavior is unchanged for the large majority of categories
 * that have not been classified. Copy is deliberately "review"-framed, never
 * "cut"/"stop" language, per §4.2.
 */
export const COST_BEHAVIOR_SUGGESTED_CHECK_CATALOGUE: Readonly<Record<ExpenseCostBehaviorApi, readonly string[]>> = Object.freeze({
  fixed: Object.freeze(["Review the contract terms or continued need for this fixed cost."]),
  variable: Object.freeze([]),
  mixed: Object.freeze(["Consider separating the fixed and usage-dependent portions of this expense before deciding what to review."]),
  unclassified: Object.freeze([]),
});

// ============================================================
// Pure detection/ranking core
// ============================================================

interface CategoryTrendInput {
  categoryId: number;
  categoryName: string;
  current: number;
  previous: number;
  /** Same convention as `getExpenseBehavior`: null when there is no previous baseline. */
  percentChange: number | null;
  recordCount: number;
  /**
   * [ADDED] §5.2/§15 Phase 5 — evidence/copy only, see
   * `ReductionOpportunity.costBehavior`. Optional (defaults to
   * "unclassified") so existing callers/tests that predate this field keep
   * compiling and behaving exactly as before.
   */
  costBehavior?: ExpenseCostBehaviorApi;
}

interface RecordAmountInput {
  id: number;
  categoryId: number;
  amount: number;
}

interface DuplicateFindingInput {
  expenseRecordId: number;
  categoryId: number;
  amount: number;
}

export interface ReductionOpportunityComputationInput {
  /** Total current-period expenses across all categories — the share denominator. */
  totalCurrent: number;
  expectedMonthlyExpenses: number;
  categoryTrends: CategoryTrendInput[];
  /** Current-period expense records, id/categoryId/amount only. */
  currentRecords: RecordAmountInput[];
  /** Current-period unusual-expense candidates, from `getExpenseBehavior`. */
  unusualExpenses: RecordAmountInput[];
  /** Unresolved (OPEN) possible-duplicate findings whose record falls in the current period. */
  duplicateFindings: DuplicateFindingInput[];
}

function median(sortedAmounts: number[]): number {
  if (sortedAmounts.length === 0) return 0;
  const middle = Math.floor(sortedAmounts.length / 2);
  return sortedAmounts.length % 2 === 0
    ? (sortedAmounts[middle - 1]! + sortedAmounts[middle]!) / 2
    : sortedAmounts[middle]!;
}

function boundedRelatedRecordIds(records: RecordAmountInput[], config: ReductionOpportunityConfig): number[] {
  return [...records]
    .sort((a, b) => (b.amount - a.amount) || (a.id - b.id))
    .slice(0, config.maxRelatedRecordIds)
    .map((r) => r.id);
}

interface CategorySignals {
  categoryId: number;
  categoryName: string;
  current: number;
  previous: number;
  percentChange: number | null;
  recordCount: number;
  share: number;
  records: RecordAmountInput[];
  unusualRecords: RecordAmountInput[];
  duplicateRecords: DuplicateFindingInput[];
  costBehavior: ExpenseCostBehaviorApi;
}

/**
 * [ADDED] §5.2/§15 Phase 5 — appends the cost-behavior-aware entries (if any)
 * to a type's base suggested checks. Plain lookup concatenation, same
 * conservative-additive contract as the rest of this catalogue.
 */
function suggestedChecksFor(type: ReductionOpportunityType, costBehavior: ExpenseCostBehaviorApi): string[] {
  return [...SUGGESTED_CHECK_CATALOGUE[type], ...COST_BEHAVIOR_SUGGESTED_CHECK_CATALOGUE[costBehavior]];
}

/**
 * One category, one opportunity at most — §4.6/§6.1's "combine signals,
 * don't duplicate cards" rule, generalized across all three types.
 *
 * Precedence, most important first (this is the "dominance-boundary
 * routing" the plan requires — §7.2/§14.1's "one dominant record routes
 * evidence toward record review rather than frequent accumulation"):
 *
 *   1. RECORD_REVIEW_FIRST  — data correctness first (§7.3 ranking rule 1).
 *   2. CATEGORY_PRESSURE    — share and/or increase.
 *   3. FREQUENT_PURCHASE_ACCUMULATION — accumulation, only once the above
 *      don't apply, and only when no single record dominates the category
 *      (§7.2's named dominance boundary).
 *
 * A category that clears none of these produces no opportunity. That is an
 * accepted outcome, not a bug — e.g. one dominant, materially large record
 * that is NOT flagged as unusual/duplicate and doesn't independently cross
 * the category-pressure thresholds. See the explicit test for this case.
 */
function buildOpportunityForCategory(
  signals: CategorySignals,
  floor: number,
  config: ReductionOpportunityConfig,
): Omit<ReductionOpportunity, "id" | "priority"> | null {
  const { categoryId, categoryName, current, previous, percentChange, recordCount, share, records, unusualRecords, duplicateRecords, costBehavior } = signals;

  const evidenceBase: ReductionOpportunityEvidence = {
    currentAmount: current,
    previousAmount: previous > 0 ? previous : null,
    changeAmount: previous > 0 ? current - previous : null,
    changePercent: previous > 0 ? percentChange : null,
    expenseSharePercent: share,
    recordCount,
    unusualRecordCount: unusualRecords.length,
    possibleDuplicateCount: duplicateRecords.length,
  };

  // ---- 1. RECORD_REVIEW_FIRST -------------------------------------------
  const flaggedRecordIds = new Set<number>([...unusualRecords.map((r) => r.id), ...duplicateRecords.map((r) => r.expenseRecordId)]);
  const flaggedAmountById = new Map<number, number>();
  for (const r of unusualRecords) flaggedAmountById.set(r.id, r.amount);
  for (const r of duplicateRecords) flaggedAmountById.set(r.expenseRecordId, r.amount);
  const flaggedAmount = [...flaggedAmountById.values()].reduce((s, v) => s + v, 0);

  const recordReviewEligible = flaggedRecordIds.size > 0 && flaggedAmount >= floor;

  if (recordReviewEligible) {
    const signalCount = (unusualRecords.length > 0 ? 1 : 0) + (duplicateRecords.length > 0 ? 1 : 0);
    const hasEnoughHistory = recordCount >= config.minimumHistoryRecords;
    const confidence: ReductionOpportunity["confidence"] = !hasEnoughHistory
      ? "limited"
      : signalCount > 1
        ? "strong"
        : "moderate";

    const parts: string[] = [];
    if (duplicateRecords.length > 0) parts.push(`${duplicateRecords.length} unresolved possible duplicate${duplicateRecords.length === 1 ? "" : "s"}`);
    if (unusualRecords.length > 0) parts.push(`${unusualRecords.length} unusual record${unusualRecords.length === 1 ? "" : "s"}`);

    const relatedIds = boundedRelatedRecordIds(
      records.filter((r) => flaggedRecordIds.has(r.id)),
      config,
    );

    return {
      type: "RECORD_REVIEW_FIRST",
      categoryId,
      categoryName,
      confidence,
      observation: `${categoryName} has ${parts.join(" and ")} materially contributing to this period's total.`,
      rationale: "Flagged records may affect the actual figures for this category, so verifying them comes before considering any spending change.",
      evidence: evidenceBase,
      costBehavior,
      suggestedChecks: suggestedChecksFor("RECORD_REVIEW_FIRST", costBehavior),
      relatedRecordIds: relatedIds,
      limitations: [
        "Flagged records may turn out to be correct — verify before assuming an error.",
        ...(previous === 0 ? ["No previous-period data is available for this category yet."] : []),
      ],
    };
  }

  // ---- 2. CATEGORY_PRESSURE ---------------------------------------------
  const shareCondition = share >= config.highSharePercent;
  const changeAmount = previous > 0 ? current - previous : null;
  const increaseCondition =
    previous > 0 && changeAmount !== null && changeAmount >= floor && percentChange !== null && percentChange >= config.meaningfulIncreasePercent;
  const isNewCategory = previous === 0 && current > 0;

  const categoryPressureEligible = current >= floor && (shareCondition || increaseCondition);

  if (categoryPressureEligible) {
    const signalCount = (shareCondition ? 1 : 0) + (increaseCondition ? 1 : 0);
    const confidence: ReductionOpportunity["confidence"] = isNewCategory ? "limited" : signalCount > 1 ? "strong" : "moderate";

    const reasons: string[] = [];
    if (isNewCategory && shareCondition) {
      // §7.2: "A new category must never be described as an increase from zero."
      reasons.push(`is new this period and already makes up ${share.toFixed(1)}% of expenses`);
    } else {
      if (shareCondition) reasons.push(`makes up ${share.toFixed(1)}% of this period's expenses`);
      if (increaseCondition) reasons.push(`increased ${(percentChange as number).toFixed(1)}% versus the previous period`);
    }

    const relatedIds = boundedRelatedRecordIds(records, config);

    return {
      type: "CATEGORY_PRESSURE",
      categoryId,
      categoryName,
      confidence,
      observation: `${categoryName} ${reasons.join(" and ")}.`,
      rationale: "Worth reviewing: a high share of spend, a material increase, or both, can point to a category worth a closer look.",
      evidence: evidenceBase,
      costBehavior,
      suggestedChecks: suggestedChecksFor("CATEGORY_PRESSURE", costBehavior),
      relatedRecordIds: relatedIds,
      limitations: [
        "A large or growing category can still be necessary for the business.",
        ...(isNewCategory ? ["No previous-period data is available for this category yet."] : []),
      ],
    };
  }

  // ---- 3. FREQUENT_PURCHASE_ACCUMULATION ---------------------------------
  const dominantAmount = records.reduce((max, r) => Math.max(max, r.amount), 0);
  const dominantSharePercent = current > 0 ? (dominantAmount / current) * 100 : 0;
  const dominanceDisqualifies = dominantSharePercent >= DOMINANT_RECORD_SHARE_PERCENT;

  const frequentEligible =
    recordCount >= config.frequentPurchaseMinimumCount &&
    current >= floor &&
    share >= config.frequentCategorySharePercent &&
    !dominanceDisqualifies;

  if (frequentEligible) {
    const medianAmount = median([...records.map((r) => r.amount)].sort((a, b) => a - b));
    // Also independently eligible for category pressure? Then this category has
    // more than one supporting signal even though we surface it as the
    // accumulation card (one card per category — §4.6).
    const confidence: ReductionOpportunity["confidence"] = isNewCategory
      ? "limited"
      : shareCondition || increaseCondition
        ? "strong"
        : "moderate";

    const relatedIds = boundedRelatedRecordIds(records, config);

    return {
      type: "FREQUENT_PURCHASE_ACCUMULATION",
      categoryId,
      categoryName,
      confidence,
      observation: `${categoryName} accumulated ${recordCount} purchases this period, with a typical record around ${medianAmount.toFixed(2)}.`,
      rationale: "Many individually modest records can add up to a material total — worth checking ordering frequency, consolidation, and repeated fees.",
      evidence: evidenceBase,
      costBehavior,
      suggestedChecks: suggestedChecksFor("FREQUENT_PURCHASE_ACCUMULATION", costBehavior),
      relatedRecordIds: relatedIds,
      limitations: ["Frequent purchases are not automatically wasteful — review before making changes."],
    };
  }

  return null;
}

/**
 * Ranking — §7.3, a lexicographic comparator (deliberately not a numeric
 * score, per the plan's explicit preference for something easy to test and
 * explain).
 *
 *   1. RECORD_REVIEW_FIRST with possible duplicates first.
 *   2. Larger absolute peso materiality (current-period category amount).
 *   3. More supporting signals.
 *   4. Stronger confidence.
 *   5. Stable category ID, ascending, as the final tie-breaker.
 */
function compareOpportunities(
  a: { type: ReductionOpportunityType; evidence: ReductionOpportunityEvidence; confidence: ReductionOpportunity["confidence"]; categoryId: number },
  b: { type: ReductionOpportunityType; evidence: ReductionOpportunityEvidence; confidence: ReductionOpportunity["confidence"]; categoryId: number },
): number {
  const rankDuplicateReview = (o: typeof a) => (o.type === "RECORD_REVIEW_FIRST" && o.evidence.possibleDuplicateCount > 0 ? 1 : 0);
  const dupDiff = rankDuplicateReview(b) - rankDuplicateReview(a);
  if (dupDiff !== 0) return dupDiff;

  const materialityDiff = b.evidence.currentAmount - a.evidence.currentAmount;
  if (materialityDiff !== 0) return materialityDiff;

  const signalCount = (o: typeof a) => o.evidence.unusualRecordCount + o.evidence.possibleDuplicateCount + (o.evidence.previousAmount !== null ? 1 : 0);
  const signalDiff = signalCount(b) - signalCount(a);
  if (signalDiff !== 0) return signalDiff;

  const confidenceRank = { strong: 2, moderate: 1, limited: 0 } as const;
  const confidenceDiff = confidenceRank[b.confidence] - confidenceRank[a.confidence];
  if (confidenceDiff !== 0) return confidenceDiff;

  return a.categoryId - b.categoryId;
}

const PRIORITY_BY_RANK: ReductionOpportunity["priority"][] = ["high", "medium", "low"];

/**
 * The pure detection/ranking core. Everything DB-shaped stops at the caller
 * (`getReductionOpportunities`); this function only does arithmetic and
 * array operations, which is what makes it unit-testable without a database.
 */
export function computeReductionOpportunities(
  input: ReductionOpportunityComputationInput,
  periodEndKey: string,
  config: ReductionOpportunityConfig = DEFAULT_REDUCTION_OPPORTUNITY_CONFIG,
): ReductionOpportunity[] {
  const floor = materialityFloor(input.expectedMonthlyExpenses, config);

  const recordsByCategory = new Map<number, RecordAmountInput[]>();
  for (const r of input.currentRecords) {
    const list = recordsByCategory.get(r.categoryId) ?? [];
    list.push(r);
    recordsByCategory.set(r.categoryId, list);
  }
  const unusualByCategory = new Map<number, RecordAmountInput[]>();
  for (const r of input.unusualExpenses) {
    const list = unusualByCategory.get(r.categoryId) ?? [];
    list.push(r);
    unusualByCategory.set(r.categoryId, list);
  }
  const duplicatesByCategory = new Map<number, DuplicateFindingInput[]>();
  for (const r of input.duplicateFindings) {
    const list = duplicatesByCategory.get(r.categoryId) ?? [];
    list.push(r);
    duplicatesByCategory.set(r.categoryId, list);
  }

  const built: Omit<ReductionOpportunity, "id" | "priority">[] = [];

  for (const trend of input.categoryTrends) {
    if (trend.current <= 0) continue; // no current-period spend, nothing to review

    const share = input.totalCurrent > 0 ? (trend.current / input.totalCurrent) * 100 : 0;

    const opportunity = buildOpportunityForCategory(
      {
        categoryId: trend.categoryId,
        categoryName: trend.categoryName,
        current: trend.current,
        previous: trend.previous,
        percentChange: trend.percentChange,
        recordCount: trend.recordCount,
        share,
        records: recordsByCategory.get(trend.categoryId) ?? [],
        unusualRecords: unusualByCategory.get(trend.categoryId) ?? [],
        duplicateRecords: duplicatesByCategory.get(trend.categoryId) ?? [],
        costBehavior: trend.costBehavior ?? "unclassified",
      },
      floor,
      config,
    );

    if (opportunity) built.push(opportunity);
  }

  built.sort(compareOpportunities);

  return built.slice(0, config.maxOpportunities).map((o, index) => ({
    ...o,
    id: `${o.type.toLowerCase()}-${o.categoryId}-${periodEndKey}`,
    priority: PRIORITY_BY_RANK[index] ?? "low",
  }));
}

// ============================================================
// DB-touching entry point
// ============================================================

export async function getReductionOpportunities(
  userId: number,
  businessProfileId: number,
  periodDays: number,
  endDate?: Date,
  config: ReductionOpportunityConfig = DEFAULT_REDUCTION_OPPORTUNITY_CONFIG,
): Promise<ReductionOpportunityResponse> {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = endDate ?? utcToday();
  const periodStart = utcAddDays(today, -(periodDays - 1));
  const previousPeriodEnd = utcAddDays(periodStart, -1);
  const previousPeriodStart = utcAddDays(previousPeriodEnd, -(periodDays - 1));
  const endOfToday = utcEndOfDay(today);

  const [behavior, currentRecords, previousRecordCount, duplicateFindings] = await Promise.all([
    // Reused, not reimplemented: category totals/trends/counts and the
    // existing unusual-expense detector both come from here (§9.3/§3.3).
    getExpenseBehavior(userId, businessProfileId, periodDays, endDate),
    prisma.expenseRecord.findMany({
      where: { businessProfileId, date: { gte: periodStart, lte: endOfToday } },
      select: { id: true, categoryId: true, amount: true },
    }),
    prisma.expenseRecord.count({
      where: { businessProfileId, date: { gte: previousPeriodStart, lte: previousPeriodEnd } },
    }),
    // Existing near-duplicate findings, not a new detector (§6.1.C/§9.3).
    // SHADOW findings are excluded implicitly — this only asks for OPEN.
    prisma.anomalyFinding.findMany({
      where: {
        businessProfileId,
        type: AnomalyFindingType.POSSIBLE_DUPLICATE,
        status: AnomalyFindingStatus.OPEN,
        expenseRecord: { date: { gte: periodStart, lte: endOfToday } },
      },
      select: { expenseRecordId: true, expenseRecord: { select: { categoryId: true, amount: true } } },
    }),
  ]);

  const currentRecordCount = currentRecords.length;

  const currentRecordInputs = currentRecords.map((r) => ({ id: r.id, categoryId: r.categoryId, amount: Number(r.amount) }));
  const unusualExpenseInputs = behavior.unusualExpenses.map((u) => ({ id: u.id, categoryId: u.categoryId, amount: u.amount }));
  const duplicateFindingInputs = duplicateFindings
    .filter((f): f is typeof f & { expenseRecordId: number; expenseRecord: NonNullable<(typeof f)["expenseRecord"]> } => f.expenseRecordId !== null && f.expenseRecord !== null)
    .map((f) => ({ expenseRecordId: f.expenseRecordId, categoryId: f.expenseRecord.categoryId, amount: Number(f.expenseRecord.amount) }));

  // Conservative sparse-data behavior — §4.5/§8.3. Below the configured
  // minimum, we do not attempt detection at all rather than produce
  // low-confidence noise from a handful of records.
  let dataQualityStatus: ReductionOpportunityResponse["dataQuality"]["status"];
  let message: string | null;
  if (currentRecordCount === 0) {
    dataQualityStatus = "insufficient";
    message = "No expense records were found in this period, so no opportunities can be identified yet.";
  } else if (currentRecordCount < config.minimumHistoryRecords) {
    dataQualityStatus = "insufficient";
    message = `Fewer than ${config.minimumHistoryRecords} expense records were found in this period — add more records to enable opportunity detection.`;
  } else if (previousRecordCount === 0) {
    dataQualityStatus = "limited";
    message = "No records were found in the previous equivalent period, so trend-based comparisons are limited to this period's activity.";
  } else {
    dataQualityStatus = "sufficient";
    message = null;
  }

  const opportunities =
    dataQualityStatus === "insufficient"
      ? []
      : computeReductionOpportunities(
          {
            totalCurrent: behavior.totals.current,
            expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses),
            categoryTrends: behavior.categoryTrends.map((t) => ({
              categoryId: t.categoryId,
              categoryName: t.categoryName,
              current: t.current,
              previous: t.previous,
              percentChange: t.percentChange,
              recordCount: t.recordCount,
              costBehavior: t.costBehavior,
            })),
            currentRecords: currentRecordInputs,
            unusualExpenses: unusualExpenseInputs,
            duplicateFindings: duplicateFindingInputs,
          },
          utcDateKey(today),
          config,
        );

  return {
    period: {
      days: periodDays,
      start: utcDateKey(periodStart),
      end: utcDateKey(today),
    },
    dataQuality: {
      status: dataQualityStatus,
      currentRecordCount,
      previousRecordCount,
      message,
    },
    opportunities,
    detectorVersion: REDUCTION_OPPORTUNITY_DETECTOR_VERSION,
  };
}

// ============================================================
// Reduction simulation — Phase 4 / §12 of the plan.
//
// Deliberately a separate, non-persisting calculation, NOT an extension of
// the opportunity engine above (it does not read anomaly findings or trends)
// and NOT an extension of `simulateSpendingImpact` in insights.service.ts
// (that endpoint models a planned NEW purchase against Available Business
// Funds — a fundamentally different question from "what if this category's
// existing spend were lower"). See §12.1/§12.4: they are two distinct
// concepts and the plan is explicit that Spending Impact is not to be
// touched or redesigned as part of this work.
//
// INVARIANT (§12.1, restated because it is the one rule this file must never
// break): this calculation NEVER reads or writes `BusinessProfile.availableFunds`
// and never asserts that the hypothetical reduction actually occurred. It is
// pure "what would the recorded totals have looked like" arithmetic over the
// owner's own historical records for the period, nothing more.
// ============================================================

export type ReductionSpec = { kind: "percent"; value: number } | { kind: "amount"; value: number };

export interface ReductionSimulationInput {
  businessProfileId: number;
  categoryId: number;
  periodDays: number;
  endDate?: Date;
  reduction: ReductionSpec;
}

export interface ReductionSimulation {
  categoryId: number;
  categoryName: string;
  period: { days: number; start: string; end: string };
  categoryExpenses: { before: number; after: number };
  totalExpenses: { before: number; after: number };
  hypotheticalReduction: number;
  requestedReductionPercent: number;
  assumptions: string[];
}

/** Same rounding convention as the rest of this domain's money output — see insights.service.ts's `multipleOfTypical`. */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

const REDUCTION_SIMULATION_ASSUMPTIONS: readonly string[] = Object.freeze([
  "This is a hypothetical scenario for planning purposes only — no expense record is created, edited, or deleted.",
  "Available business funds are not changed by this simulation; recorded spending history is the only thing being recalculated.",
  "The reduction is modeled as a flat amount off the category's period total. Actual results depend on which purchases are avoided or reduced.",
]);

/**
 * The pure calculation core — §12.2/§12.3. No database access, so it is
 * unit-testable directly; see tests/unit/reductionSimulation.test.ts.
 *
 * Throws `ApiError(400, ...)` for every validation rule in §12.3. The
 * baseline (`categoryBefore`/`totalBefore`) is always derived server-side by
 * the caller from the owner's own records — this function never accepts a
 * client-supplied baseline, per §12.2's explicit rule.
 */
export function computeReductionSimulation(
  categoryBefore: number,
  totalBefore: number,
  reduction: ReductionSpec,
): Pick<ReductionSimulation, "categoryExpenses" | "totalExpenses" | "hypotheticalReduction" | "requestedReductionPercent" | "assumptions"> {
  if (reduction.kind === "percent") {
    if (!Number.isFinite(reduction.value) || reduction.value <= 0 || reduction.value > 100) {
      throw new ApiError(400, "reduction.value must be greater than 0 and no greater than 100 for a percent reduction");
    }
  } else {
    if (!Number.isFinite(reduction.value) || reduction.value <= 0) {
      throw new ApiError(400, "reduction.value must be greater than 0 for an amount reduction");
    }
  }

  // §12.3: "Zero baseline returns a validation error ... " — chosen over a
  // silent non-simulatable result so the client always gets an explicit,
  // actionable 400 rather than having to branch on a response field.
  if (!(categoryBefore > 0)) {
    throw new ApiError(400, "No expenses were recorded for this category in the selected period, so a reduction cannot be simulated.");
  }

  if (reduction.kind === "amount" && reduction.value > categoryBefore) {
    throw new ApiError(400, `reduction.value cannot exceed the category's period total of ${round2(categoryBefore)}`);
  }

  const rawReduction = reduction.kind === "percent" ? categoryBefore * (reduction.value / 100) : reduction.value;
  const hypotheticalReduction = round2(rawReduction);
  const categoryAfter = round2(Math.max(0, categoryBefore - hypotheticalReduction));
  const totalAfter = round2(Math.max(0, totalBefore - hypotheticalReduction));
  const requestedReductionPercent = round2((hypotheticalReduction / categoryBefore) * 100);

  return {
    categoryExpenses: { before: round2(categoryBefore), after: categoryAfter },
    totalExpenses: { before: round2(totalBefore), after: totalAfter },
    hypotheticalReduction,
    requestedReductionPercent,
    assumptions: [...REDUCTION_SIMULATION_ASSUMPTIONS],
  };
}

/**
 * DB-touching entry point. Fetches the category name (with ownership check)
 * and the period's actual category/total expense totals, then hands off to
 * the pure calculation above. Reads only — see
 * tests/integration/reductionSimulation.test.ts for the no-write assertions.
 */
export async function simulateReductionOpportunity(userId: number, input: ReductionSimulationInput): Promise<ReductionSimulation> {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);

  // Same ownership pattern as expenseRecord.service's `verifyCategoryBelongsToProfile`:
  // a foreign or nonexistent category id both fail this lookup identically.
  const category = await prisma.expenseCategory.findFirst({
    where: { id: input.categoryId, businessProfileId: input.businessProfileId },
  });
  if (!category) {
    throw new ApiError(400, "Category does not belong to this business profile");
  }

  const today = input.endDate ?? utcToday();
  const periodStart = utcAddDays(today, -(input.periodDays - 1));
  const endOfToday = utcEndOfDay(today);

  const [categoryAgg, totalAgg] = await Promise.all([
    prisma.expenseRecord.aggregate({
      where: { businessProfileId: input.businessProfileId, categoryId: input.categoryId, date: { gte: periodStart, lte: endOfToday } },
      _sum: { amount: true },
    }),
    prisma.expenseRecord.aggregate({
      where: { businessProfileId: input.businessProfileId, date: { gte: periodStart, lte: endOfToday } },
      _sum: { amount: true },
    }),
  ]);

  const categoryBefore = Number(categoryAgg._sum.amount ?? 0);
  const totalBefore = Number(totalAgg._sum.amount ?? 0);

  const computed = computeReductionSimulation(categoryBefore, totalBefore, input.reduction);

  return {
    categoryId: input.categoryId,
    categoryName: category.name,
    period: {
      days: input.periodDays,
      start: utcDateKey(periodStart),
      end: utcDateKey(today),
    },
    ...computed,
  };
}

// ============================================================
// Feedback — §15 Phase 5. "Helpful / not relevant" on a selected,
// server-produced opportunity card. Narrow, idempotent (upsert on the DB's
// unique constraint), and additive — it does not read or affect eligibility,
// ranking, or any of the engine above.
// ============================================================

/**
 * The exact id shape `computeReductionOpportunities` produces:
 * `${type.toLowerCase()}-${categoryId}-${periodEndKey}`, where `type` is one
 * of the three `ReductionOpportunityType` values (lowercased, underscores
 * kept) and `periodEndKey` is a `utcDateKey` (`YYYY-MM-DD`). Exported so
 * tests exercise the same pattern this function enforces, and so a future
 * caller (e.g. a controller-level pre-check) doesn't have to guess it.
 *
 * This is a format check, not a "does this opportunity currently exist"
 * check — opportunities are computed on request and never persisted, so a
 * legitimate feedback submission can arrive for an id from a prior response
 * that would not recompute identically today (e.g. the category's numbers
 * have since changed). The format check exists purely to stop this endpoint
 * being used to write arbitrary/unrelated feedback rows.
 */
export const REDUCTION_OPPORTUNITY_ID_PATTERN =
  /^(category_pressure|frequent_purchase_accumulation|record_review_first)-\d+-\d{4}-\d{2}-\d{2}$/;

export function isValidReductionOpportunityId(opportunityId: string): boolean {
  return REDUCTION_OPPORTUNITY_ID_PATTERN.test(opportunityId);
}

export type ReductionOpportunityFeedbackRatingApi = "helpful" | "not_relevant";

const FEEDBACK_RATING_TO_PRISMA: Readonly<Record<ReductionOpportunityFeedbackRatingApi, ReductionOpportunityFeedbackRating>> = Object.freeze({
  helpful: ReductionOpportunityFeedbackRating.HELPFUL,
  not_relevant: ReductionOpportunityFeedbackRating.NOT_RELEVANT,
});

export interface ReductionOpportunityFeedbackResult {
  opportunityId: string;
  rating: ReductionOpportunityFeedbackRatingApi;
  createdAt: Date;
}

/**
 * Upserts the caller's feedback on one opportunity card, scoped to the
 * caller's own owned business profile (§ ownership pattern shared with every
 * other export in this file). Resubmission (e.g. the owner changes their
 * mind) updates the existing row rather than creating a duplicate — that is
 * exactly what the DB's `[businessProfileId, opportunityId, userId]` unique
 * constraint is for.
 *
 * Deliberately does not attempt to recompute or verify that `opportunityId`
 * matches a *currently* eligible opportunity — see
 * `isValidReductionOpportunityId`'s doc comment for why that would be wrong
 * (opportunities are not persisted, so "currently recomputes" and
 * "legitimately was shown to this owner" are different questions). It only
 * rejects ids that could not possibly be a real opportunity id.
 */
export async function recordReductionOpportunityFeedback(
  userId: number,
  businessProfileId: number,
  opportunityId: string,
  rating: ReductionOpportunityFeedbackRatingApi,
): Promise<ReductionOpportunityFeedbackResult> {
  if (!isValidReductionOpportunityId(opportunityId)) {
    throw new ApiError(400, "opportunityId is not a recognized reduction-opportunity id");
  }

  const prismaRating = FEEDBACK_RATING_TO_PRISMA[rating];
  if (!prismaRating) {
    throw new ApiError(400, "rating must be 'helpful' or 'not_relevant'");
  }

  await requireOwnedBusinessProfile(userId, businessProfileId);

  const row = await prisma.reductionOpportunityFeedback.upsert({
    where: {
      businessProfileId_opportunityId_userId: { businessProfileId, opportunityId, userId },
    },
    create: { businessProfileId, opportunityId, userId, rating: prismaRating },
    update: { rating: prismaRating },
  });

  return {
    opportunityId: row.opportunityId,
    rating,
    createdAt: row.createdAt,
  };
}
