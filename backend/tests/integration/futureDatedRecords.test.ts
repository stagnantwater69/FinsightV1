import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// The CSV file itself is not uploaded anywhere in this suite.
vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadCsvFile: vi.fn(async () => "test/mock-csv-path.csv"),
    uploadCsvFileAtReference: vi.fn(async () => undefined),
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resolveBusinessToday, utcAddDays, utcDateKey } from "../../src/lib/dates";
import { FUTURE_DATE_CODE, FUTURE_DATE_MESSAGE } from "../../src/lib/transactionDate";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import { confirmImport, previewCsvForProfile } from "../../src/services/csvImport.service";
import { confirmReceipt } from "../../src/services/receiptScan/reconciliation";
import { listFutureDatedRecords } from "../../src/services/futureDatedRecords.service";
import { listRecordMonths } from "../../src/services/recordMonths.service";
import { getDashboardSummary } from "../../src/services/dashboard.service";
import { getExpenseBehavior, simulateSpendingImpact } from "../../src/services/insights.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

// The fixture profile keeps its calendar in Asia/Manila. Every date here is
// that business's day, so the suite holds between Manila midnight and 08:00,
// when the server's UTC day is still yesterday.
const TZ = "Asia/Manila";
const AUTH = ["Authorization", "Bearer valid-token"] as const;

function businessDay(offset: number): string {
  return utcDateKey(utcAddDays(resolveBusinessToday(TZ), offset));
}

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

/** Written straight to the table: how a record from before the rule looks. */
async function legacyExpense(date: string, amount: number, description = "Stock") {
  return prisma.expenseRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: new Date(`${date}T00:00:00.000Z`),
      description,
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

async function legacySale(date: string, amount: number) {
  return prisma.salesReferenceRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      date: new Date(`${date}T00:00:00.000Z`),
      description: "Daily sales",
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

function expenseInput(date: string) {
  return { businessProfileId: ctx.profile.id, categoryId: ctx.categories.Inventory!, date, description: "Rice", amount: 100 };
}

describe("new records cannot be dated after the business's today", () => {
  it("accepts yesterday and today for an expense and rejects tomorrow", async () => {
    await expect(expenses.createExpenseRecord(ctx.user.id, expenseInput(businessDay(-1)))).resolves.toBeDefined();
    await expect(expenses.createExpenseRecord(ctx.user.id, { ...expenseInput(businessDay(0)), description: "Sugar" })).resolves.toBeDefined();
    await expect(expenses.createExpenseRecord(ctx.user.id, { ...expenseInput(businessDay(1)), description: "Oil" }))
      .rejects.toMatchObject({ status: 400, code: FUTURE_DATE_CODE, message: FUTURE_DATE_MESSAGE });
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("accepts yesterday and today for a sale and rejects tomorrow", async () => {
    const sale = (date: string, amount: number) => ({ businessProfileId: ctx.profile.id, date, description: "Daily sales", amount });
    await sales.createSalesRecord(ctx.user.id, sale(businessDay(-1), 100));
    await sales.createSalesRecord(ctx.user.id, sale(businessDay(0), 200));
    await expect(sales.createSalesRecord(ctx.user.id, sale(businessDay(1), 300)))
      .rejects.toMatchObject({ status: 400, code: FUTURE_DATE_CODE });
    expect(await prisma.salesReferenceRecord.count()).toBe(2);
  });

  it("rejects moving a record to a future date, and leaves the record as it was", async () => {
    const record = await expenses.createExpenseRecord(ctx.user.id, expenseInput(businessDay(0)));
    await expect(expenses.updateExpenseRecord(ctx.user.id, record.id, { date: businessDay(1) }))
      .rejects.toMatchObject({ code: FUTURE_DATE_CODE });
    const sale = await sales.createSalesRecord(ctx.user.id, { businessProfileId: ctx.profile.id, date: businessDay(0), description: "Daily sales", amount: 50 });
    await expect(sales.updateSalesRecord(ctx.user.id, sale.id, { date: businessDay(1) }))
      .rejects.toMatchObject({ code: FUTURE_DATE_CODE });
    expect(utcDateKey((await prisma.expenseRecord.findUniqueOrThrow({ where: { id: record.id } })).date)).toBe(businessDay(0));
  });

  it("still allows a review decision on an existing future-dated record without touching its date", async () => {
    const legacy = await legacyExpense(businessDay(3), 100);
    await expect(expenses.updateExpenseRecord(ctx.user.id, legacy.id, { reviewStatus: "Reviewed" })).resolves.toBeDefined();
  });

  it("rejects a direct API request with a future date in the API's error format", async () => {
    const expense = await request(app).post("/api/v1/records/expenses").set(...AUTH).send(expenseInput(businessDay(1)));
    expect(expense.status).toBe(400);
    expect(expense.body).toEqual({ error: FUTURE_DATE_MESSAGE, code: FUTURE_DATE_CODE, field: "date", latestDate: businessDay(0) });

    const sale = await request(app).post("/api/v1/records/sales").set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, date: businessDay(2), description: "Daily sales", amount: 10 });
    expect(sale.status).toBe(400);
    expect(sale.body.code).toBe(FUTURE_DATE_CODE);

    const ok = await request(app).post("/api/v1/records/expenses").set(...AUTH).send(expenseInput(businessDay(0)));
    expect(ok.status).toBe(201);
    const moved = await request(app).patch(`/api/v1/records/expenses/${ok.body.id}`).set(...AUTH).send({ date: businessDay(1) });
    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe(FUTURE_DATE_CODE);
    expect(await prisma.expenseRecord.count()).toBe(1);
  });

  it("skips future-dated CSV rows in the preview and never imports them", async () => {
    const csv = Buffer.from(
      ["Date,Description,Amount,Category", `${businessDay(-1)},Rice,100,Inventory`, `${businessDay(0)},Sugar,50,Inventory`, `${businessDay(1)},Oil,75,Inventory`].join("\n"),
    );
    const options = {
      recordType: "expense" as const,
      columnMapping: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
    };
    const preview = await previewCsvForProfile(ctx.user.id, ctx.profile.id, csv, options);
    expect(preview.validation).toMatchObject({ validRows: 2, invalidRows: 1 });
    expect(preview.validation?.skipped).toEqual([{ row: 4, reason: `Future date: "${businessDay(1)}"` }]);

    const result = await confirmImport(ctx.user.id, { businessProfileId: ctx.profile.id, title: "Sept", buffer: csv, originalname: "sept.csv", ...options });
    expect(result.imported).toBe(2);
    const saved = await prisma.expenseRecord.findMany({ select: { date: true } });
    expect(saved.map((r) => utcDateKey(r.date)).sort()).toEqual([businessDay(-1), businessDay(0)]);
  });

  it("refuses a receipt confirmation dated in the future and leaves the scan for correction", async () => {
    const scan = await prisma.receiptScan.create({
      data: { businessProfileId: ctx.profile.id, imageFile: "private/receipt.jpg", rawText: "TOTAL 100.00", processingStatus: "Complete" },
    });
    const confirm = (date: string) => confirmReceipt(ctx.user.id, scan.id, {
      date, description: "Rice", amount: 100, splits: [{ categoryId: ctx.categories.Inventory!, amount: 100 }],
    });
    await expect(confirm(businessDay(1))).rejects.toMatchObject({ code: FUTURE_DATE_CODE });
    expect(await prisma.expenseRecord.count()).toBe(0);
    expect((await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).confirmationStatus).toBe("Pending");

    await confirm(businessDay(0));
    expect(await prisma.expenseRecord.count()).toBe(1);
  });
});

describe("existing future-dated records", () => {
  it("lists them, for this business only, oldest first", async () => {
    await legacyExpense(businessDay(-2), 40, "Past");
    const futureExpense = await legacyExpense(businessDay(5), 5000, "Tablet");
    const futureSale = await legacySale(businessDay(2), 7000);
    const other = await makeOwnerWithProfile();
    await prisma.salesReferenceRecord.create({
      data: { businessProfileId: other.profile.id, date: new Date(`${businessDay(4)}T00:00:00.000Z`), description: "Theirs", amount: 1, source: "MANUAL_ENTRY" },
    });

    const result = await listFutureDatedRecords(ctx.user.id, ctx.profile.id);
    expect(result).toMatchObject({ today: businessDay(0), total: 2, truncated: false });
    expect(result.records.map((r) => [r.type, r.id, r.date])).toEqual([
      ["sales", futureSale.id, businessDay(2)],
      ["expense", futureExpense.id, businessDay(5)],
    ]);
    expect(result.records[1]).toMatchObject({ description: "Tablet", amount: 5000, categoryName: "Inventory" });

    await expect(listFutureDatedRecords(other.user.id, ctx.profile.id)).rejects.toMatchObject({ status: 404 });
  });

  it("clears once every record is corrected or deleted", async () => {
    const expense = await legacyExpense(businessDay(5), 5000);
    const sale = await legacySale(businessDay(2), 7000);
    expect((await listFutureDatedRecords(ctx.user.id, ctx.profile.id)).total).toBe(2);

    await expenses.updateExpenseRecord(ctx.user.id, expense.id, { date: businessDay(0) });
    expect((await listFutureDatedRecords(ctx.user.id, ctx.profile.id)).total).toBe(1);

    await sales.deleteSalesRecord(ctx.user.id, sale.id);
    const response = await request(app).get("/api/v1/records/future-dated").set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ today: businessDay(0), total: 0, records: [], truncated: false });
  });
});

describe("financial insights leave future-dated records out", () => {
  beforeEach(async () => {
    await legacyExpense(businessDay(-1), 100, "Rice");
    await legacySale(businessDay(-1), 300);
    await legacyExpense(businessDay(1), 5000, "Tablet");
    await legacySale(businessDay(1), 7000);
    await legacyExpense(businessDay(40), 9000, "Freezer");
  });

  it("dashboard totals, all time and the month that holds tomorrow", async () => {
    const all = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "all" });
    expect(all.overview.totalExpenses).toBe(100);
    expect(all.overview.totalSalesReference).toBe(300);
    expect(all.expenseCategoryBreakdown.reduce((sum, c) => sum + c.total, 0)).toBe(100);
    expect(utcDateKey(all.lifetime.latestRecordDate!)).toBe(businessDay(-1));
    expect(all.lifetime.recordCount).toBe(2);

    const month = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "month", month: businessDay(1).slice(0, 7) });
    expect(month.overview.totalExpenses).toBe(businessDay(-1).slice(0, 7) === businessDay(1).slice(0, 7) ? 100 : 0);
    expect(month.overview.totalSalesReference).toBe(businessDay(-1).slice(0, 7) === businessDay(1).slice(0, 7) ? 300 : 0);

    const week = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "week" });
    expect(week.overview.totalExpenses).toBeLessThanOrEqual(100);
  });

  it("expense insight, spending impact and the month list", async () => {
    const behavior = await getExpenseBehavior(ctx.user.id, ctx.profile.id, { kind: "all" });
    expect(behavior.totals.current).toBe(100);
    expect(behavior.dailyTotals.reduce((sum, d) => sum + d.total, 0)).toBe(100);
    expect(utcDateKey(behavior.latestExpenseDate!)).toBe(businessDay(-1));

    const impact = await simulateSpendingImpact(ctx.user.id, ctx.profile.id, 50, { kind: "all" });
    expect(impact.periodExpenses.before).toBe(100);

    const months = await listRecordMonths(ctx.user.id, ctx.profile.id);
    expect(months).not.toContain(businessDay(40).slice(0, 7));
    expect(months).toContain(businessDay(-1).slice(0, 7));
  });
});
