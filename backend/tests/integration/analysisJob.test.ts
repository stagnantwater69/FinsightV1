import { AnalysisJobKind, AnalysisJobStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { enqueueDailyProfileAnalyses, runAnalysisWorkerOnce } from "../../src/services/anomalyDetection/job.service";
import { reviewFinding, saveFinding } from "../../src/services/anomalyDetection/finding.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); });
afterAll(disconnectDb);

async function add() {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
    date: utcDayString(), amount: 1_000, description: "Inventory",
  });
}

describe("durable analysis jobs", () => {
  it("queues transaction analysis during record creation and completes it", async () => {
    const expense = await add();
    const pending = await prisma.analysisJob.findUniqueOrThrow({ where: { idempotencyKey: `transaction:${expense.id}` } });
    expect(pending.status).toBe(AnalysisJobStatus.PENDING);
    expect(pending.kind).toBe(AnalysisJobKind.TRANSACTION);

    expect(await runAnalysisWorkerOnce()).toBe(true);
    const completed = await prisma.analysisJob.findUniqueOrThrow({ where: { id: pending.id } });
    expect(completed.status).toBe(AnalysisJobStatus.COMPLETE);
    expect(completed.attemptCount).toBe(1);
  });

  it("requeues the same idempotent job after an edit", async () => {
    const expense = await add();
    await runAnalysisWorkerOnce();
    await expenses.updateExpenseRecord(ctx.user.id, expense.id, { amount: 1_100 });

    const jobs = await prisma.analysisJob.findMany({ where: { expenseRecordId: expense.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe(AnalysisJobStatus.PENDING);
    expect(jobs[0]!.attemptCount).toBe(0);
  });

  it("queues one daily profile refresh per profile and date", async () => {
    await enqueueDailyProfileAnalyses(utcDay());
    await enqueueDailyProfileAnalyses(utcDay());
    const jobs = await prisma.analysisJob.findMany({ where: { kind: AnalysisJobKind.PROFILE_REFRESH } });
    expect(jobs).toHaveLength(1);
  });

  it("reconciles a transaction whose enqueue was missed", async () => {
    const expense = await add();
    await prisma.analysisJob.deleteMany({ where: { expenseRecordId: expense.id } });
    await enqueueDailyProfileAnalyses(utcDay());
    expect(await prisma.analysisJob.count({ where: { expenseRecordId: expense.id, kind: AnalysisJobKind.TRANSACTION } })).toBe(1);
  });

  it("persists an amount finding and sends only one high-severity review notification", async () => {
    const amounts = [1_000, 980, 1_020, 950, 1_050, 990, 1_010];
    for (let index = 0; index < amounts.length; index++) {
      await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
        date: utcDayString(-amounts.length + index), amount: amounts[index]!, description: `Baseline ${index}`,
      });
    }
    const candidate = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
      date: utcDayString(), amount: 30_000, description: "Extreme purchase",
    });
    while (await runAnalysisWorkerOnce());

    expect(await prisma.anomalyFinding.count({ where: { expenseRecordId: candidate.id, type: "AMOUNT_OUTLIER" } })).toBe(1);
    expect(await prisma.notification.count({ where: { expenseRecordId: candidate.id, type: "Anomaly Finding" } })).toBe(1);

    await expenses.updateExpenseRecord(ctx.user.id, candidate.id, { description: "Extreme purchase edited" });
    while (await runAnalysisWorkerOnce());
    expect(await prisma.notification.count({ where: { expenseRecordId: candidate.id, type: "Anomaly Finding" } })).toBe(1);
  });

  it("reports a big purchase in a wide category as MEDIUM, without notifying", async () => {
    const amounts = [300, 450, 600, 800, 1_200, 1_500, 2_000, 2_600, 900, 700];
    for (let index = 0; index < amounts.length; index++) {
      await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
        date: utcDayString(-amounts.length + index), amount: amounts[index]!, description: `Supply run ${index}`,
      });
    }
    const candidate = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
      date: utcDayString(), amount: 3_000, description: "Large supply run",
    });
    while (await runAnalysisWorkerOnce());

    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { expenseRecordId: candidate.id, type: "AMOUNT_OUTLIER" } });
    expect(finding.severity).toBe("MEDIUM");
    expect(finding.detectorVersion).toBe("amount-outlier-v2");
    expect(finding.fingerprint).toBe(`amount-outlier-v1:${candidate.id}`);
    expect(await prisma.notification.count({ where: { expenseRecordId: candidate.id, type: "Anomaly Finding" } })).toBe(0);
  });

  describe("after the owner has answered earlier amount findings", () => {
    // Candidate 1,270: z ~ 2.2 and just past the 1.5 IQR fence (1,250), but
    // inside the stricter z of 3 and 3 IQR fence (1,437.50).
    async function answeredThreeTimes(feedback: "EXPECTED_TRANSACTION" | "CONFIRMED_UNUSUAL") {
      const amounts = [800, 900, 1_000, 1_100, 1_200, 950, 1_050, 1_000];
      const baseline = [];
      for (let index = 0; index < amounts.length; index++) {
        baseline.push(await expenses.createExpenseRecord(ctx.user.id, {
          businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
          date: utcDayString(-amounts.length + index), amount: amounts[index]!, description: `Restock ${index}`,
        }));
      }
      while (await runAnalysisWorkerOnce());
      for (const record of baseline.slice(0, 3)) {
        const finding = await saveFinding({
          fingerprint: `answered:${record.id}`, businessProfileId: ctx.profile.id, expenseRecordId: record.id,
          type: "AMOUNT_OUTLIER", severity: "MEDIUM", method: "z-score-iqr", title: "Unusual Inventory expense",
          reasons: ["Earlier finding"], detectorVersion: "amount-outlier-v2",
        });
        await reviewFinding(ctx.user.id, finding.id, {
          status: feedback === "EXPECTED_TRANSACTION" ? "DISMISSED" : "CONFIRMED", feedback,
        });
      }
      const candidate = await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
        date: utcDayString(), amount: 1_270, description: "Bigger restock",
      });
      while (await runAnalysisWorkerOnce());
      return prisma.anomalyFinding.findFirst({ where: { expenseRecordId: candidate.id, method: "z-score-iqr" } });
    }

    it("raises the category's bar when the owner kept saying normal", async () => {
      expect(await answeredThreeTimes("EXPECTED_TRANSACTION")).toBeNull();
    });

    it("keeps the usual bar when the owner said unusual", async () => {
      const finding = await answeredThreeTimes("CONFIRMED_UNUSUAL");
      expect(finding).not.toBeNull();
      expect(finding!.metadata).toMatchObject({ stricterAfterFeedback: false });
    });
  });

  it("saves the finding for an imported outlier without notifying the owner", async () => {
    const amounts = [1_000, 980, 1_020, 950, 1_050, 990, 1_010];
    for (let index = 0; index < amounts.length; index++) {
      await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
        date: utcDayString(-amounts.length + index), amount: amounts[index]!, description: `Baseline ${index}`,
      });
    }
    const candidate = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
      date: utcDayString(), amount: 30_000, description: "Imported extreme purchase",
    });
    await prisma.expenseRecord.update({ where: { id: candidate.id }, data: { source: "CSV_UPLOAD" } });
    while (await runAnalysisWorkerOnce());

    expect(await prisma.anomalyFinding.count({ where: { expenseRecordId: candidate.id, type: "AMOUNT_OUTLIER" } })).toBe(1);
    expect(await prisma.notification.count({ where: { expenseRecordId: candidate.id, type: "Anomaly Finding" } })).toBe(0);
  });
});
