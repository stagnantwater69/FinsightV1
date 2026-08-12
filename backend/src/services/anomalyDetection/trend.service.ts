import { AnomalyFindingSeverity, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay, utcToday } from "../../lib/dates";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";

export const TREND_VERSION = "trend-v1";
const TREND_WINDOWS = [7, 30] as const;
const MINIMUM_PERCENT_CHANGE = 0.25;

export async function refreshTrendFindings(
  userId: number,
  businessProfileId: number,
  today = utcToday(),
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
) {
  if (!config.featureFlags.trends) return [];
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  const categories = await prisma.expenseCategory.findMany({ where: { businessProfileId }, select: { id: true, name: true } });
  const records = await prisma.expenseRecord.findMany({
    where: { businessProfileId, date: { gte: utcAddDays(today, -59), lte: utcEndOfDay(today) } },
    select: { categoryId: true, amount: true, date: true },
  });
  const materialPesoChange = Math.max(500, Number(profile.expectedMonthlyExpenses) * 0.02);
  const findings = [];

  for (const category of categories) {
    const categoryRecords = records.filter((record) => record.categoryId === category.id);
    for (const windowDays of TREND_WINDOWS) {
      const currentStart = utcAddDays(today, -(windowDays - 1));
      const previousEnd = utcAddDays(currentStart, -1);
      const previousStart = utcAddDays(previousEnd, -(windowDays - 1));
      const current = categoryRecords.filter((record) => record.date >= currentStart && record.date <= today)
        .reduce((sum, record) => sum + Number(record.amount), 0);
      const previous = categoryRecords.filter((record) => record.date >= previousStart && record.date <= previousEnd)
        .reduce((sum, record) => sum + Number(record.amount), 0);
      if (previous <= 0) continue;
      const change = current - previous;
      const percentChange = change / previous;
      if (Math.abs(percentChange) < MINIMUM_PERCENT_CHANGE || Math.abs(change) < materialPesoChange) continue;
      const direction = change > 0 ? "increased" : "decreased";
      findings.push(await saveFinding({
        fingerprint: `${TREND_VERSION}:${category.id}:${windowDays}:${today.toISOString().slice(0, 10)}`,
        businessProfileId, type: AnomalyFindingType.TREND_CHANGE,
        severity: Math.abs(percentChange) >= 0.5 ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
        score: Math.min(Math.abs(percentChange), 1), method: "comparable-period-trend",
        title: `${category.name} spending ${direction}`,
        reasons: [
          `${category.name} spending ${direction} by ${Math.round(Math.abs(percentChange) * 100)}% over the latest ${windowDays} days`,
          `The peso difference is ${Math.abs(change).toFixed(2)} compared with the preceding equivalent period`,
        ],
        metadata: { categoryId: category.id, windowDays, current, previous, change, percentChange: percentChange * 100 },
        detectorVersion: TREND_VERSION,
      }));
    }
  }
  return findings;
}
