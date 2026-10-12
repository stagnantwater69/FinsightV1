import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { businessTodayKey } from "../../src/lib/transactionDate";
import { updateBusinessProfile } from "../../src/services/businessProfile.service";
import {
  createExpenseRecord,
  updateExpenseRecord,
} from "../../src/services/expenseRecord.service";
import {
  createSalesRecord,
  updateSalesRecord,
} from "../../src/services/salesRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const BASELINE_AT = new Date("2026-09-15T04:00:00.000Z");
const BASELINE_DATE = "2026-09-15";
const OTHER_DATE = "2026-09-14";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({
    availableFunds: 10_000,
    timezone: "Asia/Manila",
  }, ["Inventory"]);
  await prisma.businessProfile.update({
    where: { id: ctx.profile.id },
    data: {
      availableFundsBaselineAt: BASELINE_AT,
      availableFundsBaselineDate: new Date(`${BASELINE_DATE}T00:00:00.000Z`),
    },
  });
});

afterAll(disconnectDb);

const expenseInput = (date: string) => ({
  businessProfileId: ctx.profile.id,
  categoryId: ctx.categories.Inventory!,
  date,
  description: `Expense ${date}`,
  amount: 100,
});

const saleInput = (date: string) => ({
  businessProfileId: ctx.profile.id,
  date,
  description: `Sale ${date}`,
  amount: 200,
});

describe("manual available-funds baseline classification", () => {
  it("requires the pair only on the active baseline date and returns it in both DTOs", async () => {
    await expect(createExpenseRecord(ctx.user.id, expenseInput(BASELINE_DATE))).rejects.toMatchObject({
      status: 400,
      code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED",
    });
    await expect(createSalesRecord(ctx.user.id, saleInput(BASELINE_DATE))).rejects.toMatchObject({
      status: 400,
      code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED",
    });

    await expect(createExpenseRecord(ctx.user.id, {
      ...expenseInput(OTHER_DATE),
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: BASELINE_AT.toISOString(),
    })).rejects.toMatchObject({
      status: 400,
      code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE",
    });
    await expect(createSalesRecord(ctx.user.id, {
      ...saleInput(OTHER_DATE),
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: BASELINE_AT.toISOString(),
    })).rejects.toMatchObject({
      status: 400,
      code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE",
    });

    const ordinaryExpense = await createExpenseRecord(ctx.user.id, expenseInput(OTHER_DATE));
    const ordinarySale = await createSalesRecord(ctx.user.id, saleInput(OTHER_DATE));
    expect(ordinaryExpense).toMatchObject({
      includedInAvailableFundsBaseline: null,
      availableFundsDeltaBaselineAt: null,
    });
    expect(ordinarySale).toMatchObject({
      includedInAvailableFundsBaseline: null,
      availableFundsDeltaBaselineAt: null,
    });

    const includedExpense = await createExpenseRecord(ctx.user.id, {
      ...expenseInput(BASELINE_DATE),
      includedInAvailableFundsBaseline: true,
      availableFundsBaselineAt: BASELINE_AT.toISOString(),
    });
    const appliedSale = await createSalesRecord(ctx.user.id, {
      ...saleInput(BASELINE_DATE),
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: BASELINE_AT.toISOString(),
    });
    expect(includedExpense).toMatchObject({
      includedInAvailableFundsBaseline: true,
      availableFundsDeltaBaselineAt: BASELINE_AT,
    });
    expect(appliedSale).toMatchObject({
      includedInAvailableFundsBaseline: false,
      availableFundsDeltaBaselineAt: BASELINE_AT,
    });
  });

  it("requires edit classification when entering the date, preserves it, and clears it when leaving", async () => {
    const expense = await createExpenseRecord(ctx.user.id, expenseInput(OTHER_DATE));
    const sale = await createSalesRecord(ctx.user.id, saleInput(OTHER_DATE));

    await expect(updateExpenseRecord(ctx.user.id, expense.id, { date: BASELINE_DATE }))
      .rejects.toMatchObject({ code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED" });
    await expect(updateSalesRecord(ctx.user.id, sale.id, { date: BASELINE_DATE }))
      .rejects.toMatchObject({ code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED" });
    await expect(prisma.expenseRecord.findUniqueOrThrow({ where: { id: expense.id } }))
      .resolves.toMatchObject({ date: new Date(`${OTHER_DATE}T00:00:00.000Z`) });
    await expect(prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: sale.id } }))
      .resolves.toMatchObject({ date: new Date(`${OTHER_DATE}T00:00:00.000Z`) });

    const classifiedExpense = await updateExpenseRecord(ctx.user.id, expense.id, {
      date: BASELINE_DATE,
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: BASELINE_AT.toISOString(),
    });
    const classifiedSale = await updateSalesRecord(ctx.user.id, sale.id, {
      date: BASELINE_DATE,
      includedInAvailableFundsBaseline: true,
      availableFundsBaselineAt: BASELINE_AT.toISOString(),
    });
    expect(classifiedExpense.includedInAvailableFundsBaseline).toBe(false);
    expect(classifiedSale.includedInAvailableFundsBaseline).toBe(true);

    await expect(updateExpenseRecord(ctx.user.id, expense.id, { amount: 125 }))
      .resolves.toMatchObject({ includedInAvailableFundsBaseline: false });
    await expect(updateSalesRecord(ctx.user.id, sale.id, { amount: 225 }))
      .resolves.toMatchObject({ includedInAvailableFundsBaseline: true });

    await expect(updateExpenseRecord(ctx.user.id, expense.id, { date: OTHER_DATE }))
      .resolves.toMatchObject({
        includedInAvailableFundsBaseline: null,
        availableFundsDeltaBaselineAt: null,
      });
    await expect(updateSalesRecord(ctx.user.id, sale.id, { date: OTHER_DATE }))
      .resolves.toMatchObject({
        includedInAvailableFundsBaseline: null,
        availableFundsDeltaBaselineAt: null,
      });
  });

  it("serializes reset against expense and sale writes without leaving an old classification", async () => {
    const staleToken = BASELINE_AT.toISOString();
    const resetDate = businessTodayKey("Asia/Manila");
    const outcomes = await Promise.allSettled([
      updateBusinessProfile(ctx.user.id, ctx.profile.id, { availableFunds: 9_000 }),
      createExpenseRecord(ctx.user.id, {
        ...expenseInput(resetDate),
        description: "Stale expense",
        includedInAvailableFundsBaseline: false,
        availableFundsBaselineAt: staleToken,
      }),
      createSalesRecord(ctx.user.id, {
        ...saleInput(resetDate),
        description: "Stale sale",
        includedInAvailableFundsBaseline: false,
        availableFundsBaselineAt: staleToken,
      }),
    ]);

    const reset = outcomes[0];
    if (reset?.status !== "fulfilled") throw reset?.reason;
    const currentToken = new Date(reset.value.availableFundsBaselineAt);
    for (const [index, outcome] of outcomes.slice(1).entries()) {
      const description = index === 0 ? "Stale expense" : "Stale sale";
      const stored = index === 0
        ? await prisma.expenseRecord.findFirst({ where: { description } })
        : await prisma.salesReferenceRecord.findFirst({ where: { description } });
      if (outcome.status === "fulfilled") {
        expect(stored).toMatchObject({
          includedInAvailableFundsBaseline: true,
          availableFundsDeltaBaselineAt: currentToken,
        });
        continue;
      }
      // Rejection depends on which write takes the profile lock first. After
      // the reset, the stale token is a 409. Before it, the token still
      // matches but today is not the old balance date, so it is a 400.
      if (outcome.status === "rejected") {
        expect([
          { status: 409, code: "AVAILABLE_FUNDS_BASELINE_CHANGED" },
          { status: 400, code: "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE" },
        ]).toContainEqual({ status: outcome.reason.status, code: outcome.reason.code });
      }
      expect(stored).toBeNull();
    }
  });

  it("advances the baseline token when a reset happens in the same millisecond", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(BASELINE_AT.getTime());
    try {
      const reset = await updateBusinessProfile(ctx.user.id, ctx.profile.id, { availableFunds: 9_000 });
      expect(new Date(reset.availableFundsBaselineAt).getTime()).toBe(BASELINE_AT.getTime() + 1);
      await expect(prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } }))
        .resolves.toMatchObject({
          availableFundsBaselineAt: new Date(BASELINE_AT.getTime() + 1),
        });
    } finally {
      now.mockRestore();
    }
  });

  it("enforces the classification pair at the database boundary", async () => {
    await expect(prisma.expenseRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: new Date(`${BASELINE_DATE}T00:00:00.000Z`),
        description: "Half-classified expense",
        amount: 10,
        includedInAvailableFundsBaseline: false,
      },
    })).rejects.toBeDefined();
    await expect(prisma.salesReferenceRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        date: new Date(`${BASELINE_DATE}T00:00:00.000Z`),
        description: "Half-classified sale",
        amount: 10,
        availableFundsDeltaBaselineAt: BASELINE_AT,
      },
    })).rejects.toBeDefined();
  });
});
