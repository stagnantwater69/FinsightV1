import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay } from "../../lib/dates";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";
import { normalizeComparisonText, textSimilarity } from "./nearDuplicate.service";

export const BEHAVIORAL_NOVELTY_VERSION = "behavioral-novelty-v1";
const MINIMUM_HISTORY = 20;

interface BehaviorRecord {
  id: number;
  categoryId: number;
  vendor: string | null;
  description: string;
  amount: number;
  date: Date;
}

export function behavioralSignals(candidate: BehaviorRecord, history: BehaviorRecord[]) {
  if (history.length < MINIMUM_HISTORY) return null;
  const amounts = history.map((record) => record.amount).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)]!;
  const amount = Math.min(Math.abs(candidate.amount - median) / Math.max(Math.abs(median), 1), 1);
  const normalizedVendor = normalizeComparisonText(candidate.vendor);
  const vendor = normalizedVendor && !history.some((record) => normalizeComparisonText(record.vendor) === normalizedVendor) ? 1 : 0;
  const categoryCount = history.filter((record) => record.categoryId === candidate.categoryId).length;
  const category = categoryCount === 0 ? 1 : Math.max(0, 1 - categoryCount / Math.max(history.length * 0.1, 1));
  const weekday = candidate.date.getUTCDay();
  const weekdayShare = history.filter((record) => record.date.getUTCDay() === weekday).length / history.length;
  const timing = Math.max(0, 1 - weekdayShare / 0.15);
  const description = 1 - Math.max(...history.map((record) => textSimilarity(candidate.description, record.description)));
  const score = amount * 0.3 + vendor * 0.25 + category * 0.15 + timing * 0.1 + description * 0.2;
  return { score, amount, vendor, category, timing, description };
}

export async function detectBehavioralNoveltyForExpense(
  expenseRecordId: number,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
) {
  if (!config.featureFlags.behavioralNovelty) return null;
  const candidate = await prisma.expenseRecord.findUnique({ where: { id: expenseRecordId } });
  if (!candidate) return null;
  const rows = await prisma.expenseRecord.findMany({
    where: {
      id: { not: candidate.id }, businessProfileId: candidate.businessProfileId,
      date: { gte: utcAddDays(candidate.date, -365), lte: utcEndOfDay(candidate.date) },
    },
    select: { id: true, categoryId: true, vendor: true, description: true, amount: true, date: true },
    orderBy: [{ date: "desc" }, { id: "desc" }], take: 1_000,
  });
  const history = rows.map((record) => ({ ...record, amount: Number(record.amount) }));
  const signals = behavioralSignals({ ...candidate, amount: Number(candidate.amount) }, history);
  const fingerprint = `${BEHAVIORAL_NOVELTY_VERSION}:${candidate.id}`;
  const strongSignals = signals ? Object.entries(signals).filter(([name, value]) => name !== "score" && value >= 0.75) : [];
  if (!signals || signals.score < 0.65 || strongSignals.length < 2) {
    await prisma.anomalyFinding.updateMany({
      where: { businessProfileId: candidate.businessProfileId, expenseRecordId: candidate.id, method: "behavioral-novelty", status: AnomalyFindingStatus.OPEN },
      data: { status: AnomalyFindingStatus.SUPERSEDED },
    });
    return null;
  }
  const labels: Record<string, string> = {
    amount: "The amount differs substantially from typical transactions",
    vendor: "This vendor has not appeared in the recent history",
    category: "This category is rarely used",
    timing: "This transaction occurred on an unusual day of the week",
    description: "The description differs from previous transaction descriptions",
  };
  return saveFinding({
    fingerprint, businessProfileId: candidate.businessProfileId, expenseRecordId: candidate.id,
    type: AnomalyFindingType.BEHAVIORAL_NOVELTY,
    severity: signals.score >= 0.8 ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
    score: signals.score, method: "behavioral-novelty", title: "Unusual transaction behavior",
    reasons: strongSignals.map(([name]) => labels[name]!), metadata: signals,
    detectorVersion: BEHAVIORAL_NOVELTY_VERSION,
  });
}
