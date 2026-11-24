import {
  AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType, ExpenseRecordSource,
} from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as expenses from "../../src/services/expenseRecord.service";
import { detectionConfig } from "../../src/services/anomalyDetection/config";
import { saveFinding } from "../../src/services/anomalyDetection/finding.service";
import { VELOCITY_VERSION, detectVelocityForExpense } from "../../src/services/anomalyDetection/velocity.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const enabled = detectionConfig({ featureFlags: {
  amountOutlier: true, exactDuplicate: true, nearDuplicate: false, velocity: true,
  recurring: false, trends: false, behavioralNovelty: false,
} });

beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); });
afterAll(disconnectDb);

// Rows the 5,000-row history cap would have to cut through.
async function bulk(count: number, categoryId: number, vendor: string, dayFor: (index: number) => number) {
  await prisma.expenseRecord.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      businessProfileId: ctx.profile.id,
      categoryId,
      date: utcDay(dayFor(index)),
      description: `Bulk ${index}`,
      vendor,
      amount: 10,
      source: ExpenseRecordSource.MANUAL_ENTRY,
    })),
  });
}

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

  it("keeps the full baseline when unrelated recent rows exceed the history cap", async () => {
    // Four rows a week apart in each of the five 30-day windows: a steady month.
    for (let window = 4; window >= 1; window--) {
      for (const offset of [0, 7, 14, 21]) await add(`W${window}-${offset}`, -(window * 30 + offset));
    }
    for (const day of [-21, -14, -7]) await add(`Current ${day}`, day);
    await bulk(5_001, ctx.categories.Utilities!, "Unrelated Vendor", (index) => -22 - (index % 38));
    const candidate = await add("Current 0", 0);

    expect(await detectVelocityForExpense(candidate.id, enabled)).toBeNull();
    expect(await prisma.anomalyFinding.count({
      where: { expenseRecordId: candidate.id, type: AnomalyFindingType.VELOCITY_ANOMALY },
    })).toBe(0);
  });

  it("leaves an open finding alone when the comparable history hits the cap", async () => {
    const candidate = await add("Candidate", 0);
    const existing = await saveFinding({
      fingerprint: `${VELOCITY_VERSION}:${candidate.id}`,
      businessProfileId: ctx.profile.id,
      expenseRecordId: candidate.id,
      type: AnomalyFindingType.VELOCITY_ANOMALY,
      severity: AnomalyFindingSeverity.MEDIUM,
      score: 0.6,
      method: "rolling-velocity",
      title: "Unusual transaction frequency",
      reasons: ["seeded"],
      metadata: {},
      detectorVersion: VELOCITY_VERSION,
    });
    // ~34 same-category rows a day on every earlier day: the cap trims only the oldest days,
    // so a truncated read looks normal and would have superseded the finding.
    await bulk(5_100, ctx.categories.Inventory!, "Supplier A", (index) => -1 - (index % 149));

    expect(await detectVelocityForExpense(candidate.id, enabled)).toBeNull();
    expect((await prisma.anomalyFinding.findUniqueOrThrow({ where: { id: existing.id } })).status)
      .toBe(AnomalyFindingStatus.OPEN);
  });
});
