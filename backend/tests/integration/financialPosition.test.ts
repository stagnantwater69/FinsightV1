import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import * as businessProfiles from "../../src/services/businessProfile.service";
import {
  getFinancialPosition,
  resolveMonthlyExpenseBasisForOwnedBusiness,
} from "../../src/services/financialPosition.service";
import { requireOwnedBusinessContext } from "../../src/services/ownedBusinessContext.service";
import * as insights from "../../src/services/insights.service";
import { getDashboardSummary } from "../../src/services/dashboard.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const NOW = new Date("2026-10-15T04:00:00.000Z");
const BASELINE_AT = new Date("2026-10-01T00:00:00.000Z");
const BASELINE_DATE = new Date("2026-10-01T00:00:00.000Z");
const TODAY = new Date("2026-10-15T00:00:00.000Z");
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/business-profiles";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await resetDb();
  ctx = await makeOwnerWithProfile({
    availableFunds: 10_000,
    expectedMonthlyExpenses: 5_000,
    timezone: "Asia/Manila",
  });
  authUserId.value = ctx.user.authId;
  await prisma.businessProfile.update({
    where: { id: ctx.profile.id },
    data: {
      availableFundsBaselineAt: BASELINE_AT,
      availableFundsBaselineDate: BASELINE_DATE,
    },
  });
});

afterEach(() => vi.useRealTimers());
afterAll(disconnectDb);

type ExpenseSeed = {
  amount: number;
  date?: Date;
  source?: "MANUAL_ENTRY" | "CSV_UPLOAD" | "RECEIPT_SCAN";
  reviewStatus?: string;
  duplicateStatus?: string;
  duplicateOfRecordId?: number | null;
  importBatchId?: number | null;
  receiptScanId?: number | null;
  createdAt?: Date;
  description?: string;
  includedInAvailableFundsBaseline?: boolean | null;
  availableFundsDeltaBaselineAt?: Date | null;
};

async function expense(seed: ExpenseSeed) {
  return prisma.expenseRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: seed.date ?? TODAY,
      description: seed.description ?? `Expense ${seed.amount}`,
      amount: seed.amount,
      source: seed.source ?? "MANUAL_ENTRY",
      reviewStatus: seed.reviewStatus ?? "Reviewed",
      duplicateStatus: seed.duplicateStatus ?? "Not a Duplicate",
      duplicateOfRecordId: seed.duplicateOfRecordId ?? null,
      importBatchId: seed.importBatchId ?? null,
      receiptScanId: seed.receiptScanId ?? null,
      includedInAvailableFundsBaseline: seed.includedInAvailableFundsBaseline ?? null,
      availableFundsDeltaBaselineAt: seed.availableFundsDeltaBaselineAt ?? null,
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
}

type SaleSeed = {
  amount: number;
  date?: Date;
  source?: "MANUAL_ENTRY" | "CSV_UPLOAD";
  reviewStatus?: string;
  duplicateStatus?: string;
  duplicateOfRecordId?: number | null;
  importBatchId?: number | null;
  createdAt?: Date;
  description?: string;
  includedInAvailableFundsBaseline?: boolean | null;
  availableFundsDeltaBaselineAt?: Date | null;
};

async function sale(seed: SaleSeed) {
  return prisma.salesReferenceRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      date: seed.date ?? TODAY,
      description: seed.description ?? `Sale ${seed.amount}`,
      amount: seed.amount,
      source: seed.source ?? "MANUAL_ENTRY",
      reviewStatus: seed.reviewStatus ?? "Reviewed",
      duplicateStatus: seed.duplicateStatus ?? "Not a Duplicate",
      duplicateOfRecordId: seed.duplicateOfRecordId ?? null,
      importBatchId: seed.importBatchId ?? null,
      includedInAvailableFundsBaseline: seed.includedInAvailableFundsBaseline ?? null,
      availableFundsDeltaBaselineAt: seed.availableFundsDeltaBaselineAt ?? null,
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
}

async function csvBatch(processingStatus: "PENDING" | "PROCESSING" | "COMPLETE") {
  return prisma.cSVImportBatch.create({
    data: {
      businessProfileId: ctx.profile.id,
      title: `${processingStatus} import`,
      uploadDate: TODAY,
      fileReference: `private/${processingStatus.toLowerCase()}.csv`,
      status: processingStatus === "COMPLETE" ? "Completed" : "Needs Review",
      processingStatus,
    },
  });
}

async function receiptScan(confirmationStatus: "Pending" | "Confirmed") {
  return prisma.receiptScan.create({
    data: {
      businessProfileId: ctx.profile.id,
      imageFile: `private/${confirmationStatus.toLowerCase()}.jpg`,
      confirmationStatus,
      processingStatus: "Complete",
    },
  });
}

describe("recorded available funds", () => {
  it("excludes included same-day records and applies not-included records exactly once", async () => {
    await sale({
      amount: 600,
      date: BASELINE_DATE,
      includedInAvailableFundsBaseline: true,
      availableFundsDeltaBaselineAt: BASELINE_AT,
    });
    await sale({
      amount: 200,
      date: BASELINE_DATE,
      includedInAvailableFundsBaseline: false,
      availableFundsDeltaBaselineAt: BASELINE_AT,
    });
    await expense({
      amount: 400,
      date: BASELINE_DATE,
      includedInAvailableFundsBaseline: true,
      availableFundsDeltaBaselineAt: BASELINE_AT,
    });
    await expense({
      amount: 50,
      date: BASELINE_DATE,
      includedInAvailableFundsBaseline: false,
      availableFundsDeltaBaselineAt: BASELINE_AT,
    });

    const position = await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW);

    expect(position.availableFunds).toMatchObject({
      calculatedAmount: 10_150,
      confirmedSalesAdded: 200,
      confirmedExpensesDeducted: 50,
      confirmedSalesRecordCount: 1,
      confirmedExpenseRecordCount: 1,
    });
  });

  it("reclassifies existing records on the new balance date into the reset baseline", async () => {
    const sameDayExpense = await expense({ amount: 400, date: TODAY });
    const sameDaySale = await sale({ amount: 600, date: TODAY });
    const earlierExpense = await expense({ amount: 25, date: new Date("2026-10-14T00:00:00.000Z") });

    const reset = await businessProfiles.updateBusinessProfile(ctx.user.id, ctx.profile.id, {
      availableFunds: 9_000,
    });
    const anchor = new Date(reset.availableFundsBaselineAt);

    await expect(prisma.expenseRecord.findUniqueOrThrow({ where: { id: sameDayExpense.id } }))
      .resolves.toMatchObject({
        includedInAvailableFundsBaseline: true,
        availableFundsDeltaBaselineAt: anchor,
      });
    await expect(prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: sameDaySale.id } }))
      .resolves.toMatchObject({
        includedInAvailableFundsBaseline: true,
        availableFundsDeltaBaselineAt: anchor,
      });
    await expect(prisma.expenseRecord.findUniqueOrThrow({ where: { id: earlierExpense.id } }))
      .resolves.toMatchObject({
        includedInAvailableFundsBaseline: null,
        availableFundsDeltaBaselineAt: null,
      });

    const position = await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW);
    expect(position.availableFunds).toMatchObject({
      baselineAmount: 9_000,
      calculatedAmount: 9_000,
      confirmedSalesRecordCount: 0,
      confirmedExpenseRecordCount: 0,
    });
  });

  it("includes the anchor date only when the record was created strictly after the anchor instant", async () => {
    await sale({
      amount: 100,
      date: BASELINE_DATE,
      createdAt: new Date("2026-10-01T00:00:00.001Z"),
    });
    await sale({
      amount: 200,
      date: BASELINE_DATE,
      createdAt: BASELINE_AT,
    });
    await sale({
      amount: 300,
      date: BASELINE_DATE,
      createdAt: new Date("2026-09-30T23:59:59.999Z"),
    });

    const position = await getFinancialPosition(
      ctx.user.id,
      ctx.profile.id,
      NOW,
    );

    expect(position.availableFunds).toMatchObject({
      calculatedAmount: 10_100,
      confirmedSalesAdded: 100,
      confirmedSalesRecordCount: 1,
    });
  });

  it("uses final workflows in the business-date range and the legacy cutoff only on the baseline date", async () => {
    const complete = await csvBatch("COMPLETE");
    const processing = await csvBatch("PROCESSING");
    const confirmed = await receiptScan("Confirmed");
    const pending = await receiptScan("Pending");

    await sale({ amount: 1_200 });
    await expense({ amount: 300 });
    await sale({ amount: 900, duplicateStatus: "Flagged" });
    await expense({ amount: 800, reviewStatus: "Needs Review" });
    await sale({ amount: 600, source: "CSV_UPLOAD", importBatchId: complete.id });
    await expense({ amount: 200, source: "CSV_UPLOAD", importBatchId: complete.id });
    await sale({ amount: 700, source: "CSV_UPLOAD", importBatchId: processing.id });
    await expense({ amount: 700, source: "CSV_UPLOAD", importBatchId: processing.id });
    await expense({ amount: 100, source: "RECEIPT_SCAN", receiptScanId: confirmed.id });
    await expense({ amount: 400, source: "RECEIPT_SCAN", receiptScanId: pending.id });
    await sale({ amount: 1_000, date: new Date("2026-10-16T00:00:00.000Z") });
    // Uploaded after the anchor, but dated before its business-local date.
    await sale({ amount: 2_000, date: new Date("2026-09-30T00:00:00.000Z") });
    // Pre-entered for a later business date, so it applies once that date is in range.
    await sale({
      amount: 3_000,
      date: TODAY,
      createdAt: new Date("2026-09-30T23:59:59.000Z"),
    });

    const position = await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW);

    expect(position.availableFunds).toMatchObject({
      baselineAmount: 10_000,
      baselineAt: BASELINE_AT.toISOString(),
      baselineDate: "2026-10-01",
      calculatedAmount: 14_200,
      confirmedSalesAdded: 4_800,
      confirmedExpensesDeducted: 600,
      confirmedSalesRecordCount: 3,
      confirmedExpenseRecordCount: 3,
      asOfDate: "2026-10-15",
    });
  });

  it("recalculates from current rows after an edit and a delete", async () => {
    const recordedSale = await sale({ amount: 500 });
    const recordedExpense = await expense({ amount: 100 });

    expect((await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW)).availableFunds.calculatedAmount).toBe(10_400);

    await prisma.expenseRecord.update({ where: { id: recordedExpense.id }, data: { amount: 250 } });
    expect((await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW)).availableFunds.calculatedAmount).toBe(10_250);

    await prisma.salesReferenceRecord.delete({ where: { id: recordedSale.id } });
    expect((await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW)).availableFunds.calculatedAmount).toBe(9_750);
  });

  it("recalculates when an owner changes a record review decision", async () => {
    const reviewedExpense = await expense({
      amount: 400,
      reviewStatus: "Needs Review",
    });

    expect(
      (await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW))
        .availableFunds.calculatedAmount,
    ).toBe(10_000);

    await prisma.expenseRecord.update({
      where: { id: reviewedExpense.id },
      data: { reviewStatus: "Reviewed" },
    });
    expect(
      (await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW))
        .availableFunds.calculatedAmount,
    ).toBe(9_600);

    await prisma.expenseRecord.update({
      where: { id: reviewedExpense.id },
      data: { reviewStatus: "Needs Review" },
    });
    expect(
      (await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW))
        .availableFunds.calculatedAmount,
    ).toBe(10_000);
  });

  it("resets the anchor when the owner changes starting funds", async () => {
    await sale({ amount: 500 });
    expect((await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW)).availableFunds.calculatedAmount).toBe(10_500);

    const beforeReset = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    await businessProfiles.updateBusinessProfile(ctx.user.id, ctx.profile.id, { availableFunds: 20_000 });
    const afterReset = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    const position = await getFinancialPosition(ctx.user.id, ctx.profile.id, NOW);

    expect(afterReset.availableFundsBaselineAt.getTime()).toBeGreaterThan(beforeReset.availableFundsBaselineAt.getTime());
    expect(position.availableFunds).toMatchObject({
      baselineAmount: 20_000,
      calculatedAmount: 20_000,
      confirmedSalesRecordCount: 0,
      confirmedExpenseRecordCount: 0,
    });
  });

  it("measures Spending Impact against calculated funds and returns their provenance", async () => {
    await sale({ amount: 1_000 });
    await expense({ amount: 200 });

    const impact = await insights.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 500, 30);

    expect(impact.funds).toEqual({ before: 10_800, after: 10_300 });
    expect(impact.availableFunds).toBe(10_800);
    expect(impact.availableFundsCalculation).toMatchObject({
      baselineAmount: 10_000,
      calculatedAmount: 10_800,
      confirmedSalesAdded: 1_000,
      confirmedExpensesDeducted: 200,
    });
  });

  it("keeps Spending Impact thresholds nonnegative when recorded funds are below zero", async () => {
    await expense({ amount: 10_500 });

    const impact = await insights.simulateSpendingImpact(
      ctx.user.id,
      ctx.profile.id,
      100,
      30,
    );

    expect(impact).toMatchObject({
      availableFunds: -500,
      resultingFunds: -600,
      funds: { before: -500, after: -600 },
      thresholdAmount: 0,
      percentOfFunds: Infinity,
      exceedsFunds: true,
      impactBand: "High Impact",
    });

    const response = await request(app)
      .get("/api/v1/insights/spending-impact")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, plannedAmount: 100 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      availableFunds: -500,
      resultingFunds: -600,
      funds: { before: -500, after: -600 },
      thresholdAmount: 0,
      percentOfFunds: 999999,
      exceedsFunds: true,
      impactBand: "High Impact",
    });
  });

  it("returns the same calculated funds and provenance in the dashboard overview", async () => {
    await sale({ amount: 1_000 });
    await expense({ amount: 200 });

    const dashboard = await getDashboardSummary(ctx.user.id, ctx.profile.id, 30);

    expect(dashboard.overview.availableFunds).toBe(10_800);
    expect(dashboard.overview.availableFundsCalculation).toMatchObject({
      baselineAmount: 10_000,
      calculatedAmount: 10_800,
      confirmedSalesAdded: 1_000,
      confirmedExpensesDeducted: 200,
      confirmedSalesRecordCount: 1,
      confirmedExpenseRecordCount: 1,
    });
  });
});

describe("financial-position HTTP ownership", () => {
  it("returns the owned position and hides another owner's profile behind the same 404", async () => {
    const other = await makeOwnerWithProfile({ availableFunds: 99_999 });

    const own = await request(app)
      .get(`${ENDPOINT}/${ctx.profile.id}/financial-position`)
      .set(...AUTH);
    const forbidden = await request(app)
      .get(`${ENDPOINT}/${other.profile.id}/financial-position`)
      .set(...AUTH);
    const missing = await request(app)
      .get(`${ENDPOINT}/999999/financial-position`)
      .set(...AUTH);

    expect(own.status).toBe(200);
    expect(own.body.availableFunds).toMatchObject({ baselineAmount: 10_000, calculatedAmount: 10_000 });
    expect(forbidden).toMatchObject({ status: 404, body: { error: "Business profile not found" } });
    expect(missing).toMatchObject({ status: 404, body: { error: "Business profile not found" } });
  });
});

describe("expense-record completeness", () => {
  it("uses the owner estimate until a past month is confirmed, then uses eligible prior-month records", async () => {
    const complete = await csvBatch("COMPLETE");
    const processing = await csvBatch("PROCESSING");
    await expense({ amount: 1_100, date: new Date("2026-09-03T00:00:00.000Z") });
    await expense({
      amount: 400,
      date: new Date("2026-09-10T00:00:00.000Z"),
      source: "CSV_UPLOAD",
      importBatchId: complete.id,
    });
    await expense({
      amount: 900,
      date: new Date("2026-09-11T00:00:00.000Z"),
      source: "CSV_UPLOAD",
      importBatchId: processing.id,
    });
    await expense({
      amount: 800,
      date: new Date("2026-09-12T00:00:00.000Z"),
      duplicateStatus: "Flagged",
    });

    const owned = await requireOwnedBusinessContext(ctx.user.id, ctx.profile.id);
    const fallback = await resolveMonthlyExpenseBasisForOwnedBusiness(
      owned,
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(fallback).toMatchObject({
      amount: 5_000,
      source: "owner_estimate",
      sourceMonth: null,
      ownerEstimate: 5_000,
      eligibleRecordCount: 0,
    });

    await prisma.cSVImportBatch.update({ where: { id: processing.id }, data: { processingStatus: "FAILED" } });
    const response = await request(app)
      .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
      .set(...AUTH)
      .send({ completeThroughMonth: "2026-09" });

    expect(response.status).toBe(200);
    expect(response.body.monthlyExpenseBasis).toMatchObject({
      amount: 1_500,
      source: "previous_complete_month",
      sourceMonth: "2026-09",
      ownerEstimate: 5_000,
      recordsCompleteThroughMonth: "2026-09",
      eligibleRecordCount: 2,
    });
    expect(response.body.monthlyExpenseBasis.recordsCompleteThroughConfirmedAt).toEqual(expect.any(String));
  });

  it("treats a confirmed month with no eligible expenses as a valid zero basis", async () => {
    const response = await request(app)
      .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
      .set(...AUTH)
      .send({ completeThroughMonth: "2026-09" });

    expect(response.status).toBe(200);
    expect(response.body.monthlyExpenseBasis).toMatchObject({
      amount: 0,
      source: "previous_complete_month",
      sourceMonth: "2026-09",
      eligibleRecordCount: 0,
    });

    const recovery = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(recovery.monthlyExpenseBasis).toMatchObject({
      amount: 0,
      source: "previous_complete_month",
      sourceMonth: "2026-09",
    });
    expect(recovery.needsSetup).toBe(false);
    expect(recovery.setupIssues).not.toContain("expected_expenses_missing");
  });

  it("clears the marker and restores the owner estimate", async () => {
    await businessProfiles.updateExpenseRecordsCompleteness(ctx.user.id, ctx.profile.id, "2026-09");

    const response = await request(app)
      .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
      .set(...AUTH)
      .send({ completeThroughMonth: null });

    expect(response.status).toBe(200);
    expect(response.body.monthlyExpenseBasis).toMatchObject({
      amount: 5_000,
      source: "owner_estimate",
      sourceMonth: null,
      recordsCompleteThroughMonth: null,
      recordsCompleteThroughConfirmedAt: null,
    });
  });

  it("rejects malformed, current, and future month values", async () => {
    const bodies = [
      { completeThroughMonth: "2026-9" },
      { completeThroughMonth: "2026-13" },
      { completeThroughMonth: "2026-09", extra: true },
    ];
    for (const body of bodies) {
      const response = await request(app)
        .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
        .set(...AUTH)
        .send(body);
      expect(response.status).toBe(400);
    }

    for (const completeThroughMonth of ["2026-10", "2026-11"]) {
      const response = await request(app)
        .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
        .set(...AUTH)
        .send({ completeThroughMonth });
      expect(response).toMatchObject({
        status: 400,
        body: { code: "EXPENSE_RECORDS_MONTH_NOT_COMPLETE" },
      });
    }
  });

  it("rejects confirmation during an active import, but still permits clearing", async () => {
    await csvBatch("PENDING");

    const conflict = await request(app)
      .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
      .set(...AUTH)
      .send({ completeThroughMonth: "2026-09" });
    const clear = await request(app)
      .put(`${ENDPOINT}/${ctx.profile.id}/expense-records-completeness`)
      .set(...AUTH)
      .send({ completeThroughMonth: null });

    expect(conflict).toMatchObject({
      status: 409,
      body: { code: "EXPENSE_RECORDS_IMPORT_IN_PROGRESS" },
    });
    expect(clear.status).toBe(200);
  });

  it("does not allow one owner to confirm another owner's expense history", async () => {
    const other = await makeOwnerWithProfile();
    const response = await request(app)
      .put(`${ENDPOINT}/${other.profile.id}/expense-records-completeness`)
      .set(...AUTH)
      .send({ completeThroughMonth: "2026-09" });

    expect(response).toMatchObject({ status: 404, body: { error: "Business profile not found" } });
  });
});

describe("Recovery Target basis provenance", () => {
  it("uses the month before a historical target month and returns that provenance", async () => {
    await expense({ amount: 7_000, date: new Date("2026-07-12T00:00:00.000Z") });
    await expense({ amount: 9_000, date: new Date("2026-09-12T00:00:00.000Z") });
    await businessProfiles.updateExpenseRecordsCompleteness(ctx.user.id, ctx.profile.id, "2026-09");

    const recovery = await insights.getRecoveryInsight(
      ctx.user.id,
      ctx.profile.id,
      31,
      { kind: "month", month: "2026-08" },
    );

    expect(recovery.contractVersion).toBe(2);
    expect(recovery.expectedMonthlyExpenses).toBe(7_000);
    expect(recovery.monthlyExpenseBasis).toMatchObject({
      amount: 7_000,
      source: "previous_complete_month",
      sourceMonth: "2026-07",
      ownerEstimate: 5_000,
      eligibleRecordCount: 1,
    });
    expect(recovery.reportingPeriod).toMatchObject({
      kind: "month",
      month: "2026-08",
      target: 7_000,
      monthlyExpenseBases: [
        {
          targetMonth: "2026-08",
          basis: {
            amount: 7_000,
            source: "previous_complete_month",
            sourceMonth: "2026-07",
          },
        },
      ],
    });
  });
});
