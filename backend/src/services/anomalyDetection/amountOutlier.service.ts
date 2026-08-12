import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import {
  computeCategoryStats,
  computeQuartiles,
  detectionMethod,
  isUnusualExpense,
  zScore,
  type CategoryQuartiles,
  type CategoryStats,
} from "../analysis.service";
import { loadBoundedCategoryHistory } from "./categoryStatistics.service";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";

export const AMOUNT_OUTLIER_VERSION = "amount-outlier-v1";

// A daily-refreshed summary can only stand in for the live query when the
// candidate is provably absent from it (the summary predates the record)
// and it's recent enough to still describe "now". Anything older, or dated
// far enough from the candidate's own transaction date to no longer
// approximate a window ending there (backdated entries), falls back to the
// exact leave-one-out computation below.
const MAX_CACHED_STATS_AGE_MS = 48 * 60 * 60_000;
const MAX_CACHED_WINDOW_DRIFT_DAYS = 3;

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

export async function detectAmountOutlierForExpense(expenseRecordId: number, config: DetectionConfig = DEFAULT_DETECTION_CONFIG) {
  if (!config.featureFlags.amountOutlier) return null;
  const candidate = await prisma.expenseRecord.findUnique({ where: { id: expenseRecordId }, include: { category: true } });
  if (!candidate) return null;
  const fingerprint = `${AMOUNT_OUTLIER_VERSION}:${candidate.id}`;
  const clear = async () => prisma.anomalyFinding.updateMany({
    where: { businessProfileId: candidate.businessProfileId, expenseRecordId: candidate.id, method: "z-score-iqr", status: AnomalyFindingStatus.OPEN },
    data: { status: AnomalyFindingStatus.SUPERSEDED },
  });

  let baseline = await loadCachedBaseline(candidate, config);
  if (!baseline) {
    const history = await loadBoundedCategoryHistory(candidate.businessProfileId, candidate.date, config.baselineDays, config.maximumCategoryRecords);
    const amounts = history.filter((record) => record.categoryId === candidate.categoryId && record.id !== candidate.id).map((record) => Number(record.amount));
    if (amounts.length + 1 < config.minimumCategoryHistory) { await clear(); return null; }
    baseline = { stats: computeCategoryStats(amounts), quartiles: computeQuartiles(amounts) };
  }
  const { stats, quartiles } = baseline;
  const thresholds = {
    zScoreThreshold: config.zScoreThreshold,
    iqrFenceMultiplier: config.iqrFenceMultiplier,
    minimumDeviationFraction: config.minimumDeviationFraction,
  };
  if (!isUnusualExpense(Number(candidate.amount), stats, quartiles, thresholds)) { await clear(); return null; }
  const z = zScore(Number(candidate.amount), stats);
  return saveFinding({
    fingerprint, businessProfileId: candidate.businessProfileId, expenseRecordId: candidate.id,
    type: AnomalyFindingType.AMOUNT_OUTLIER,
    severity: Math.abs(z) >= 3 || Math.abs(Number(candidate.amount) - stats.mean) / Math.max(Math.abs(stats.mean), 1) >= 1
      ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
    score: Math.min(Math.abs(z) / 4, 1), method: "z-score-iqr", title: `Unusual ${candidate.category.name} expense`,
    reasons: [`Detected by ${detectionMethod(Number(candidate.amount), stats, quartiles, thresholds)}`, `The category baseline average is ${stats.mean.toFixed(2)}`],
    metadata: { zScore: z, categoryMean: stats.mean, categoryStdDev: stats.stdDev, q1: quartiles.q1, q3: quartiles.q3, historyCount: stats.count },
    detectorVersion: AMOUNT_OUTLIER_VERSION,
  });
}
