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
 * Loads a bounded number of recent records PER category, so a busy category
 * cannot crowd the others out the way one global LIMIT would.
 *
 * Each category's newest rows are read straight off
 * ExpenseRecord_profile_category_date_id_idx. Ranking the whole window with
 * ROW_NUMBER() instead sorted every record in it: on a 200,000-record year
 * that was 104-131 ms to keep 8,000 rows, against 17-19 ms read per category,
 * with identical rows in identical order. This query ran on every Expense
 * Insights and dashboard expense-overview request.
 *
 * The categories are the ones the business's own records use, found by
 * walking that index one category at a time (a handful of probes rather than
 * a scan), not the business's category list: nothing in the schema stops a
 * record pointing at another business's category, and the result must not
 * depend on that never happening.
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
  const categories = selectedCategoryIds !== undefined
    ? Prisma.sql`
        categories AS (
          SELECT DISTINCT selected.id
          FROM unnest(ARRAY[${Prisma.join(selectedCategoryIds)}]::integer[]) AS selected(id)
        )`
    : maximumCategories !== undefined
      ? Prisma.sql`
          categories AS (
            SELECT er."Category_ID" AS id
            FROM "ExpenseRecord" er
            WHERE er."BusinessProfile_ID" = ${businessProfileId}
              AND er."ExpenseRecord_Date" >= ${windowStart}
              AND er."ExpenseRecord_Date" <= ${utcEndOfDay(windowEnd)}
            GROUP BY er."Category_ID"
            ORDER BY SUM(er."ExpenseRecord_Amount") DESC, er."Category_ID" ASC
            LIMIT ${Math.max(1, Math.floor(maximumCategories))}
          )`
      : Prisma.sql`
          RECURSIVE categories AS (
            (
              SELECT er."Category_ID" AS id
              FROM "ExpenseRecord" er
              WHERE er."BusinessProfile_ID" = ${businessProfileId}
              ORDER BY er."Category_ID"
              LIMIT 1
            )
            UNION ALL
            SELECT (
              SELECT er."Category_ID"
              FROM "ExpenseRecord" er
              WHERE er."BusinessProfile_ID" = ${businessProfileId}
                AND er."Category_ID" > categories.id
              ORDER BY er."Category_ID"
              LIMIT 1
            )
            FROM categories
            WHERE categories.id IS NOT NULL
          )`;
  return prisma.$queryRaw<HistoricalExpenseAmount[]>(Prisma.sql`
    WITH ${categories}
    SELECT history.id, history."categoryId", history.amount, history.date
    FROM categories
    CROSS JOIN LATERAL (
      SELECT
        er."ExpenseRecord_ID" AS id,
        er."Category_ID" AS "categoryId",
        er."ExpenseRecord_Amount" AS amount,
        er."ExpenseRecord_Date" AS date
      FROM "ExpenseRecord" er
      WHERE er."BusinessProfile_ID" = ${businessProfileId}
        AND er."Category_ID" = categories.id
        AND er."ExpenseRecord_Date" >= ${windowStart}
        AND er."ExpenseRecord_Date" <= ${utcEndOfDay(windowEnd)}
      ORDER BY er."ExpenseRecord_Date" DESC, er."ExpenseRecord_ID" DESC
      LIMIT ${maximumPerCategory}
    ) history
    WHERE categories.id IS NOT NULL
    ORDER BY history."categoryId", history.date DESC, history.id DESC
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
