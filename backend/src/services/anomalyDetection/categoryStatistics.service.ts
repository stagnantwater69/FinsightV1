import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { utcAddDays, utcEndOfDay, utcToday } from "../../lib/dates";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { computeCategoryStats, computeQuartiles } from "../analysis.service";
import { DEFAULT_DETECTION_CONFIG, type DetectionConfig } from "./config";

export interface HistoricalExpenseAmount {
  id: number;
  categoryId: number;
  amount: Prisma.Decimal;
  date: Date;
}

/**
 * Loads a bounded number of recent records PER category. The window function
 * avoids loading an account's entire history and avoids the incorrect global
 * LIMIT that would let a busy category crowd every other category out.
 */
export async function loadBoundedCategoryHistory(
  businessProfileId: number,
  windowEnd: Date,
  windowDays = DEFAULT_DETECTION_CONFIG.baselineDays,
  maximumPerCategory = DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
): Promise<HistoricalExpenseAmount[]> {
  const windowStart = utcAddDays(windowEnd, -(windowDays - 1));
  return prisma.$queryRaw<HistoricalExpenseAmount[]>(Prisma.sql`
    SELECT ranked.id, ranked."categoryId", ranked.amount, ranked.date
    FROM (
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
    ) ranked
    WHERE ranked.row_number <= ${maximumPerCategory}
    ORDER BY ranked."categoryId", ranked.date DESC, ranked.id DESC
  `);
}

export async function refreshOwnedCategoryStatistics(
  userId: number,
  businessProfileId: number,
  asOfDate = utcToday(),
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const categories = await prisma.expenseCategory.findMany({
    where: { businessProfileId },
    select: { id: true },
  });
  const windows = [...new Set([config.shortTermBaselineDays, config.baselineDays])];
  const refreshed = [];

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

      refreshed.push(
        await prisma.categoryStatistics.upsert({
          where: { categoryId_windowDays: { categoryId: category.id, windowDays } },
          create: { ...data, categoryId: category.id, windowDays },
          update: data,
        }),
      );
    }
  }

  return refreshed;
}
