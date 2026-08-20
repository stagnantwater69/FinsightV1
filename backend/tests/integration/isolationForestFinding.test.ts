import { AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { detectionConfig, DEFAULT_DETECTION_CONFIG } from "../../src/services/anomalyDetection/config";
import { refreshIsolationForestFindings } from "../../src/services/anomalyDetection/isolationForest.service";
import { listFindings, findingSummary } from "../../src/services/anomalyDetection/finding.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * The sidecar is mocked at the client boundary: these tests are about the
 * detector's product behaviour (shadow status, budget, tenant scope, fail-open),
 * not about sklearn. The real TS↔Python contract is covered separately in
 * tests/contract/mlWorkerContract.test.ts against the actual worker.
 */
vi.mock("../../src/services/anomalyDetection/mlWorkerClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/anomalyDetection/mlWorkerClient")>();
  return { ...original, scoreWithIsolationForest: vi.fn() };
});

import { scoreWithIsolationForest } from "../../src/services/anomalyDetection/mlWorkerClient";

const mockScore = vi.mocked(scoreWithIsolationForest);

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

const enabled = detectionConfig({
  featureFlags: { ...DEFAULT_DETECTION_CONFIG.featureFlags, isolationForest: true },
});

beforeEach(async () => {
  await resetDb();
  mockScore.mockReset();
  ctx = await makeOwnerWithProfile();
});
afterAll(disconnectDb);

async function seedHistory(count: number) {
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(-Math.floor(index / 2)),
      description: `stock purchase ${index}`,
      vendor: "Supplier A",
      amount: 500 + (index % 7) * 10,
    });
    ids.push(record.id);
  }
  return ids;
}

function sidecarResponse(ids: number[], anomalousId: number) {
  return {
    contractVersion: "if-contract-v1" as const,
    modelVersion: "iforest-v1",
    sklearnVersion: "1.9.0",
    trainedRows: ids.length,
    featureCount: 18,
    scores: ids.map((id, index) => ({
      id,
      decisionValue: id === anomalousId ? -0.21 : 0.11,
      normalizedScore: id === anomalousId ? 1 : index / Math.max(ids.length, 2) / 2,
    })),
  };
}

describe("isolation forest shadow detector", () => {
  it("does nothing when the flag is off", async () => {
    await seedHistory(110);
    const result = await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, DEFAULT_DETECTION_CONFIG);
    expect(result).toBeNull();
    expect(mockScore).not.toHaveBeenCalled();
  });

  it("skips cold-start profiles below the history minimum", async () => {
    await seedHistory(30);
    const result = await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, enabled);
    expect(result).toBeNull();
    expect(mockScore).not.toHaveBeenCalled();
  });

  it("fails open when the sidecar is unavailable", async () => {
    await seedHistory(110);
    mockScore.mockResolvedValue(null);
    const result = await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, enabled);
    expect(result).toBeNull();
    expect(await prisma.anomalyFinding.count()).toBe(0);
  });

  it("persists SHADOW findings that never notify and never reach the findings API", async () => {
    const ids = await seedHistory(110);
    const anomalousId = ids.at(-1)!;
    mockScore.mockResolvedValue(sidecarResponse(ids, anomalousId));

    const saved = await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, enabled);
    expect(saved).toBe(1);

    const finding = await prisma.anomalyFinding.findFirstOrThrow({ where: { method: "isolation-forest" } });
    expect(finding.status).toBe(AnomalyFindingStatus.SHADOW);
    expect(finding.type).toBe(AnomalyFindingType.ML_OUTLIER);
    expect(finding.expenseRecordId).toBe(anomalousId);
    expect(finding.severity).not.toBe("HIGH");
    expect(finding.metadata).toMatchObject({
      modelVersion: "iforest-v1",
      featureVersion: "if-features-v1",
      trainingWindowDays: 365,
    });
    expect((finding.reasons as string[]).length).toBeGreaterThan(0);

    // Invisible to the owner: not listed (even when asked for), not summarised,
    // and no notification was created.
    const listed = await listFindings(ctx.user.id, ctx.profile.id, {});
    expect(listed.find((entry) => entry.method === "isolation-forest")).toBeUndefined();
    const listedExplicit = await listFindings(ctx.user.id, ctx.profile.id, {
      status: AnomalyFindingStatus.SHADOW,
    });
    expect(listedExplicit).toHaveLength(0);
    const summary = await findingSummary(ctx.user.id, ctx.profile.id);
    expect(summary.byType.ML_OUTLIER).toBeUndefined();
    expect(await prisma.notification.count()).toBe(0);
  });

  it("re-running supersedes records that left the anomalous band (idempotent view)", async () => {
    const ids = await seedHistory(110);
    const first = ids.at(-1)!;
    const second = ids.at(-2)!;
    mockScore.mockResolvedValueOnce(sidecarResponse(ids, first));
    await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, enabled);
    mockScore.mockResolvedValueOnce(sidecarResponse(ids, second));
    await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, enabled);

    const findings = await prisma.anomalyFinding.findMany({ where: { method: "isolation-forest" }, orderBy: { id: "asc" } });
    expect(findings).toHaveLength(2);
    expect(findings.find((entry) => entry.expenseRecordId === first)?.status).toBe(AnomalyFindingStatus.SUPERSEDED);
    expect(findings.find((entry) => entry.expenseRecordId === second)?.status).toBe(AnomalyFindingStatus.SHADOW);
  });

  it("enforces the alert budget even when the sidecar flags everything", async () => {
    const ids = await seedHistory(110);
    mockScore.mockResolvedValue({
      contractVersion: "if-contract-v1" as const,
      modelVersion: "iforest-v1",
      sklearnVersion: "1.9.0",
      trainedRows: ids.length,
      featureCount: 18,
      scores: ids.map((id) => ({ id, decisionValue: -0.3, normalizedScore: 1 })),
    });
    const saved = await refreshIsolationForestFindings(ctx.user.id, ctx.profile.id, enabled);
    // 110 records × 2 per 100 → budget of 2.
    expect(saved).toBe(2);
    expect(await prisma.anomalyFinding.count({ where: { status: AnomalyFindingStatus.SHADOW } })).toBe(2);
  });

  it("never crosses business-profile boundaries", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    await seedHistory(110);
    // A different owner asking about Alice's profile gets nothing and no call.
    const result = await refreshIsolationForestFindings(other.user.id, ctx.profile.id, enabled);
    expect(result).toBeNull();
    expect(mockScore).not.toHaveBeenCalled();
  });
});
