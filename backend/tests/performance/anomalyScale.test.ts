import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { loadBoundedCategoryHistory } from "../../src/services/anomalyDetection/categoryStatistics.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay } from "../setup/testDb";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("anomaly history at mature-account scale", () => {
  it("bounds a 100,000-transaction category to the configured 1,000 records", async () => {
    const ctx = await makeOwnerWithProfile();
    const today = utcDay();
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ExpenseRecord" (
        "BusinessProfile_ID", "Category_ID", "ExpenseRecord_Date", "ExpenseRecord_Description",
        "ExpenseRecord_Amount", "ExpenseRecord_Source", "ExpenseRecord_ReviewStatus",
        "ExpenseRecord_DuplicateStatus", "ExpenseRecord_LargeExpenseFlag", "ExpenseRecord_CreatedAt"
      )
      SELECT ${ctx.profile.id}, ${ctx.categories.Inventory!}, ${today}, 'Scale transaction ' || n,
        100 + (n % 100), 'Manual Entry'::"ExpenseRecordSource", 'Reviewed', 'Not a Duplicate', false, NOW()
      FROM generate_series(1, 100000) AS n
    `);
    const started = performance.now();
    const history = await loadBoundedCategoryHistory(ctx.profile.id, today, 365, 1_000);
    const elapsedMs = performance.now() - started;

    expect(history).toHaveLength(1_000);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
