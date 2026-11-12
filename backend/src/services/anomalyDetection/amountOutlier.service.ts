import { AnomalyFindingFeedback, AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import {
  computeCategoryStats,
  computeQuartiles,
  detectionMethod,
  isHighSeverityAmount,
  isUnusualExpense,
  zScore,
  type CategoryQuartiles,
  type CategoryStats,
} from "../analysis.service";
import { loadBoundedCategoryHistoryForCategories } from "./categoryStatistics.service";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";
import { runAnalysisMutation, type AnalysisMutationGuard } from "./mutationGuard";

// v2: HIGH severity uses the median and MAD (isHighSeverityAmount), and the
// test tightens for a category the owner keeps calling normal.
export const AMOUNT_OUTLIER_VERSION = "amount-outlier-v2";
// Stays at v1 across versions: a new fingerprint would open a second finding
// beside the old one and bring back findings the owner already dismissed.
const FINGERPRINT_PREFIX = "amount-outlier-v1";

// A daily-refreshed summary can only stand in for the live query when the
// candidate is provably absent from it (the summary predates the record)
// and it's recent enough to still describe "now". Anything older, or dated
// far enough from the candidate's own transaction date to no longer
// approximate a window ending there (backdated entries), falls back to the
// exact leave-one-out computation below.
const MAX_CACHED_STATS_AGE_MS = 48 * 60 * 60_000;
const MAX_CACHED_WINDOW_DRIFT_DAYS = 3;

/**
 * OWNER FEEDBACK. When the owner keeps answering "this is normal for my
 * business" about a category's amount findings, the category's test goes up
 * one step: z from 2 to 3, and Tukey's "far out" fence of 3 IQRs instead of
 * 1.5. Read from the latest answered findings at detection time, so a fresh
 * "yes, this was unusual" undoes it without any stored state.
 */
const FEEDBACK_LOOKBACK = 5;
const FEEDBACK_MINIMUM_ANSWERS = 3;
const FEEDBACK_EXPECTED_SHARE = 2 / 3;
const STRICT_Z_SCORE_THRESHOLD = 3;
const STRICT_IQR_FENCE_MULTIPLIER = 3;

async function ownerFindsCategoryNormal(candidate: { id: number; businessProfileId: number; categoryId: number }) {
  const answers = await prisma.anomalyFinding.findMany({
    where: {
      businessProfileId: candidate.businessProfileId,
      method: "z-score-iqr",
      feedback: { in: [AnomalyFindingFeedback.CONFIRMED_UNUSUAL, AnomalyFindingFeedback.EXPECTED_TRANSACTION] },
      expenseRecordId: { not: candidate.id },
      expenseRecord: { categoryId: candidate.categoryId },
    },
    orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
    take: FEEDBACK_LOOKBACK,
    select: { feedback: true },
  });
  if (answers.length < FEEDBACK_MINIMUM_ANSWERS) return false;
  const expected = answers.filter((answer) => answer.feedback === AnomalyFindingFeedback.EXPECTED_TRANSACTION).length;
  return expected / answers.length >= FEEDBACK_EXPECTED_SHARE;
}

interface Baseline {
  stats: CategoryStats;
  quartiles: CategoryQuartiles;
}

async function loadCachedBaseline(
  candidate: { categoryId: number; createdAt: Date; date: Date },
  config: DetectionConfig,
): Promise<Baseline | null> {
  const cached = await prisma.categoryStatistics.findUnique({
    where: { categoryId_windowDays: { categoryId: candidate.categoryId, windowDays: config.baselineDays } },
  });
  if (!cached) return null;
  if (cached.recordCount + 1 < config.minimumCategoryHistory) return null;
  // Only safe when the candidate did not exist yet at calculation time —
  // otherwise it may already be baked into these aggregates.
  if (candidate.createdAt.getTime() <= cached.calculatedAt.getTime()) return null;
  if (Date.now() - cached.calculatedAt.getTime() > MAX_CACHED_STATS_AGE_MS) return null;
  const windowDriftDays = Math.abs(candidate.date.getTime() - cached.windowEnd.getTime()) / 86_400_000;
  if (windowDriftDays > MAX_CACHED_WINDOW_DRIFT_DAYS) return null;

  return {
    stats: { mean: Number(cached.mean), stdDev: Number(cached.standardDeviation), count: cached.recordCount },
    quartiles: { q1: Number(cached.q1), q3: Number(cached.q3), iqr: Number(cached.q3) - Number(cached.q1) },
  };
}

export async function detectAmountOutlierForExpense(
  expenseRecordId: number,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
  mutate: AnalysisMutationGuard = runAnalysisMutation,
) {
  if (!config.featureFlags.amountOutlier) return null;
  const candidate = await prisma.expenseRecord.findUnique({ where: { id: expenseRecordId }, include: { category: true } });
  if (!candidate) return null;
  const fingerprint = `${FINGERPRINT_PREFIX}:${candidate.id}`;
  const clear = () => mutate((db) => db.anomalyFinding.updateMany({
      where: { businessProfileId: candidate.businessProfileId, expenseRecordId: candidate.id, method: "z-score-iqr", status: AnomalyFindingStatus.OPEN },
      data: { status: AnomalyFindingStatus.SUPERSEDED },
    }));
  const loadAmounts = async () => (await loadBoundedCategoryHistoryForCategories(
    candidate.businessProfileId, candidate.date, [candidate.categoryId], config.baselineDays, config.maximumCategoryRecords,
  )).filter((record) => record.id !== candidate.id).map((record) => Number(record.amount));

  let amounts: number[] | null = null;
  let baseline = await loadCachedBaseline(candidate, config);
  if (!baseline) {
    amounts = await loadAmounts();
    if (amounts.length + 1 < config.minimumCategoryHistory) { await clear(); return null; }
    baseline = { stats: computeCategoryStats(amounts), quartiles: computeQuartiles(amounts) };
  }
  const { stats, quartiles } = baseline;
  const stricter = await ownerFindsCategoryNormal(candidate);
  const thresholds = {
    zScoreThreshold: stricter ? Math.max(config.zScoreThreshold, STRICT_Z_SCORE_THRESHOLD) : config.zScoreThreshold,
    iqrFenceMultiplier: stricter ? Math.max(config.iqrFenceMultiplier, STRICT_IQR_FENCE_MULTIPLIER) : config.iqrFenceMultiplier,
    minimumDeviationFraction: config.minimumDeviationFraction,
  };
  if (!isUnusualExpense(Number(candidate.amount), stats, quartiles, thresholds)) { await clear(); return null; }
  const z = zScore(Number(candidate.amount), stats);
  // The cached summary has no median or MAD; flagged records are few, so read them live.
  amounts ??= await loadAmounts();
  return mutate((db) => saveFinding({
    fingerprint, businessProfileId: candidate.businessProfileId, expenseRecordId: candidate.id,
    type: AnomalyFindingType.AMOUNT_OUTLIER,
    severity: isHighSeverityAmount(Number(candidate.amount), amounts) ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
    score: Math.min(Math.abs(z) / 4, 1), method: "z-score-iqr", title: `Unusual ${candidate.category.name} expense`,
    reasons: [`Detected by ${detectionMethod(Number(candidate.amount), stats, quartiles, thresholds)}`, `The category baseline average is ${stats.mean.toFixed(2)}`],
    metadata: { zScore: z, categoryMean: stats.mean, categoryStdDev: stats.stdDev, q1: quartiles.q1, q3: quartiles.q3, historyCount: stats.count, stricterAfterFeedback: stricter },
    detectorVersion: AMOUNT_OUTLIER_VERSION,
  }, db));
}
