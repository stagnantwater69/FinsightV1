import { AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
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

/** One PHP 2,000 purchase in each of the seven weeks before this one, from `firstDay` back. */
async function weeklyBaseline(firstDay: number) {
  for (let week = 0; week < 7; week++) await add(2_000, firstDay - 7 * week);
}

describe("trend findings", () => {
  it("requires both percentage and peso materiality", async () => {
    await weeklyBaseline(-10); await add(6_000, -2);
    const findings = await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled);
    expect(findings.some((finding) => finding.method === "comparable-period-trend")).toBe(true);
  });

  it("suppresses a large percentage on a trivial peso change", async () => {
    await add(10, -10); await add(100, -2);
    expect(await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled)).toEqual([]);
  });

  it("keeps one stable open finding when the same trend continues the next day", async () => {
    await weeklyBaseline(-9);
    await add(6_000, -2);

    await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled);
    await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(1), enabled);

    const weekly = await prisma.anomalyFinding.findMany({
      where: {
        businessProfileId: ctx.profile.id,
        type: AnomalyFindingType.TREND_CHANGE,
        status: AnomalyFindingStatus.OPEN,
        fingerprint: { endsWith: ":7" },
      },
    });
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.fingerprint).toBe(`trend-v1:${ctx.categories.Inventory}:7`);
  });

  it("does not report a weekly swing for a bill paid once a month", async () => {
    await add(15_000, -9);
    await add(15_000, -39);
    expect(await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled)).toEqual([]);
  });

  it("supersedes a previously open trend when the current records no longer produce it", async () => {
    await weeklyBaseline(-9);
    await add(6_000, -2);
    const [created] = await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled);
    expect(created).toBeDefined();

    await prisma.expenseRecord.deleteMany({ where: { businessProfileId: ctx.profile.id } });
    expect(await refreshTrendFindings(ctx.user.id, ctx.profile.id, utcDay(), enabled)).toEqual([]);

    const stored = await prisma.anomalyFinding.findUniqueOrThrow({ where: { id: created!.id } });
    expect(stored.status).toBe(AnomalyFindingStatus.SUPERSEDED);
  });
});
