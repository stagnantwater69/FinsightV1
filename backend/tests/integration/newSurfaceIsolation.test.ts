import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/storage.service", () => ({
  uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
  downloadCsvFile: vi.fn(async () => Buffer.from("")),
  deleteCsvFile: vi.fn(async () => true),
  uploadReceiptImage: vi.fn(async () => "test/mock-receipt.jpg"),
}));

import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import { confirmImport, getImportBatchStatus } from "../../src/services/csvImport.service";
import { anomalyEvaluation } from "../../src/services/anomalyDetection/evaluation.service";
import { listFindings, findingSummary, reviewFinding } from "../../src/services/anomalyDetection/finding.service";
import { refreshIsolationForestFindings } from "../../src/services/anomalyDetection/isolationForest.service";
import { DEFAULT_DETECTION_CONFIG, detectionConfig } from "../../src/services/anomalyDetection/config";
import { buildModuleContext } from "../../src/services/aiContext.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * P0 GUARD FOR EVERY SURFACE THIS PROGRAM ADDED.
 *
 * The project's first non-negotiable is that no query, matrix, import,
 * finding or context may cross a business-profile boundary. Each new entry
 * point gets its own case here rather than trusting that it inherited the
 * rule — an ownership regression is the one defect class that must fail the
 * build rather than be discovered later.
 */

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let mallory: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  alice = await makeOwnerWithProfile({ name: "Alice's Store" }, ["Inventory"]);
  mallory = await makeOwnerWithProfile({ name: "Mallory's Store" }, ["Inventory"]);
});

afterAll(disconnectDb);

async function aliceImport(key: string) {
  return confirmImport(alice.user.id, {
    businessProfileId: alice.profile.id,
    recordType: "expense",
    title: "Alice's books",
    buffer: Buffer.from(["Date,Description,Amount,Category", `${utcDayString(0)},Rice,1200,Inventory`].join("\n")),
    originalname: "alice.csv",
    columnMapping: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
    idempotencyKey: key,
  });
}

describe("CSV import state machine", () => {
  it("hides another owner's import status behind a 404, not a 403", async () => {
    const batch = await aliceImport("iso-status-1");
    // 404 rather than 403 deliberately: a 403 would confirm the batch exists.
    await expect(getImportBatchStatus(mallory.user.id, batch.batchId)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an import aimed at a profile the caller does not own", async () => {
    await expect(
      confirmImport(mallory.user.id, {
        businessProfileId: alice.profile.id,
        recordType: "expense",
        title: "Not mine",
        buffer: Buffer.from(["Date,Description,Amount,Category", `${utcDayString(0)},X,10,Inventory`].join("\n")),
        originalname: "x.csv",
        columnMapping: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
        idempotencyKey: "iso-cross-1",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: alice.profile.id } })).toBe(0);
  });

  it("does not let a replayed key read another owner's import", async () => {
    await aliceImport("iso-replay-1");
    await expect(
      confirmImport(mallory.user.id, {
        businessProfileId: mallory.profile.id,
        recordType: "expense",
        title: "Replay probe",
        buffer: Buffer.from(["Date,Description,Amount,Category", `${utcDayString(0)},Y,10,Inventory`].join("\n")),
        originalname: "y.csv",
        columnMapping: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
        idempotencyKey: "iso-replay-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps imported records and their categories inside the importing profile", async () => {
    await aliceImport("iso-scope-1");
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: mallory.profile.id } })).toBe(0);
    const strayCategories = await prisma.expenseCategory.count({
      where: { businessProfileId: mallory.profile.id, name: { not: "Inventory" } },
    });
    expect(strayCategories).toBe(0);
  });
});

describe("Isolation Forest shadow detector", () => {
  const enabled = detectionConfig({
    featureFlags: { ...DEFAULT_DETECTION_CONFIG.featureFlags, isolationForest: true },
  });

  it("scores nothing when the caller does not own the profile", async () => {
    const result = await refreshIsolationForestFindings(mallory.user.id, alice.profile.id, enabled);
    expect(result).toBeNull();
  });

  it("keeps SHADOW findings out of the owner's own findings API and summary", async () => {
    await prisma.anomalyFinding.create({
      data: {
        businessProfileId: alice.profile.id,
        fingerprint: "isolation-forest-v1:shadow-probe",
        type: AnomalyFindingType.ML_OUTLIER,
        method: "isolation-forest",
        severity: AnomalyFindingSeverity.MEDIUM,
        title: "Unusual combination of transaction characteristics",
        reasons: ["probe"],
        detectorVersion: "isolation-forest-v1",
        status: AnomalyFindingStatus.SHADOW,
      },
    });

    expect(await listFindings(alice.user.id, alice.profile.id, {})).toHaveLength(0);
    // Even asking for them by name must not surface them.
    expect(
      await listFindings(alice.user.id, alice.profile.id, { status: AnomalyFindingStatus.SHADOW }),
    ).toHaveLength(0);
    const summary = await findingSummary(alice.user.id, alice.profile.id);
    expect(summary.open).toBe(0);
    expect(summary.byType.ML_OUTLIER).toBeUndefined();
  });

  it("never lets a shadow finding be reviewed by another owner", async () => {
    const finding = await prisma.anomalyFinding.create({
      data: {
        businessProfileId: alice.profile.id,
        fingerprint: "isolation-forest-v1:review-probe",
        type: AnomalyFindingType.ML_OUTLIER,
        method: "isolation-forest",
        severity: AnomalyFindingSeverity.LOW,
        title: "Unusual combination",
        reasons: ["probe"],
        detectorVersion: "isolation-forest-v1",
        status: AnomalyFindingStatus.SHADOW,
      },
    });
    await expect(
      reviewFinding(mallory.user.id, finding.id, { status: "DISMISSED", feedback: "EXPECTED_TRANSACTION" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("scopes the shadow overlap metric to the asking owner", async () => {
    await expect(anomalyEvaluation(mallory.user.id, alice.profile.id)).rejects.toMatchObject({ status: 404 });
    const own = await anomalyEvaluation(alice.user.id, alice.profile.id);
    expect(own.shadow).toEqual({ mlShadowFindings: 0, overlappingWithRules: 0, mlOnly: 0 });
  });
});

describe("Records Review AI context", () => {
  it("is built only from the asking owner's own findings", async () => {
    await prisma.anomalyFinding.create({
      data: {
        businessProfileId: mallory.profile.id,
        fingerprint: "amount-outlier-v1:mallory-secret",
        type: AnomalyFindingType.AMOUNT_OUTLIER,
        method: "z-score-iqr",
        severity: AnomalyFindingSeverity.HIGH,
        title: "MALLORY SECRET FINDING",
        reasons: ["mallory's private reason"],
        detectorVersion: "amount-outlier-v1",
        status: AnomalyFindingStatus.OPEN,
      },
    });

    const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: alice.profile.id } });
    const { context } = await buildModuleContext(alice.user.id, profile, "Records Review", "explain this flag");

    expect(context).not.toContain("MALLORY SECRET");
    expect(context).not.toContain("mallory's private reason");
    // And it must still carry the framing that keeps the model honest.
    expect(context).toMatch(/NOT confirmed fraud|never assert wrongdoing/i);
  });
});
