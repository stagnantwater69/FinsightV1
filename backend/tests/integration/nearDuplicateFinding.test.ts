import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { detectionConfig } from "../../src/services/anomalyDetection/config";
import { detectNearDuplicateForExpense } from "../../src/services/anomalyDetection/nearDuplicate.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let bob: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

const enabled = detectionConfig({
  featureFlags: {
    amountOutlier: true,
    exactDuplicate: true,
    nearDuplicate: true,
    velocity: false,
    recurring: false,
    trends: false,
    behavioralNovelty: false,
  },
});

beforeEach(async () => {
  await resetDb();
  alice = await makeOwnerWithProfile({ name: "Alice's Store" });
  bob = await makeOwnerWithProfile({ name: "Bob's Store" });
});

afterAll(disconnectDb);

async function addExpense(
  owner: typeof alice,
  input: { day: number; amount: number; description: string; vendor?: string },
) {
  return expenses.createExpenseRecord(owner.user.id, {
    businessProfileId: owner.profile.id,
    categoryId: owner.categories.Inventory!,
    date: utcDayString(input.day),
    amount: input.amount,
    description: input.description,
    vendor: input.vendor,
  });
}

describe("near-duplicate findings", () => {
  it("persists the best explainable match without changing exact-duplicate status", async () => {
    const original = await addExpense(alice, {
      day: -2,
      amount: 5_000,
      description: "Bulk rice delivery",
      vendor: "Pure Gold Market",
    });
    const candidate = await addExpense(alice, {
      day: -1,
      amount: 5_050,
      description: "Bulk rice purchase",
      vendor: "PureGold Market",
    });

    const finding = await detectNearDuplicateForExpense(candidate.id, enabled);

    expect(finding).not.toBeNull();
    expect(finding!.type).toBe(AnomalyFindingType.POSSIBLE_DUPLICATE);
    expect(finding!.severity).toBe(AnomalyFindingSeverity.MEDIUM);
    expect(finding!.method).toBe("near-duplicate");
    expect(finding!.metadata).toMatchObject({ matchedExpenseRecordId: original.id, dateDistanceDays: 1 });
    expect(finding!.reasons).toContain("The vendor names are very similar");

    const unchanged = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(unchanged.duplicateStatus).toBe("Not a Duplicate");
    expect(unchanged.duplicateOfRecordId).toBeNull();
  });

  it("never compares records across business profiles", async () => {
    await addExpense(bob, {
      day: -2,
      amount: 5_000,
      description: "Bulk rice delivery",
      vendor: "Pure Gold Market",
    });
    const aliceCandidate = await addExpense(alice, {
      day: -1,
      amount: 5_050,
      description: "Bulk rice purchase",
      vendor: "PureGold Market",
    });

    expect(await detectNearDuplicateForExpense(aliceCandidate.id, enabled)).toBeNull();
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });

  it("defers to the deterministic exact matcher", async () => {
    const original = await addExpense(alice, {
      day: -1,
      amount: 5_000,
      description: "Rice delivery",
      vendor: "Vendor A",
    });
    const exact = await addExpense(alice, {
      day: -1,
      amount: 5_000,
      description: "RICE DELIVERY",
      vendor: "Vendor A",
    });

    expect(exact.duplicateStatus).toBe("Flagged");
    expect(exact.duplicateOfRecordId).toBe(original.id);
    expect(await detectNearDuplicateForExpense(exact.id, enabled)).toBeNull();
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });

  it("supersedes a stale finding when an edit removes the match", async () => {
    await addExpense(alice, {
      day: -2,
      amount: 5_000,
      description: "Bulk rice delivery",
      vendor: "Pure Gold Market",
    });
    const candidate = await addExpense(alice, {
      day: -1,
      amount: 5_050,
      description: "Bulk rice purchase",
      vendor: "PureGold Market",
    });
    const finding = await detectNearDuplicateForExpense(candidate.id, enabled);
    expect(finding).not.toBeNull();

    await expenses.updateExpenseRecord(alice.user.id, candidate.id, {
      amount: 900,
      description: "Electricity load",
      vendor: "Power Company",
    });
    expect(await detectNearDuplicateForExpense(candidate.id, enabled)).toBeNull();

    const stale = await prisma.anomalyFinding.findUniqueOrThrow({ where: { id: finding!.id } });
    expect(stale.status).toBe(AnomalyFindingStatus.SUPERSEDED);
  });

  it("does nothing while the detector feature flag is disabled", async () => {
    const candidate = await addExpense(alice, {
      day: -1,
      amount: 5_000,
      description: "Rice delivery",
      vendor: "Vendor A",
    });

    expect(await detectNearDuplicateForExpense(candidate.id)).toBeNull();
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });
});
