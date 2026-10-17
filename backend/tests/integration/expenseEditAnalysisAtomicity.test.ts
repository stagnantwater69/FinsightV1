import { AnalysisJobStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const analysis = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../../src/services/anomalyDetection/job.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/anomalyDetection/job.service")>();
  return {
    ...actual,
    enqueueExpenseAnalysis: async (...args: Parameters<typeof actual.enqueueExpenseAnalysis>) => {
      analysis.calls += 1;
      if (analysis.fail) throw new Error("simulated durable analysis intent failure");
      return actual.enqueueExpenseAnalysis(...args);
    },
  };
});

import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { runAnalysisWorkerOnce } from "../../src/services/anomalyDetection/job.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => {
  analysis.fail = false;
  analysis.calls = 0;
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
});
afterAll(disconnectDb);

async function completedExpense() {
  const record = await expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!,
    date: utcDayString(), amount: 1_000, description: "Inventory",
  });
  expect(await runAnalysisWorkerOnce()).toBe(true);
  const job = await prisma.analysisJob.findUniqueOrThrow({ where: { idempotencyKey: `transaction:${record.id}` } });
  expect(job.status).toBe(AnalysisJobStatus.COMPLETE);
  return { record, job };
}

describe("expense edit durable analysis intent", () => {
  it("rolls back an edit if rearming its completed job fails, then processes a successful retry", async () => {
    const { record, job } = await completedExpense();
    analysis.fail = true;
    await expect(expenses.updateExpenseRecord(ctx.user.id, record.id, { amount: 1_400, description: "Edited inventory" }))
      .rejects.toThrow("simulated durable analysis intent failure");
    const unchanged = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(unchanged.amount.toString()).toBe("1000");
    expect(unchanged.description).toBe("Inventory");
    expect(await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);

    analysis.fail = false;
    const edited = await expenses.updateExpenseRecord(ctx.user.id, record.id, { amount: 1_400, description: "Edited inventory" });
    expect(edited.amount).toBe(1_400);
    const rearmed = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(rearmed.status).toBe(AnalysisJobStatus.PENDING);
    expect(rearmed.attemptCount).toBe(0);
    expect(await prisma.analysisJob.count({ where: { expenseRecordId: record.id } })).toBe(1);
    expect(await runAnalysisWorkerOnce()).toBe(true);
    expect((await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(AnalysisJobStatus.COMPLETE);
    expect((await prisma.expenseRecord.findUniqueOrThrow({ where: { id: record.id } })).description).toBe("Edited inventory");
  });

  it("keeps a review-only edit independent of analysis rearming", async () => {
    const { record, job } = await completedExpense();
    analysis.calls = 0;
    analysis.fail = true;
    const edited = await expenses.updateExpenseRecord(ctx.user.id, record.id, { reviewStatus: "Reviewed" });
    expect(edited.reviewStatus).toBe("Reviewed");
    expect(analysis.calls).toBe(0);
    expect(await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
  });
});
