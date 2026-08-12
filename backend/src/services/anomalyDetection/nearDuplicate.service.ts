import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay } from "../../lib/dates";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { saveFinding } from "./finding.service";

export const NEAR_DUPLICATE_VERSION = "near-duplicate-v1";
export const NEAR_DUPLICATE_REVIEW_THRESHOLD = 0.75;
export const NEAR_DUPLICATE_HIGH_THRESHOLD = 0.9;
export const NEAR_DUPLICATE_DATE_WINDOW_DAYS = 7;
export const NEAR_DUPLICATE_AMOUNT_TOLERANCE = 0.1;

export interface DuplicateComparable {
  id: number;
  businessProfileId: number;
  categoryId: number;
  date: Date;
  amount: Prisma.Decimal | number;
  description: string;
  vendor: string | null;
}

export interface NearDuplicateScore {
  score: number;
  amountSimilarity: number;
  vendorSimilarity: number;
  descriptionSimilarity: number;
  dateSimilarity: number;
  categorySimilarity: number;
  dateDistanceDays: number;
}

export function normalizeComparisonText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

/** Sørensen-Dice similarity over character bigrams, including duplicates. */
export function textSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeComparisonText(left);
  const b = normalizeComparisonText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const leftPairs = bigrams(a);
  const rightCounts = new Map<string, number>();
  for (const pair of bigrams(b)) rightCounts.set(pair, (rightCounts.get(pair) ?? 0) + 1);
  let intersection = 0;
  for (const pair of leftPairs) {
    const remaining = rightCounts.get(pair) ?? 0;
    if (remaining > 0) {
      intersection += 1;
      rightCounts.set(pair, remaining - 1);
    }
  }
  return (2 * intersection) / (leftPairs.length + [...rightCounts.values()].reduce((sum, count) => sum + count, 0) + intersection);
}

function amountSimilarity(left: number, right: number): number {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.max(0, 1 - Math.abs(left - right) / scale);
}

function utcDayDistance(left: Date, right: Date): number {
  const leftDay = Date.UTC(left.getUTCFullYear(), left.getUTCMonth(), left.getUTCDate());
  const rightDay = Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate());
  return Math.abs(leftDay - rightDay) / 86_400_000;
}

export function scoreNearDuplicate(candidate: DuplicateComparable, existing: DuplicateComparable): NearDuplicateScore {
  const amount = amountSimilarity(Number(candidate.amount), Number(existing.amount));
  const vendor = textSimilarity(candidate.vendor, existing.vendor);
  const description = textSimilarity(candidate.description, existing.description);
  const dateDistanceDays = utcDayDistance(candidate.date, existing.date);
  const date = Math.max(0, 1 - dateDistanceDays / NEAR_DUPLICATE_DATE_WINDOW_DAYS);
  const category = candidate.categoryId === existing.categoryId ? 1 : 0;

  return {
    score: amount * 0.35 + vendor * 0.25 + description * 0.2 + date * 0.15 + category * 0.05,
    amountSimilarity: amount,
    vendorSimilarity: vendor,
    descriptionSimilarity: description,
    dateSimilarity: date,
    categorySimilarity: category,
    dateDistanceDays,
  };
}

async function supersedePreviousFindings(expenseRecordId: number, exceptFingerprint?: string) {
  await prisma.anomalyFinding.updateMany({
    where: {
      expenseRecordId,
      type: AnomalyFindingType.POSSIBLE_DUPLICATE,
      method: "near-duplicate",
      status: AnomalyFindingStatus.OPEN,
      ...(exceptFingerprint ? { fingerprint: { not: exceptFingerprint } } : {}),
    },
    data: { status: AnomalyFindingStatus.SUPERSEDED },
  });
}

/**
 * Evaluates one persisted expense against nearby records from the same
 * business. This is intentionally review-only: it never changes
 * ExpenseRecord.duplicateStatus and never deletes either record.
 */
export async function detectNearDuplicateForExpense(
  expenseRecordId: number,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
) {
  if (!config.featureFlags.nearDuplicate) return null;

  const candidate = await prisma.expenseRecord.findUnique({ where: { id: expenseRecordId } });
  if (!candidate) return null;

  // The exact matcher has already produced a stronger, deterministic result.
  if (candidate.duplicateStatus === "Flagged") {
    await supersedePreviousFindings(candidate.id);
    return null;
  }

  const numericAmount = Number(candidate.amount);
  const amountMargin = Math.max(Math.abs(numericAmount) * NEAR_DUPLICATE_AMOUNT_TOLERANCE, 1);
  const nearby = await prisma.expenseRecord.findMany({
    where: {
      id: { not: candidate.id },
      businessProfileId: candidate.businessProfileId,
      date: {
        gte: utcAddDays(candidate.date, -NEAR_DUPLICATE_DATE_WINDOW_DAYS),
        lte: utcEndOfDay(utcAddDays(candidate.date, NEAR_DUPLICATE_DATE_WINDOW_DAYS)),
      },
      amount: { gte: numericAmount - amountMargin, lte: numericAmount + amountMargin },
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 100,
  });

  const scored = nearby
    .map((record) => ({ record, result: scoreNearDuplicate(candidate, record) }))
    .sort((left, right) => right.result.score - left.result.score || left.record.id - right.record.id);
  const best = scored[0];
  if (!best || best.result.score < NEAR_DUPLICATE_REVIEW_THRESHOLD) {
    await supersedePreviousFindings(candidate.id);
    return null;
  }

  const fingerprint = `${NEAR_DUPLICATE_VERSION}:${candidate.id}:${best.record.id}`;
  const reasons: string[] = [];
  if (best.result.amountSimilarity >= 0.95) reasons.push("The amounts are nearly identical");
  if (best.result.vendorSimilarity >= 0.8) reasons.push("The vendor names are very similar");
  if (best.result.descriptionSimilarity >= 0.7) reasons.push("The descriptions are similar");
  if (best.result.dateDistanceDays <= 1) reasons.push("The transactions were recorded within one day of each other");
  if (best.result.categorySimilarity === 1) reasons.push("Both transactions use the same category");

  const finding = await saveFinding({
    fingerprint,
    businessProfileId: candidate.businessProfileId,
    expenseRecordId: candidate.id,
    type: AnomalyFindingType.POSSIBLE_DUPLICATE,
    severity:
      best.result.score >= NEAR_DUPLICATE_HIGH_THRESHOLD
        ? AnomalyFindingSeverity.HIGH
        : AnomalyFindingSeverity.MEDIUM,
    score: best.result.score,
    method: "near-duplicate",
    title: "Possible similar expense",
    reasons,
    metadata: {
      matchedExpenseRecordId: best.record.id,
      amountSimilarity: best.result.amountSimilarity,
      vendorSimilarity: best.result.vendorSimilarity,
      descriptionSimilarity: best.result.descriptionSimilarity,
      dateSimilarity: best.result.dateSimilarity,
      dateDistanceDays: best.result.dateDistanceDays,
    },
    detectorVersion: NEAR_DUPLICATE_VERSION,
  });
  await supersedePreviousFindings(candidate.id, fingerprint);
  return finding;
}
