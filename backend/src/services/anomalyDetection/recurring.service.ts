import { createHash } from "node:crypto";
import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType, Prisma, RecurringPatternStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay, utcToday } from "../../lib/dates";
import { ApiError } from "../../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { saveFinding } from "./finding.service";
import { normalizeComparisonText } from "./nearDuplicate.service";

export const RECURRING_VERSION = "recurring-v1";
const MINIMUM_OBSERVATIONS = 3;
const MINIMUM_CONFIDENCE = 0.7;

interface RecurringRecord {
  id: number;
  categoryId: number;
  vendor: string | null;
  description: string;
  amount: number;
  date: Date;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function daysBetween(left: Date, right: Date) {
  return Math.round(Math.abs(right.getTime() - left.getTime()) / 86_400_000);
}

export function recurringKey(record: Pick<RecurringRecord, "categoryId" | "vendor" | "description">) {
  const identity = `${record.categoryId}|${normalizeComparisonText(record.vendor)}|${normalizeComparisonText(record.description)}`;
  return createHash("sha256").update(identity).digest("hex");
}

export function inferRecurringPattern(records: RecurringRecord[]) {
  if (records.length < MINIMUM_OBSERVATIONS) return null;
  const sorted = [...records].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  const intervals = sorted.slice(1).map((record, index) => daysBetween(sorted[index]!.date, record.date));
  const intervalDays = Math.round(median(intervals));
  const recognized = (intervalDays >= 5 && intervalDays <= 9)
    || (intervalDays >= 25 && intervalDays <= 35)
    || (intervalDays >= 80 && intervalDays <= 100);
  if (!recognized) return null;

  const intervalTolerance = Math.max(2, intervalDays * 0.2);
  const intervalConfidence = intervals.filter((value) => Math.abs(value - intervalDays) <= intervalTolerance).length / intervals.length;
  const amounts = sorted.map((record) => record.amount);
  const expectedAmount = median(amounts);
  const deviations = amounts.map((amount) => Math.abs(amount - expectedAmount) / Math.max(Math.abs(expectedAmount), 1));
  const amountTolerance = Math.max(0.15, median(deviations) * 2);
  const amountConfidence = deviations.filter((value) => value <= amountTolerance).length / deviations.length;
  const confidence = (intervalConfidence + amountConfidence) / 2;
  if (confidence < MINIMUM_CONFIDENCE) return null;

  const latest = sorted.at(-1)!;
  return {
    sorted,
    intervalDays,
    expectedAmount,
    amountTolerance,
    confidence,
    lastOccurrence: latest.date,
    nextExpectedDate: utcAddDays(latest.date, intervalDays),
  };
}

export async function refreshRecurringPatterns(userId: number, businessProfileId: number, today = utcToday()) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const rows = await prisma.expenseRecord.findMany({
    where: { businessProfileId, date: { gte: utcAddDays(today, -730), lte: utcEndOfDay(today) } },
    select: { id: true, categoryId: true, vendor: true, description: true, amount: true, date: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 10_000,
  });
  const groups = new Map<string, RecurringRecord[]>();
  for (const row of rows) {
    const record = { ...row, amount: Number(row.amount) };
    const key = recurringKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const patterns = [];
  for (const [normalizedKey, records] of groups) {
    const inferred = inferRecurringPattern(records);
    if (!inferred) continue;
    const latest = inferred.sorted.at(-1)!;
    patterns.push(await prisma.recurringPattern.upsert({
      where: { businessProfileId_normalizedKey: { businessProfileId, normalizedKey } },
      create: {
        businessProfileId, categoryId: latest.categoryId, normalizedKey,
        vendor: latest.vendor, description: latest.description,
        intervalDays: inferred.intervalDays,
        expectedAmount: new Prisma.Decimal(inferred.expectedAmount),
        amountTolerance: new Prisma.Decimal(inferred.amountTolerance),
        confidence: new Prisma.Decimal(inferred.confidence),
        observationCount: records.length,
        lastOccurrence: inferred.lastOccurrence,
        nextExpectedDate: inferred.nextExpectedDate,
      },
      update: {
        categoryId: latest.categoryId, vendor: latest.vendor, description: latest.description,
        intervalDays: inferred.intervalDays,
        expectedAmount: new Prisma.Decimal(inferred.expectedAmount),
        amountTolerance: new Prisma.Decimal(inferred.amountTolerance),
        confidence: new Prisma.Decimal(inferred.confidence),
        observationCount: records.length,
        lastOccurrence: inferred.lastOccurrence,
        nextExpectedDate: inferred.nextExpectedDate,
      },
    }));
  }

  const confirmed = patterns.filter((pattern) => pattern.status === RecurringPatternStatus.CONFIRMED);
  for (const pattern of confirmed) {
    const graceDays = Math.max(2, Math.ceil(pattern.intervalDays * 0.15));
    const overdueAfter = utcAddDays(pattern.nextExpectedDate, graceDays);
    const prefix = `${RECURRING_VERSION}:missing:${pattern.id}:`;
    if (today > overdueAfter) {
      const fingerprint = `${prefix}${pattern.nextExpectedDate.toISOString().slice(0, 10)}`;
      await saveFinding({
        fingerprint, businessProfileId, type: AnomalyFindingType.RECURRING_CHANGE,
        severity: AnomalyFindingSeverity.MEDIUM, score: Number(pattern.confidence),
        method: "recurring-missing", title: "Expected recurring expense is missing",
        reasons: [`${pattern.description} was expected around ${pattern.nextExpectedDate.toISOString().slice(0, 10)}`],
        metadata: { recurringPatternId: pattern.id, expectedAmount: Number(pattern.expectedAmount), intervalDays: pattern.intervalDays },
        detectorVersion: RECURRING_VERSION,
      });
      await prisma.anomalyFinding.updateMany({
        where: { businessProfileId, fingerprint: { startsWith: prefix, not: fingerprint }, status: AnomalyFindingStatus.OPEN },
        data: { status: AnomalyFindingStatus.SUPERSEDED },
      });
    } else {
      await prisma.anomalyFinding.updateMany({
        where: { businessProfileId, fingerprint: { startsWith: prefix }, status: AnomalyFindingStatus.OPEN },
        data: { status: AnomalyFindingStatus.SUPERSEDED },
      });
    }

    const records = groups.get(pattern.normalizedKey) ?? [];
    const latest = records.at(-1);
    const previous = records.at(-2);
    if (!latest) continue;
    const deviation = Math.abs(latest.amount - Number(pattern.expectedAmount)) / Math.max(Math.abs(Number(pattern.expectedAmount)), 1);
    if (deviation > Number(pattern.amountTolerance)) {
      await saveFinding({
        fingerprint: `${RECURRING_VERSION}:amount:${pattern.id}:${latest.id}`,
        businessProfileId, expenseRecordId: latest.id, type: AnomalyFindingType.RECURRING_CHANGE,
        severity: deviation >= 0.5 ? AnomalyFindingSeverity.HIGH : AnomalyFindingSeverity.MEDIUM,
        score: Math.min(deviation, 1), method: "recurring-amount-change",
        title: "Recurring expense amount changed",
        reasons: [`The amount differs by ${Math.round(deviation * 100)}% from the expected recurring amount`],
        metadata: { recurringPatternId: pattern.id, expectedAmount: Number(pattern.expectedAmount), actualAmount: latest.amount },
        detectorVersion: RECURRING_VERSION,
      });
    }
    if (previous && daysBetween(previous.date, latest.date) < pattern.intervalDays * 0.5) {
      await saveFinding({
        fingerprint: `${RECURRING_VERSION}:repeated:${pattern.id}:${latest.id}`,
        businessProfileId, expenseRecordId: latest.id, type: AnomalyFindingType.RECURRING_CHANGE,
        severity: AnomalyFindingSeverity.HIGH, score: 1, method: "recurring-repeated",
        title: "Recurring expense appeared earlier than expected",
        reasons: [`This expense appeared ${daysBetween(previous.date, latest.date)} days after the previous one; the usual interval is ${pattern.intervalDays} days`],
        metadata: { recurringPatternId: pattern.id, intervalDays: pattern.intervalDays },
        detectorVersion: RECURRING_VERSION,
      });
    }
  }
  return patterns;
}

export async function reviewRecurringPattern(userId: number, patternId: number, status: RecurringPatternStatus) {
  const pattern = await prisma.recurringPattern.findFirst({ where: { id: patternId, businessProfile: { userId } }, select: { id: true } });
  if (!pattern) throw new ApiError(404, "Recurring pattern not found");
  return prisma.recurringPattern.update({ where: { id: pattern.id }, data: { status } });
}

export async function listRecurringPatterns(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  return prisma.recurringPattern.findMany({
    where: { businessProfileId },
    include: { category: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { nextExpectedDate: "asc" }, { id: "asc" }],
  });
}
