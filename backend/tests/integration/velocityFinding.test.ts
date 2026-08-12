import { AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as expenses from "../../src/services/expenseRecord.service";
import { detectionConfig } from "../../src/services/anomalyDetection/config";
import { detectVelocityForExpense } from "../../src/services/anomalyDetection/velocity.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const enabled = detectionConfig({ featureFlags: {
  amountOutlier: true, exactDuplicate: true, nearDuplicate: false, velocity: true,
  recurring: false, trends: false, behavioralNovelty: false,
} });

beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); });
afterAll(disconnectDb);

async function add(description: string, day = 0, vendor = "Supplier A") {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories.Inventory!,
    date: utcDayString(day), description, vendor, amount: 100,
  });
}

describe("velocity findings", () => {
  it("persists one grouped finding for a same-day burst", async () => {
    await add("First");
    await add("Second");
    const candidate = await add("Third");
    const finding = await detectVelocityForExpense(candidate.id, enabled);

    expect(finding?.type).toBe(AnomalyFindingType.VELOCITY_ANOMALY);
    expect(finding?.metadata).toMatchObject({ windowDays: 1, currentCount: 3, baselineMedianCount: 0 });
  });

  it("does not confuse database creation time with transaction date", async () => {
    await add("Imported old A", -60);
    await add("Imported old B", -30);
    const candidate = await add("Imported current", 0);
    expect(await detectVelocityForExpense(candidate.id, enabled)).toBeNull();
  });
});
