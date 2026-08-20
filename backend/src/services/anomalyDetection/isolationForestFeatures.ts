import { ExpenseRecordSource } from "@prisma/client";
import { normalizeComparisonText, textSimilarity } from "./nearDuplicate.service";

/**
 * The Isolation Forest feature contract — `if-features-v1`.
 *
 * Versioned independently of the model (ADR-2): a finding records both, so a
 * feature change and a model change are distinguishable in evaluation. The
 * contract is deliberately tenant-free: every value is a number derived from
 * the profile's own bounded history — no ids, no raw descriptions, no vendor
 * strings ever leave this process (the sidecar receives numbers only).
 *
 * Everything here is pure and clock-free so it unit-tests like
 * `behavioralSignals` does. Ratio features are capped so a single wild value
 * cannot dominate the tree splits, and "no history" sentinels sit at the cap
 * rather than at zero (a first-ever vendor IS unusual, not average).
 */

export const IF_FEATURE_VERSION = "if-features-v1";

export interface IsolationForestRecord {
  id: number;
  categoryId: number;
  vendor: string | null;
  description: string;
  amount: number;
  date: Date;
  source: ExpenseRecordSource;
}

export const IF_FEATURE_NAMES = [
  "logAmount",
  "amountToCategoryMedian",
  "amountToVendorMedian",
  "categoryMadZ",
  "weekdaySin",
  "weekdayCos",
  "dayOfMonthSin",
  "dayOfMonthCos",
  "daysSinceSimilar",
  "vendorCount7d",
  "vendorCount30d",
  "categoryCount7d",
  "categoryCount30d",
  "vendorIsNew",
  "categoryRarity",
  "descriptionNovelty",
  "sourceCsv",
  "sourceReceipt",
] as const;

export type IfFeatureName = (typeof IF_FEATURE_NAMES)[number];

/** Owner-readable label per feature, for finding reasons and audit views. */
export const IF_FEATURE_LABELS: Record<IfFeatureName, string> = {
  logAmount: "The amount itself is unusual for this business",
  amountToCategoryMedian: "The amount is far from this category's usual amount",
  amountToVendorMedian: "The amount is far from this vendor's usual amount",
  categoryMadZ: "The amount deviates strongly from the category's typical range",
  weekdaySin: "The day of week is unusual for this business",
  weekdayCos: "The day of week is unusual for this business",
  dayOfMonthSin: "The time of month is unusual for this business",
  dayOfMonthCos: "The time of month is unusual for this business",
  daysSinceSimilar: "Nothing similar has been recorded for a long time",
  vendorCount7d: "This vendor's recent activity is unusual",
  vendorCount30d: "This vendor's monthly activity is unusual",
  categoryCount7d: "This category's recent activity is unusual",
  categoryCount30d: "This category's monthly activity is unusual",
  vendorIsNew: "This vendor has not appeared before",
  categoryRarity: "This category is rarely used",
  descriptionNovelty: "The description is unlike previous transactions",
  sourceCsv: "How this record entered FinSight",
  sourceReceipt: "How this record entered FinSight",
};

const RATIO_CAP = 10;
const DAYS_SINCE_CAP = 90;
const DAY_MS = 86_400_000;

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function cappedRatio(amount: number, baseline: number): number {
  if (baseline <= 0) return RATIO_CAP;
  return Math.min(amount / baseline, RATIO_CAP);
}

/**
 * Feature vector for one record given the records BEFORE it (chronological
 * order is the caller's contract). Using only prior records keeps the batch
 * honest: a record's own value never contributes to the baseline it is
 * measured against — the same leave-one-out discipline the amount detector
 * follows.
 */
export function featuresFor(candidate: IsolationForestRecord, prior: IsolationForestRecord[]): number[] {
  const time = candidate.date.getTime();
  const categoryAmounts = prior
    .filter((record) => record.categoryId === candidate.categoryId)
    .map((record) => record.amount)
    .sort((a, b) => a - b);
  const normalizedVendor = normalizeComparisonText(candidate.vendor);
  const vendorRecords = normalizedVendor
    ? prior.filter((record) => normalizeComparisonText(record.vendor) === normalizedVendor)
    : [];
  const vendorAmounts = vendorRecords.map((record) => record.amount).sort((a, b) => a - b);

  const categoryMedian = median(categoryAmounts);
  const deviations = categoryAmounts.map((value) => Math.abs(value - categoryMedian)).sort((a, b) => a - b);
  const mad = median(deviations);
  // 0.6745 rescales MAD to a standard-deviation-comparable unit.
  const madZ =
    categoryAmounts.length >= 5 && mad > 0
      ? Math.min(Math.abs((0.6745 * (candidate.amount - categoryMedian)) / mad), RATIO_CAP)
      : 0;

  const weekday = candidate.date.getUTCDay();
  const dayOfMonth = candidate.date.getUTCDate();

  const similar = prior.filter(
    (record) =>
      record.categoryId === candidate.categoryId ||
      (normalizedVendor !== "" && normalizeComparisonText(record.vendor) === normalizedVendor),
  );
  const lastSimilarTime = similar.length ? Math.max(...similar.map((record) => record.date.getTime())) : null;
  const daysSinceSimilar =
    lastSimilarTime === null ? DAYS_SINCE_CAP : Math.min((time - lastSimilarTime) / DAY_MS, DAYS_SINCE_CAP);

  const inWindow = (record: IsolationForestRecord, days: number) =>
    time - record.date.getTime() <= days * DAY_MS && record.date.getTime() <= time;
  const vendorCount = (days: number) => vendorRecords.filter((record) => inWindow(record, days)).length;
  const categoryCount = (days: number) =>
    prior.filter((record) => record.categoryId === candidate.categoryId && inWindow(record, days)).length;

  const categoryShare = prior.length ? categoryAmounts.length / prior.length : 0;
  const descriptionNovelty = prior.length
    ? 1 - Math.max(...prior.map((record) => textSimilarity(candidate.description, record.description)))
    : 1;

  return [
    Math.log1p(Math.max(candidate.amount, 0)),
    cappedRatio(candidate.amount, categoryMedian),
    vendorAmounts.length ? cappedRatio(candidate.amount, median(vendorAmounts)) : RATIO_CAP,
    madZ,
    Math.sin((2 * Math.PI * weekday) / 7),
    Math.cos((2 * Math.PI * weekday) / 7),
    Math.sin((2 * Math.PI * (dayOfMonth - 1)) / 31),
    Math.cos((2 * Math.PI * (dayOfMonth - 1)) / 31),
    daysSinceSimilar,
    vendorCount(7),
    vendorCount(30),
    categoryCount(7),
    categoryCount(30),
    normalizedVendor !== "" && vendorRecords.length === 0 ? 1 : 0,
    Math.max(0, 1 - categoryShare / 0.05),
    descriptionNovelty,
    candidate.source === ExpenseRecordSource.CSV_UPLOAD ? 1 : 0,
    candidate.source === ExpenseRecordSource.RECEIPT_SCAN ? 1 : 0,
  ];
}

/**
 * Feature matrix for a chronological batch: each record is featured against
 * only the records that precede it.
 */
export function buildFeatureMatrix(records: IsolationForestRecord[]): { id: number; features: number[] }[] {
  return records.map((record, index) => ({ id: record.id, features: featuresFor(record, records.slice(0, index)) }));
}

/**
 * Deterministic per-feature explanation: which of this row's features sit
 * furthest (in robust z units) from the batch's own column medians. This is
 * what fills `reasons` — the model's score never explains itself, the feature
 * deviations do.
 */
export function topFeatureDeviations(
  row: number[],
  matrix: number[][],
  limit = 3,
): { feature: IfFeatureName; deviation: number; label: string }[] {
  const contextual: IfFeatureName[] = [
    "amountToCategoryMedian",
    "amountToVendorMedian",
    "categoryMadZ",
    "daysSinceSimilar",
    "vendorIsNew",
    "categoryRarity",
    "descriptionNovelty",
    "vendorCount7d",
    "categoryCount7d",
  ];
  const deviations = IF_FEATURE_NAMES.map((feature, index) => {
    const column = matrix.map((entry) => entry[index]!).sort((a, b) => a - b);
    const columnMedian = median(column);
    const mad = median(column.map((value) => Math.abs(value - columnMedian)).sort((a, b) => a - b));
    // MATERIALITY FLOOR. In a steady column MAD collapses toward zero, and an
    // ordinary ±2% wobble would read as "2 MAD units" — inflating noise into a
    // reason. Flooring the spread at 5% of the median's magnitude applies the
    // same statistical-AND-material discipline the rule detectors use.
    const spread = Math.max(mad, 0.05 * Math.max(Math.abs(columnMedian), 0.1));
    const deviation = Math.abs(row[index]! - columnMedian) / spread;
    return { feature, deviation, label: IF_FEATURE_LABELS[feature] };
  })
    // Only contextual features make readable reasons — "weekdaySin deviates"
    // explains nothing an owner can act on.
    .filter((entry) => contextual.includes(entry.feature) && entry.deviation >= 2);

  const seenLabels = new Set<string>();
  const distinct = deviations
    .sort((a, b) => b.deviation - a.deviation)
    .filter((entry) => {
      if (seenLabels.has(entry.label)) return false;
      seenLabels.add(entry.label);
      return true;
    });
  return distinct.slice(0, limit);
}
