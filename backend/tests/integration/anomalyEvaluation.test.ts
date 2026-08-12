import { AnomalyFindingFeedback, AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { anomalyEvaluation } from "../../src/services/anomalyDetection/evaluation.service";
import { reviewFinding, saveFinding } from "../../src/services/anomalyDetection/finding.service";
import * as expenses from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); });
afterAll(disconnectDb);

describe("anomaly evaluation metrics", () => {
  it("reports rates by detector and per transaction", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!, date: utcDayString(), amount: 100, description: "Stock",
    });
    const finding = await saveFinding({
      fingerprint: "metrics", businessProfileId: ctx.profile.id, type: AnomalyFindingType.TREND_CHANGE,
      severity: AnomalyFindingSeverity.MEDIUM, method: "trend-test", title: "Trend", reasons: ["Changed"], detectorVersion: "v1",
    });
    await reviewFinding(ctx.user.id, finding.id, { status: AnomalyFindingStatus.CONFIRMED, feedback: AnomalyFindingFeedback.CONFIRMED_UNUSUAL });

    const metrics = await anomalyEvaluation(ctx.user.id, ctx.profile.id);
    expect(metrics.transactionCount).toBe(1);
    expect(metrics.findingsPer100Transactions).toBe(100);
    expect(metrics.detectors).toContainEqual(expect.objectContaining({ method: "trend-test", confirmationRate: 1 }));
  });
});
