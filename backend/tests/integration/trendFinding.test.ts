import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as expenses from "../../src/services/expenseRecord.service";
import { detectionConfig } from "../../src/services/anomalyDetection/config";
import { refreshTrendFindings } from "../../src/services/anomalyDetection/trend.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const enabled = detectionConfig({ featureFlags: {
  amountOutlier: true, exactDuplicate: true, nearDuplicate: false, velocity: false,
  recurring: false, trends: true, behavioralNovelty: false,
} });
beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); });
afterAll(disconnectDb);

async function add(amount: number, day: number) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
    date: utcDayString(day), amount, description: `Stock ${day}`,
  });
}

describe("trend findings", () => {
  it("requires both percentage and peso materiality", async () => {
    await add(2_000, -10); await add(6_000, -2);
    const findings = await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled);
    expect(findings.some((finding) => finding.method === "comparable-period-trend")).toBe(true);
  });

  it("suppresses a large percentage on a trivial peso change", async () => {
    await add(10, -10); await add(100, -2);
    expect(await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled)).toEqual([]);
  });
});
