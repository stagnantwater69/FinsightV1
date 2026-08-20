import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { utcAddDays } from "../../lib/dates";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";
import {
  buildFeatureMatrix,
  IF_FEATURE_NAMES,
  IF_FEATURE_VERSION,
  topFeatureDeviations,
  type IsolationForestRecord,
} from "./isolationForestFeatures";
import { scoreWithIsolationForest } from "./mlWorkerClient";

/**
 * Isolation Forest — the secondary, multivariate detector. SHADOW MODE ONLY.
 *
 * Runs batch-wise from the PROFILE_REFRESH analysis job (never per
 * transaction — ADR-1): one bounded history load, one feature matrix, one
 * sidecar call, and a handful of SHADOW findings for the most anomalous
 * records under a hard alert budget. SHADOW findings are invisible to the
 * owner, the clients, notifications, and Ask FinSight; they exist so the
 * evaluation endpoint can measure whether this detector finds anything the
 * rule-based detectors miss, before anyone is shown anything.
 *
 * Cold start: profiles with fewer than MINIMUM_HISTORY usable records are
 * skipped entirely — the deterministic detectors remain the only opinion for
 * sparse or brand-new businesses (A2).
 *
 * Every failure path is fail-open: a missing sidecar, a malformed response,
 * or a scoring crash costs this pass's shadow findings and nothing else.
 */

export const ISOLATION_FOREST_VERSION = "isolation-forest-v1";
const METHOD = "isolation-forest";

/** A1 experiment starting range is 100–200 usable records; start at the floor. */
const MINIMUM_HISTORY = 100;
const HISTORY_DAYS = 365;
const MAX_RECORDS = 2_000;

/**
 * Alert budget (ADR-2): at most 2 shadow findings per 100 scored records,
 * capped at 10 per pass, and only for records the forest itself put on the
 * anomalous side (decisionValue < 0) in the top percentile band.
 */
const BUDGET_PER_100 = 2;
const MAX_FINDINGS_PER_PASS = 10;
const MIN_NORMALIZED_SCORE = 0.98;

export async function refreshIsolationForestFindings(
  userId: number,
  businessProfileId: number,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
) {
  if (!config.featureFlags.isolationForest) return null;

  const owned = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
    select: { id: true },
  });
  if (!owned) return null;

  const now = new Date();
  const rows = await prisma.expenseRecord.findMany({
    where: { businessProfileId, date: { gte: utcAddDays(now, -HISTORY_DAYS), lte: now } },
    select: { id: true, categoryId: true, vendor: true, description: true, amount: true, date: true, source: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: MAX_RECORDS,
  });
  if (rows.length < MINIMUM_HISTORY) return null;

  const records: IsolationForestRecord[] = rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  const matrix = buildFeatureMatrix(records);
  const response = await scoreWithIsolationForest(matrix, IF_FEATURE_NAMES);
  if (!response) return null; // sidecar unavailable — fail open, no opinion

  const byId = new Map(matrix.map((entry) => [entry.id, entry.features]));
  const budget = Math.min(Math.max(Math.floor((records.length / 100) * BUDGET_PER_100), 1), MAX_FINDINGS_PER_PASS);
  const selected = response.scores
    .filter((score) => score.decisionValue < 0 && score.normalizedScore >= MIN_NORMALIZED_SCORE)
    .sort((a, b) => b.normalizedScore - a.normalizedScore)
    .slice(0, budget);

  // Records that fell out of the anomalous band no longer carry an active
  // shadow opinion; supersede them so evaluation reads the current model view.
  const selectedIds = selected.map((score) => score.id);
  await prisma.anomalyFinding.updateMany({
    where: {
      businessProfileId,
      method: METHOD,
      status: { in: [AnomalyFindingStatus.SHADOW, AnomalyFindingStatus.OPEN] },
      ...(selectedIds.length ? { expenseRecordId: { notIn: selectedIds } } : {}),
    },
    data: { status: AnomalyFindingStatus.SUPERSEDED },
  });

  const allFeatureRows = matrix.map((entry) => entry.features);
  let saved = 0;
  for (const score of selected) {
    const features = byId.get(score.id);
    if (!features) continue;
    const deviations = topFeatureDeviations(features, allFeatureRows);
    const reasons = deviations.length
      ? deviations.map((entry) => entry.label)
      : ["Several characteristics of this transaction differ from this business's usual pattern"];
    await saveFinding({
      fingerprint: `${ISOLATION_FOREST_VERSION}:${score.id}`,
      businessProfileId,
      expenseRecordId: score.id,
      type: AnomalyFindingType.ML_OUTLIER,
      // Never HIGH: HIGH is the notification threshold, and a shadow detector
      // must stay below every gate that could reach an owner.
      severity: score.normalizedScore >= 0.995 ? AnomalyFindingSeverity.MEDIUM : AnomalyFindingSeverity.LOW,
      score: score.normalizedScore,
      method: METHOD,
      title: "Unusual combination of transaction characteristics",
      reasons,
      metadata: {
        modelVersion: response.modelVersion,
        featureVersion: IF_FEATURE_VERSION,
        sklearnVersion: response.sklearnVersion,
        decisionValue: score.decisionValue,
        normalizedScore: score.normalizedScore,
        trainingWindowDays: HISTORY_DAYS,
        trainedRows: response.trainedRows,
        topDeviations: deviations.map((entry) => `${entry.feature}:${entry.deviation.toFixed(2)}`),
      },
      detectorVersion: ISOLATION_FOREST_VERSION,
      status: AnomalyFindingStatus.SHADOW,
    });
    saved += 1;
  }

  logger.info(
    { businessProfileId, scored: records.length, shadowFindings: saved, modelVersion: response.modelVersion },
    "isolation forest shadow pass complete",
  );
  return saved;
}
