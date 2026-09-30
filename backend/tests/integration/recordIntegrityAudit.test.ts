import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main, runRecordIntegrityAudit } from "../../scripts/record-integrity-audit";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay } from "../setup/testDb";

beforeEach(resetDb);
afterAll(disconnectDb);

const auditUrl = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL missing from integration test");
  return value;
};

async function recordLinkSnapshot() {
  const [expense, sales] = await Promise.all([
    prisma.expenseRecord.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        businessProfileId: true,
        categoryId: true,
        receiptScanId: true,
        importBatchId: true,
        duplicateStatus: true,
        duplicateOfRecordId: true,
      },
    }),
    prisma.salesReferenceRecord.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        businessProfileId: true,
        importBatchId: true,
        duplicateStatus: true,
        duplicateOfRecordId: true,
      },
    }),
  ]);
  return { expense, sales };
}

async function seedExpenseCycle(input: {
  businessProfileId: number;
  categoryId: number;
  length: number;
  label: string;
}) {
  const ids: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = await prisma.expenseRecord.create({
      data: {
        businessProfileId: input.businessProfileId,
        categoryId: input.categoryId,
        date: utcDay(),
        description: input.label,
        vendor: input.label,
        amount: new Prisma.Decimal(100),
        source: "MANUAL_ENTRY",
        reviewStatus: "Reviewed",
        duplicateStatus: "Flagged",
        duplicateOfRecordId: ids.at(-1) ?? null,
      },
    });
    ids.push(record.id);
  }
  await prisma.expenseRecord.update({
    where: { id: ids[0]! },
    data: { duplicateOfRecordId: ids.at(-1)! },
  });
}

async function seedSalesCycle(input: {
  businessProfileId: number;
  length: number;
  label: string;
}) {
  const ids: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = await prisma.salesReferenceRecord.create({
      data: {
        businessProfileId: input.businessProfileId,
        date: utcDay(),
        description: input.label,
        amount: new Prisma.Decimal(100),
        source: "MANUAL_ENTRY",
        reviewStatus: "Reviewed",
        duplicateStatus: "Flagged",
        duplicateOfRecordId: ids.at(-1) ?? null,
      },
    });
    ids.push(record.id);
  }
  await prisma.salesReferenceRecord.update({
    where: { id: ids[0]! },
    data: { duplicateOfRecordId: ids.at(-1)! },
  });
}

describe("record integrity audit", () => {
  it("returns a stable zero-count report for an empty database", async () => {
    const report = await runRecordIntegrityAudit({ databaseUrl: auditUrl() });
    expect(report).toEqual({
      check: "record-integrity",
      version: 1,
      status: "ok",
      readOnlyVerified: true,
      safetySettingsVerified: true,
      totalViolations: 0,
      findings: {
        expense: {
          invalidDuplicateStatus: 0,
          flaggedWithoutPointer: 0,
          unflaggedWithPointer: 0,
          selfLinks: 0,
          crossProfileLinks: 0,
          missingTargets: 0,
          invalidEdgeIdentity: 0,
          sameReceiptLinks: 0,
          cycleAffectedRecords: 0,
          traversalLimitReached: 0,
          categoryOwnershipMismatches: 0,
          receiptOwnershipMismatches: 0,
          importBatchOwnershipMismatches: 0,
        },
        sales: {
          invalidDuplicateStatus: 0,
          flaggedWithoutPointer: 0,
          unflaggedWithPointer: 0,
          selfLinks: 0,
          crossProfileLinks: 0,
          missingTargets: 0,
          invalidEdgeIdentity: 0,
          cycleAffectedRecords: 0,
          traversalLimitReached: 0,
          followerTargetsNonCanonicalRoot: 0,
          importBatchOwnershipMismatches: 0,
        },
      },
    });
  });

  it("detects directly seeded invariant violations without changing any row", async () => {
    const ownerA = await makeOwnerWithProfile({}, ["A category"]);
    const ownerB = await makeOwnerWithProfile({}, ["B category"]);
    const date = utcDay();
    const [receiptA, receiptB, batchB] = await Promise.all([
      prisma.receiptScan.create({ data: { businessProfileId: ownerA.profile.id } }),
      prisma.receiptScan.create({ data: { businessProfileId: ownerB.profile.id } }),
      prisma.cSVImportBatch.create({
        data: { businessProfileId: ownerB.profile.id, title: "B", uploadDate: date },
      }),
    ]);
    const expenseData = {
      date,
      description: "Same expense",
      vendor: "Same vendor",
      amount: new Prisma.Decimal(100),
      source: "MANUAL_ENTRY" as const,
      reviewStatus: "Reviewed",
    };
    const root = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        receiptScanId: receiptA.id,
      },
    });
    const ownershipMismatch = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerB.categories["B category"]!,
        receiptScanId: receiptB.id,
        importBatchId: batchB.id,
        duplicateStatus: "Flagged",
      },
    });
    const crossProfile = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerB.profile.id,
        categoryId: ownerB.categories["B category"]!,
        duplicateStatus: "Flagged",
        duplicateOfRecordId: root.id,
      },
    });
    const invalidIdentity = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        description: "Different",
        vendor: "Different",
        duplicateStatus: "Flagged",
        duplicateOfRecordId: root.id,
      },
    });
    const sameReceipt = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        receiptScanId: receiptA.id,
        duplicateStatus: "Flagged",
        duplicateOfRecordId: root.id,
      },
    });
    const cycleA = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        duplicateStatus: "Flagged",
      },
    });
    const cycleB = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        duplicateStatus: "Flagged",
        duplicateOfRecordId: cycleA.id,
      },
    });
    await prisma.expenseRecord.update({
      where: { id: cycleA.id },
      data: { duplicateOfRecordId: cycleB.id },
    });
    await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        duplicateStatus: "Flagged",
      },
    });
    const expenseSelf = await prisma.expenseRecord.create({
      data: {
        ...expenseData,
        businessProfileId: ownerA.profile.id,
        categoryId: ownerA.categories["A category"]!,
        duplicateStatus: "Flagged",
      },
    });
    await prisma.expenseRecord.update({
      where: { id: expenseSelf.id },
      data: { duplicateOfRecordId: expenseSelf.id },
    });

    const salesData = {
      businessProfileId: ownerA.profile.id,
      date,
      description: "Same sale",
      amount: new Prisma.Decimal(200),
      source: "MANUAL_ENTRY" as const,
      reviewStatus: "Reviewed",
    };
    const salesRoot = await prisma.salesReferenceRecord.create({ data: salesData });
    const salesFollower = await prisma.salesReferenceRecord.create({
      data: { ...salesData, duplicateStatus: "Flagged", duplicateOfRecordId: salesRoot.id },
    });
    const salesFollowerOfFollower = await prisma.salesReferenceRecord.create({
      data: { ...salesData, duplicateStatus: "Flagged", duplicateOfRecordId: salesFollower.id },
    });
    const salesOwnershipMismatch = await prisma.salesReferenceRecord.create({
      data: { ...salesData, importBatchId: batchB.id },
    });
    const salesCycleA = await prisma.salesReferenceRecord.create({
      data: { ...salesData, duplicateStatus: "Flagged" },
    });
    const salesCycleB = await prisma.salesReferenceRecord.create({
      data: { ...salesData, duplicateStatus: "Flagged", duplicateOfRecordId: salesCycleA.id },
    });
    await prisma.salesReferenceRecord.update({
      where: { id: salesCycleA.id },
      data: { duplicateOfRecordId: salesCycleB.id },
    });
    await prisma.salesReferenceRecord.create({
      data: { ...salesData, duplicateStatus: "Flagged" },
    });
    const salesSelf = await prisma.salesReferenceRecord.create({
      data: { ...salesData, duplicateStatus: "Flagged" },
    });
    await prisma.salesReferenceRecord.update({
      where: { id: salesSelf.id },
      data: { duplicateOfRecordId: salesSelf.id },
    });
    await prisma.salesReferenceRecord.create({
      data: {
        ...salesData,
        businessProfileId: ownerB.profile.id,
        duplicateStatus: "Flagged",
        duplicateOfRecordId: salesRoot.id,
      },
    });
    await prisma.salesReferenceRecord.create({
      data: {
        ...salesData,
        description: "Different sale",
        duplicateStatus: "Flagged",
        duplicateOfRecordId: salesRoot.id,
      },
    });
    const salesInvalidStatus = await prisma.salesReferenceRecord.create({ data: salesData });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "ExpenseRecord" DISABLE TRIGGER ALL');
      await tx.$executeRawUnsafe('ALTER TABLE "SalesReferenceRecord" DISABLE TRIGGER ALL');
      try {
        await tx.$executeRaw`
          UPDATE "ExpenseRecord"
          SET "DuplicateOf_RecordID" = 2147483647
          WHERE "ExpenseRecord_ID" = ${ownershipMismatch.id}
        `;
        await tx.$executeRaw`
          UPDATE "ExpenseRecord"
          SET "ExpenseRecord_DuplicateStatus" = 'Broken'
          WHERE "ExpenseRecord_ID" = ${invalidIdentity.id}
        `;
        await tx.$executeRaw`
          UPDATE "SalesReferenceRecord"
          SET "DuplicateOf_RecordID" = 2147483647,
              "SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
          WHERE "SalesReferenceRecord_ID" = ${salesOwnershipMismatch.id}
        `;
        await tx.$executeRaw`
          UPDATE "SalesReferenceRecord"
          SET "SalesReferenceRecord_DuplicateStatus" = 'Broken'
          WHERE "SalesReferenceRecord_ID" = ${salesInvalidStatus.id}
        `;
      } finally {
        await tx.$executeRawUnsafe('ALTER TABLE "ExpenseRecord" ENABLE TRIGGER ALL');
        await tx.$executeRawUnsafe('ALTER TABLE "SalesReferenceRecord" ENABLE TRIGGER ALL');
      }
    });

    const before = await recordLinkSnapshot();
    const report = await runRecordIntegrityAudit({ databaseUrl: auditUrl() });
    const after = await recordLinkSnapshot();

    expect(report.status).toBe("findings");
    expect(report.readOnlyVerified).toBe(true);
    expect(report.totalViolations).toBeGreaterThan(0);
    expect(report.findings.expense).toMatchObject({
      invalidDuplicateStatus: 1,
      flaggedWithoutPointer: 1,
      unflaggedWithPointer: 1,
      selfLinks: 1,
      crossProfileLinks: 1,
      missingTargets: 1,
      invalidEdgeIdentity: 1,
      sameReceiptLinks: 1,
      cycleAffectedRecords: 3,
      traversalLimitReached: 0,
      categoryOwnershipMismatches: 1,
      receiptOwnershipMismatches: 1,
      importBatchOwnershipMismatches: 1,
    });
    expect(report.findings.sales).toMatchObject({
      invalidDuplicateStatus: 1,
      flaggedWithoutPointer: 1,
      unflaggedWithPointer: 1,
      selfLinks: 1,
      crossProfileLinks: 1,
      missingTargets: 1,
      invalidEdgeIdentity: 1,
      cycleAffectedRecords: 3,
      traversalLimitReached: 0,
      followerTargetsNonCanonicalRoot: 5,
      importBatchOwnershipMismatches: 1,
    });
    expect(after).toEqual(before);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main([], { RECORD_INTEGRITY_DATABASE_URL: auditUrl() })).resolves.toBe(1);
    const emitted = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(emitted).toMatchObject({ check: "record-integrity", status: "findings" });
    expect(JSON.stringify(emitted)).not.toContain("Same expense");
    expect(JSON.stringify(emitted)).not.toContain("Same sale");
    log.mockRestore();

    expect(crossProfile.id).toBeGreaterThan(0);
    expect(sameReceipt.id).toBeGreaterThan(0);
    expect(salesFollowerOfFollower.id).toBeGreaterThan(0);
  });

  it("reports a bounded-traversal violation instead of treating a long chain as clean", async () => {
    const owner = await makeOwnerWithProfile({}, ["Chain"]);
    let previousId: number | null = null;
    for (let index = 0; index < 66; index += 1) {
      const record: { id: number } = await prisma.expenseRecord.create({
        data: {
          businessProfileId: owner.profile.id,
          categoryId: owner.categories.Chain!,
          date: utcDay(),
          description: "Bounded chain",
          vendor: "Bounded vendor",
          amount: new Prisma.Decimal(100),
          source: "MANUAL_ENTRY",
          reviewStatus: "Reviewed",
          duplicateStatus: previousId === null ? "Not a Duplicate" : "Flagged",
          duplicateOfRecordId: previousId,
        },
      });
      previousId = record.id;
    }

    const report = await runRecordIntegrityAudit({ databaseUrl: auditUrl() });

    expect(report.status).toBe("findings");
    expect(report.findings.expense.cycleAffectedRecords).toBe(0);
    expect(report.findings.expense.traversalLimitReached).toBe(1);
    expect(report.totalViolations).toBe(1);
  });

  it("never reports cycles at or beyond the traversal boundary as clean", async () => {
    const owner = await makeOwnerWithProfile({}, ["Boundary"]);
    await seedExpenseCycle({
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Boundary!,
      length: 65,
      label: "Expense boundary cycle",
    });
    await seedExpenseCycle({
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Boundary!,
      length: 66,
      label: "Expense beyond-boundary cycle",
    });
    await seedSalesCycle({
      businessProfileId: owner.profile.id,
      length: 65,
      label: "Sales boundary cycle",
    });
    await seedSalesCycle({
      businessProfileId: owner.profile.id,
      length: 66,
      label: "Sales beyond-boundary cycle",
    });
    const before = await recordLinkSnapshot();

    const report = await runRecordIntegrityAudit({ databaseUrl: auditUrl() });

    expect(report.status).toBe("findings");
    expect(report.findings.expense.cycleAffectedRecords).toBe(65);
    expect(report.findings.expense.traversalLimitReached).toBe(131);
    expect(report.findings.sales.cycleAffectedRecords).toBe(65);
    expect(report.findings.sales.traversalLimitReached).toBe(131);
    expect(report.totalViolations).toBeGreaterThanOrEqual(523);
    expect(await recordLinkSnapshot()).toEqual(before);
  });
});
