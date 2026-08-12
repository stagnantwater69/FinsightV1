import { AnomalyFindingFeedback, AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { listFindings, reviewFinding, saveFinding } from "../../src/services/anomalyDetection/finding.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let bob: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let expenseRecordId: number;

beforeEach(async () => {
  await resetDb();
  alice = await makeOwnerWithProfile({ name: "Alice's Store" });
  bob = await makeOwnerWithProfile({ name: "Bob's Store" });
  expenseRecordId = (
    await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Inventory!,
      date: utcDayString(),
      description: "Bulk rice delivery",
      amount: 30_000,
    })
  ).id;
});

afterAll(disconnectDb);

function amountFinding() {
  return {
    fingerprint: `amount-v1:${expenseRecordId}`,
    businessProfileId: alice.profile.id,
    expenseRecordId,
    type: AnomalyFindingType.AMOUNT_OUTLIER,
    severity: AnomalyFindingSeverity.HIGH,
    score: 3.2,
    method: "z-score",
    title: "Unusual inventory expense",
    reasons: ["Amount is materially above the category baseline"],
    metadata: { categoryMean: 5_650 },
    detectorVersion: "amount-v1",
  };
}

describe("anomaly finding persistence", () => {
  it("upserts detector retries instead of duplicating a finding", async () => {
    const first = await saveFinding(amountFinding());
    const second = await saveFinding({ ...amountFinding(), score: 3.4 });

    expect(second.id).toBe(first.id);
    expect(Number(second.score)).toBe(3.4);
    expect(await prisma.anomalyFinding.count()).toBe(1);
  });

  it("scopes an identical detector fingerprint to its business", async () => {
    await saveFinding(amountFinding());
    await saveFinding({
      ...amountFinding(),
      businessProfileId: bob.profile.id,
      expenseRecordId: undefined,
    });

    expect(await prisma.anomalyFinding.count()).toBe(2);
  });

  it("does not let another owner list or review a finding", async () => {
    const finding = await saveFinding(amountFinding());

    await expect(listFindings(bob.user.id, alice.profile.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      reviewFinding(bob.user.id, finding.id, {
        status: AnomalyFindingStatus.DISMISSED,
        feedback: AnomalyFindingFeedback.EXPECTED_TRANSACTION,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("records an owner's review and feedback", async () => {
    const finding = await saveFinding(amountFinding());
    const reviewed = await reviewFinding(alice.user.id, finding.id, {
      status: AnomalyFindingStatus.CONFIRMED,
      feedback: AnomalyFindingFeedback.CONFIRMED_UNUSUAL,
    });

    expect(reviewed.status).toBe(AnomalyFindingStatus.CONFIRMED);
    expect(reviewed.feedback).toBe(AnomalyFindingFeedback.CONFIRMED_UNUSUAL);
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
  });
});
