import { AnomalyFindingType, RecurringPatternStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { refreshRecurringPatterns, reviewRecurringPattern } from "../../src/services/anomalyDetection/recurring.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => { await resetDb(); ctx = await makeOwnerWithProfile(); });
afterAll(disconnectDb);

async function add(date: string, amount = 1_000) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id, categoryId: ctx.categories.Utilities!,
    date, amount, description: "Monthly electricity", vendor: "Power Co.",
  });
}

describe("recurring pattern persistence", () => {
  it("discovers a candidate but waits for owner confirmation before warning", async () => {
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const patterns = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, new Date("2026-03-05T00:00:00Z"));

    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.status).toBe(RecurringPatternStatus.CANDIDATE);
    expect(patterns[0]!.observationCount).toBe(3);
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });

  it("flags a missing confirmed recurring expense", async () => {
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const [pattern] = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, new Date("2026-03-05T00:00:00Z"));
    await reviewRecurringPattern(ctx.user.id, pattern!.id, RecurringPatternStatus.CONFIRMED);
    await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, new Date("2026-04-10T00:00:00Z"));

    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect(finding.type).toBe(AnomalyFindingType.RECURRING_CHANGE);
    expect(finding.method).toBe("recurring-missing");
  });

  it("protects pattern review by ownership", async () => {
    await add("2026-01-01"); await add("2026-01-31"); await add("2026-03-02");
    const [pattern] = await refreshRecurringPatterns(ctx.user.id, ctx.profile.id, new Date("2026-03-05T00:00:00Z"));
    const other = await makeOwnerWithProfile({ name: "Other" });
    await expect(reviewRecurringPattern(other.user.id, pattern!.id, RecurringPatternStatus.CONFIRMED)).rejects.toMatchObject({ status: 404 });
  });
});
