import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay } from "../../lib/dates";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";
import { normalizeComparisonText } from "./nearDuplicate.service";

export const VELOCITY_VERSION = "velocity-v1";
export const VELOCITY_WINDOWS = [1, 7, 30] as const;
const BASELINE_WINDOW_COUNT = 4;
const MINIMUM_CURRENT_COUNT = 3;
const MINIMUM_COUNT_INCREASE = 2;
const COUNT_MULTIPLIER = 3;

interface VelocityRecord {
  id: number;
  categoryId: number;
  vendor: string | null;
  amount: number;
  date: Date;
}

export interface VelocitySignal {
  windowDays: number;
  scope: "vendor" | "category";
  currentCount: number;
  currentAmount: number;
  baselineMedianCount: number;
  baselineMedianAmount: number;
  countRatio: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function inWindow(date: Date, start: Date, end: Date) {
  return date >= start && date <= end;
}

export function evaluateVelocity(
  candidate: VelocityRecord,
  records: VelocityRecord[],
): VelocitySignal[] {
  const signals: VelocitySignal[] = [];
  const vendor = normalizeComparisonText(candidate.vendor);

  for (const windowDays of VELOCITY_WINDOWS) {
    for (const scope of ["vendor", "category"] as const) {
      if (scope === "vendor" && !vendor) continue;
      const scoped = records.filter((record) =>
        scope === "vendor"
          ? normalizeComparisonText(record.vendor) === vendor
          : record.categoryId === candidate.categoryId,
      );
      const currentStart = utcAddDays(candidate.date, -(windowDays - 1));
      const currentEnd = utcEndOfDay(candidate.date);
      const current = scoped.filter((record) => inWindow(record.date, currentStart, currentEnd));
      const baselineCounts: number[] = [];
      const baselineAmounts: number[] = [];

      for (let index = 0; index < BASELINE_WINDOW_COUNT; index++) {
        const end = utcEndOfDay(utcAddDays(currentStart, -(index * windowDays + 1)));
        const start = utcAddDays(end, -(windowDays - 1));
        const window = scoped.filter((record) => inWindow(record.date, start, end));
        baselineCounts.push(window.length);
        baselineAmounts.push(window.reduce((sum, record) => sum + record.amount, 0));
      }

      const baselineMedianCount = median(baselineCounts);
      const currentCount = current.length;
      const threshold = Math.max(MINIMUM_CURRENT_COUNT, baselineMedianCount * COUNT_MULTIPLIER);
      if (currentCount < threshold || currentCount - baselineMedianCount < MINIMUM_COUNT_INCREASE) continue;

      signals.push({
        windowDays,
        scope,
        currentCount,
        currentAmount: current.reduce((sum, record) => sum + record.amount, 0),
        baselineMedianCount,
        baselineMedianAmount: median(baselineAmounts),
        countRatio: baselineMedianCount === 0 ? currentCount : currentCount / baselineMedianCount,
      });
    }
  }

  return signals;
}

export async function detectVelocityForExpense(
  expenseRecordId: number,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
) {
  if (!config.featureFlags.velocity) return null;
  const candidate = await prisma.expenseRecord.findUnique({ where: { id: expenseRecordId } });
  if (!candidate) return null;

  const historyStart = utcAddDays(candidate.date, -(30 * (BASELINE_WINDOW_COUNT + 1) - 1));
  const rows = await prisma.expenseRecord.findMany({
    where: {
      businessProfileId: candidate.businessProfileId,
      date: { gte: historyStart, lte: utcEndOfDay(candidate.date) },
    },
    select: { id: true, categoryId: true, vendor: true, amount: true, date: true },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 5_000,
  });
  const records = rows.map((record) => ({ ...record, amount: Number(record.amount) }));
  const signals = evaluateVelocity({ ...candidate, amount: Number(candidate.amount) }, records);
  const fingerprint = `${VELOCITY_VERSION}:${candidate.id}`;

  if (signals.length === 0) {
    await prisma.anomalyFinding.updateMany({
      where: {
        businessProfileId: candidate.businessProfileId,
        expenseRecordId: candidate.id,
        type: AnomalyFindingType.VELOCITY_ANOMALY,
        status: AnomalyFindingStatus.OPEN,
      },
      data: { status: AnomalyFindingStatus.SUPERSEDED },
    });
    return null;
  }

  const strongest = [...signals].sort((a, b) => b.countRatio - a.countRatio)[0]!;
  const scopeName = strongest.scope === "vendor" ? `vendor ${candidate.vendor}` : "category";
  return saveFinding({
    fingerprint,
    businessProfileId: candidate.businessProfileId,
    expenseRecordId: candidate.id,
    type: AnomalyFindingType.VELOCITY_ANOMALY,
    severity: strongest.countRatio >= 5 ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
    score: Math.min(strongest.countRatio / 5, 1),
    method: "rolling-velocity",
    title: "Unusual transaction frequency",
    reasons: [
      `${strongest.currentCount} transactions occurred for this ${scopeName} in ${strongest.windowDays} day${strongest.windowDays === 1 ? "" : "s"}`,
      `Comparable periods normally contain about ${strongest.baselineMedianCount} transaction${strongest.baselineMedianCount === 1 ? "" : "s"}`,
    ],
    metadata: {
      windowDays: strongest.windowDays,
      scope: strongest.scope,
      currentCount: strongest.currentCount,
      currentAmount: strongest.currentAmount,
      baselineMedianCount: strongest.baselineMedianCount,
      baselineMedianAmount: strongest.baselineMedianAmount,
      countRatio: strongest.countRatio,
      signalCount: signals.length,
    },
    detectorVersion: VELOCITY_VERSION,
  });
}
