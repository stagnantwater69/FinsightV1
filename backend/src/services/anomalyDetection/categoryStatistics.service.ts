import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay, utcToday } from "../../lib/dates";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { computeCategoryStats, computeQuartiles, MIN_HISTORY_FOR_DETECTION } from "../analysis.service";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";
import { runAnalysisMutation, type AnalysisMutationGuard } from "./mutationGuard";

export interface HistoricalExpenseAmount {
  id: number;
  categoryId: number;
  amount: Prisma.Decimal;
  date: Date;
}

export interface CategoryHistoryCoverage {
  eligibleCategoryCount: number;
  insufficientHistoryCategoryCount: number;
}

export interface CategoryCoverageWindow {
  start?: Date;
  end: Date;
}

function datePredicate(window: CategoryCoverageWindow): Prisma.Sql {
  return Prisma.sql`
    ${window.start ? Prisma.sql`AND er."ExpenseRecord_Date" >= ${window.start}` : Prisma.sql``}
    AND er."ExpenseRecord_Date" <= ${window.end}
  `;
}

/** Counts analysis-eligible categories without loading their expense rows. */
export async function loadCategoryHistoryCoverage(
  businessProfileId: number,
  windowEnd: Date,
  windowDays = DEFAULT_DETECTION_CONFIG.baselineDays,
  currentWindow?: CategoryCoverageWindow,
  previousWindow?: CategoryCoverageWindow,
): Promise<CategoryHistoryCoverage> {
  const windowStart = utcAddDays(windowEnd, -(windowDays - 1));
  const baselineRecords = Prisma.sql`
    SELECT er."ExpenseRecord_ID" AS id, er."Category_ID" AS category_id
    FROM "ExpenseRecord" er
    WHERE er."BusinessProfile_ID" = ${businessProfileId}
      AND er."ExpenseRecord_Date" >= ${windowStart}
      AND er."ExpenseRecord_Date" <= ${utcEndOfDay(windowEnd)}
  `;
  const currentRecords = currentWindow
    ? Prisma.sql`
        SELECT er."ExpenseRecord_ID" AS id, er."Category_ID" AS category_id
        FROM "ExpenseRecord" er
        WHERE er."BusinessProfile_ID" = ${businessProfileId}
          ${datePredicate(currentWindow)}
      `
    : baselineRecords;
  const eligibleCategories = currentWindow
    ? Prisma.sql`
        SELECT DISTINCT er."Category_ID" AS category_id
        FROM "ExpenseRecord" er
        WHERE er."BusinessProfile_ID" = ${businessProfileId}
          ${datePredicate(currentWindow)}
        ${previousWindow
          ? Prisma.sql`
              UNION
              SELECT DISTINCT er."Category_ID" AS category_id
              FROM "ExpenseRecord" er
              WHERE er."BusinessProfile_ID" = ${businessProfileId}
                ${datePredicate(previousWindow)}
            `
          : Prisma.sql``}
      `
    : Prisma.sql`SELECT DISTINCT baseline.category_id FROM (${baselineRecords}) baseline`;
  const [coverage] = await prisma.$queryRaw<
    { eligibleCategoryCount: bigint | number; insufficientHistoryCategoryCount: bigint | number }[]
  >(Prisma.sql`
    WITH eligible_categories AS (
      ${eligibleCategories}
    ),
    analysis_records AS (
      ${baselineRecords}
      ${currentWindow ? Prisma.sql`UNION ${currentRecords}` : Prisma.sql``}
    ),
    history_counts AS (
      SELECT analysis_records.category_id, COUNT(*) AS record_count
      FROM analysis_records
      GROUP BY analysis_records.category_id
    )
    SELECT
      COUNT(*) AS "eligibleCategoryCount",
      COUNT(*) FILTER (WHERE COALESCE(history_counts.record_count, 0) < ${MIN_HISTORY_FOR_DETECTION})
        AS "insufficientHistoryCategoryCount"
    FROM eligible_categories
    LEFT JOIN history_counts ON history_counts.category_id = eligible_categories.category_id
  `);

  return {
    eligibleCategoryCount: Number(coverage?.eligibleCategoryCount ?? 0),
    insufficientHistoryCategoryCount: Number(coverage?.insufficientHistoryCategoryCount ?? 0),
  };
}

/**
 * Loads a bounded number of recent records PER category. The window function
 * avoids loading an account's entire history and avoids the incorrect global
 * LIMIT that would let a busy category crowd every other category out.
 */
async function loadBoundedCategoryHistoryRows(
  businessProfileId: number,
  windowEnd: Date,
  windowDays = DEFAULT_DETECTION_CONFIG.baselineDays,
  maximumPerCategory = DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
  maximumCategories?: number,
  selectedCategoryIds?: readonly number[],
): Promise<HistoricalExpenseAmount[]> {
  if (selectedCategoryIds?.length === 0) return [];
  const windowStart = utcAddDays(windowEnd, -(windowDays - 1));
  const categorySelection = maximumCategories === undefined || selectedCategoryIds !== undefined
    ? Prisma.sql``
    : Prisma.sql`
        selected_categories AS (
          SELECT er."Category_ID"
          FROM "ExpenseRecord" er
          WHERE er."BusinessProfile_ID" = ${businessProfileId}
            AND er."ExpenseRecord_Date" >= ${windowStart}
            AND er."ExpenseRecord_Date" <= ${utcEndOfDay(windowEnd)}
          GROUP BY er."Category_ID"
          ORDER BY SUM(er."ExpenseRecord_Amount") DESC, er."Category_ID" ASC
          LIMIT ${Math.max(1, Math.floor(maximumCategories))}
        ),
      `;
  const categoryFilter = selectedCategoryIds !== undefined
    ? Prisma.sql`AND er."Category_ID" IN (${Prisma.join(selectedCategoryIds)})`
    : maximumCategories === undefined
      ? Prisma.sql``
      : Prisma.sql`AND er."Category_ID" IN (SELECT "Category_ID" FROM selected_categories)`;
  return prisma.$queryRaw<HistoricalExpenseAmount[]>(Prisma.sql`
    WITH ${categorySelection}
    ranked AS (
      SELECT
        er."ExpenseRecord_ID" AS id,
        er."Category_ID" AS "categoryId",
        er."ExpenseRecord_Amount" AS amount,
        er."ExpenseRecord_Date" AS date,
        ROW_NUMBER() OVER (
          PARTITION BY er."Category_ID"
          ORDER BY er."ExpenseRecord_Date" DESC, er."ExpenseRecord_ID" DESC
        ) AS row_number
      FROM "ExpenseRecord" er
      WHERE er."BusinessProfile_ID" = ${businessProfileId}
        AND er."ExpenseRecord_Date" >= ${windowStart}
        AND er."ExpenseRecord_Date" <= ${utcEndOfDay(windowEnd)}
        ${categoryFilter}
    )
    SELECT ranked.id, ranked."categoryId", ranked.amount, ranked.date
    FROM ranked
    WHERE ranked.row_number <= ${maximumPerCategory}
    ORDER BY ranked."categoryId", ranked.date DESC, ranked.id DESC
  `);
}

export async function loadBoundedCategoryHistory(
  businessProfileId: number,
  windowEnd: Date,
  windowDays = DEFAULT_DETECTION_CONFIG.baselineDays,
  maximumPerCategory = DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
  maximumCategories?: number,
): Promise<HistoricalExpenseAmount[]> {
  return loadBoundedCategoryHistoryRows(
    businessProfileId,
    windowEnd,
    windowDays,
    maximumPerCategory,
    maximumCategories,
  );
}

export async function loadBoundedCategoryHistoryForCategories(
  businessProfileId: number,
  windowEnd: Date,
  categoryIds: readonly number[],
  windowDays = DEFAULT_DETECTION_CONFIG.baselineDays,
  maximumPerCategory = DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
): Promise<HistoricalExpenseAmount[]> {
  return loadBoundedCategoryHistoryRows(
    businessProfileId,
    windowEnd,
    windowDays,
    maximumPerCategory,
    undefined,
    categoryIds,
  );
}

export async function refreshOwnedCategoryStatistics(
  userId: number,
  businessProfileId: number,
  asOfDate = utcToday(),
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
  mutate: AnalysisMutationGuard = runAnalysisMutation,
) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const categories = await prisma.expenseCategory.findMany({
    where: { businessProfileId },
    select: { id: true },
  });
  const windows = [...new Set([config.shortTermBaselineDays, config.baselineDays])];
  const pending: Prisma.CategoryStatisticsUncheckedCreateInput[] = [];

  for (const windowDays of windows) {
    const records = await loadBoundedCategoryHistory(
      businessProfileId,
      asOfDate,
      windowDays,
      config.maximumCategoryRecords,
    );
    const amountsByCategory = new Map<number, number[]>();
    for (const record of records) {
      const amounts = amountsByCategory.get(record.categoryId) ?? [];
      amounts.push(Number(record.amount));
      amountsByCategory.set(record.categoryId, amounts);
    }

    for (const category of categories) {
      const amounts = amountsByCategory.get(category.id) ?? [];
      const stats = amounts.length > 0 ? computeCategoryStats(amounts) : { count: 0, mean: 0, stdDev: 0 };
      const quartiles = computeQuartiles(amounts);
      const sum = amounts.reduce((total, amount) => total + amount, 0);
      const sumOfSquares = amounts.reduce((total, amount) => total + amount ** 2, 0);
      const data = {
        businessProfileId,
        windowStart: utcAddDays(asOfDate, -(windowDays - 1)),
        windowEnd: asOfDate,
        recordCount: stats.count,
        sum: new Prisma.Decimal(sum),
        sumOfSquares: new Prisma.Decimal(sumOfSquares),
        mean: new Prisma.Decimal(stats.mean),
        standardDeviation: new Prisma.Decimal(stats.stdDev),
        q1: new Prisma.Decimal(quartiles.q1),
        q3: new Prisma.Decimal(quartiles.q3),
        minimum: amounts.length === 0 ? null : new Prisma.Decimal(Math.min(...amounts)),
        maximum: amounts.length === 0 ? null : new Prisma.Decimal(Math.max(...amounts)),
        calculatedAt: new Date(),
      };

      pending.push({ ...data, categoryId: category.id, windowDays });
    }
  }

  return mutate(async (db) => {
    const refreshed = [];
    for (const data of pending) {
      const { categoryId, windowDays, ...update } = data;
      refreshed.push(await db.categoryStatistics.upsert({
        where: { categoryId_windowDays: { categoryId, windowDays } },
        create: data,
        update,
      }));
    }
    return refreshed;
  });
}
