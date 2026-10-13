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

vi.mock("../../src/services/storage.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/storage.service")>();
  return {
    ...actual,
    uploadCsvFileAtReference: vi.fn(async () => undefined),
    downloadCsvFile: vi.fn(async () => Buffer.from("")),
    deleteCsvFile: vi.fn(async () => true),
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

// The review-first import: upload, then review what FinSight detected and
// suggested, edit it, and confirm. No mapping step.

const AUTH = ["Authorization", "Bearer valid-token"] as const;
const BASE = "/api/v1/records/csv-imports";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let keySeq = 0;

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  ctx = await makeOwnerWithProfile({ type: "Sari-Sari Store" }, ["Office Supplies", "Utilities"]);
  authUserId.value = ctx.user.authId;
});

afterAll(disconnectDb);

async function stage(csv: string, fileName = "september.csv") {
  keySeq += 1;
  const response = await request(app)
    .post(`${BASE}/preview`)
    .set(...AUTH)
    .field("businessProfileId", String(ctx.profile.id))
    .field("idempotencyKey", `review-stage-key-${keySeq}`)
    .attach("file", Buffer.from(csv), fileName);
  expect(response.status).toBe(200);
  return response.body as {
    stagedUploadId: string;
    suggestedMapping: Record<string, string>;
    columnDetection: { unmapped: { header: string; field: string | null }[]; suggestedRecordType: string | null };
  };
}

function review(stagedUploadId: string, body: Record<string, unknown>) {
  return request(app).post(`${BASE}/preview`).set(...AUTH).send({ stagedUploadId, businessProfileId: ctx.profile.id, ...body });
}

function confirm(stagedUploadId: string, body: Record<string, unknown>) {
  keySeq += 1;
  return request(app)
    .post(`${BASE}/confirm`)
    .set(...AUTH)
    .send({
      stagedUploadId,
      businessProfileId: ctx.profile.id,
      title: "September expenses",
      idempotencyKey: `review-confirm-key-${keySeq}`,
      ...body,
    });
}

const EXPENSES_WITHOUT_CATEGORY = [
  "transaction_date,merchant,description,total,payment_method",
  "2026-09-01,National Book Store,Printer Ink,850,Cash",
  "2026-09-03,Puregold,Store Inventory,5000,GCash",
  "2026-09-05,Meralco,Electricity Bill,3200,Online",
  "2026-09-07,Petron,Delivery Fuel,1500,Cash",
].join("\n");

describe("detection on upload", () => {
  it("detects the columns, the record type and the columns it will not import", async () => {
    const staged = await stage(EXPENSES_WITHOUT_CATEGORY);
    expect(staged.suggestedMapping).toEqual({
      date: "transaction_date",
      vendor: "merchant",
      description: "description",
      amount: "total",
    });
    expect(staged.columnDetection).toEqual({
      unmapped: [{ header: "payment_method", field: "paymentMethod" }],
      suggestedRecordType: "expense",
    });
  });
});

describe("categories on review", () => {
  it("suggests business categories, reusing the owner's own before proposing new ones", async () => {
    const staged = await stage(EXPENSES_WITHOUT_CATEGORY);
    const checked = await review(staged.stagedUploadId, { recordType: "expense", columnMapping: staged.suggestedMapping });
    expect(checked.status).toBe(200);
    expect(checked.body.validation).toMatchObject({ validRows: 4, invalidRows: 0 });
    const byRow = Object.fromEntries(
      (checked.body.rowCategories as { row: number; name: string; isNew: boolean }[]).map((entry) => [entry.row, entry]),
    );
    expect(byRow[2]).toMatchObject({ name: "Office Supplies", isNew: false, source: "suggested" });
    expect(byRow[3]).toMatchObject({ name: "Inventory / Stock", isNew: true });
    expect(byRow[4]).toMatchObject({ name: "Utilities", isNew: false });
    expect(byRow[5]).toMatchObject({ name: "Fuel", isNew: true });
    expect(checked.body.categorySummary).toEqual({
      fromFile: 0,
      suggested: 4,
      uncategorised: 0,
      newCategories: [
        { name: "Inventory / Stock", rows: 1 },
        { name: "Fuel", rows: 1 },
      ],
    });
    // Reviewing writes nothing: no records, no categories.
    expect(await prisma.expenseRecord.count()).toBe(0);
    expect(await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id } })).toBe(2);
  });

  it("imports the suggestions, keeps every manual edit, and creates each new category once", async () => {
    const staged = await stage(EXPENSES_WITHOUT_CATEGORY);
    const corrections = {
      // The owner overrides a suggestion and fixes a vendor.
      "3": { category: "Stock purchases", vendor: "Puregold Price Club" },
      // And removes a row they do not want imported.
      "5": { exclude: true },
    };
    const confirmed = await confirm(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: staged.suggestedMapping,
      corrections,
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({ imported: 3, uncategorised: 0 });
    expect(confirmed.body.skipped).toEqual([{ row: 5, reason: "Removed in review" }]);

    const records = await prisma.expenseRecord.findMany({
      where: { businessProfileId: ctx.profile.id },
      include: { category: true },
      orderBy: { date: "asc" },
    });
    expect(records.map((record) => [record.description, record.category.name, record.vendor])).toEqual([
      ["Printer Ink", "Office Supplies", "National Book Store"],
      ["Store Inventory", "Stock purchases", "Puregold Price Club"],
      ["Electricity Bill", "Utilities", "Meralco"],
    ]);
    // Nothing was created for the removed row, and nothing was created twice.
    const names = (await prisma.expenseCategory.findMany({ where: { businessProfileId: ctx.profile.id } })).map((c) => c.name).sort();
    expect(names).toEqual(["Office Supplies", "Stock purchases", "Utilities"]);
  });

  it("matches a file's own category spellings to the owner's existing category", async () => {
    const staged = await stage([
      "Date,Item,Amount,Category",
      "2026-09-01,Bond paper,250,office supply",
      "2026-09-02,Stapler,180,Office Material",
      "2026-09-03,Folders,90,OFFICE SUPPLIES",
    ].join("\n"));
    const confirmed = await confirm(staged.stagedUploadId, { recordType: "expense", columnMapping: staged.suggestedMapping });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.imported).toBe(3);
    const categoriesUsed = await prisma.expenseRecord.findMany({
      where: { businessProfileId: ctx.profile.id },
      select: { category: { select: { name: true } } },
    });
    expect(new Set(categoriesUsed.map((row) => row.category.name))).toEqual(new Set(["Office Supplies"]));
    expect(await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id } })).toBe(2);
  });

  it("flags missing and invalid values instead of inventing them", async () => {
    const staged = await stage([
      "Date,Description,Amount",
      "2026-09-01,Printer Ink,",
      ",Bond paper,200",
      "2026-09-03,Folders,abc",
      "2026-09-04,Stapler,180",
    ].join("\n"));
    const checked = await review(staged.stagedUploadId, { recordType: "expense", columnMapping: staged.suggestedMapping });
    expect(checked.body.validation).toMatchObject({ validRows: 1, invalidRows: 3 });
    expect(checked.body.validation.skipped).toEqual([
      { row: 2, reason: 'Invalid amount: ""' },
      { row: 3, reason: 'Invalid date: ""' },
      { row: 4, reason: 'Invalid amount: "abc"' },
    ]);
  });
});

describe("available-funds classification", () => {
  const baselineAt = new Date("2026-09-15T03:00:00.000Z");
  const baselineDate = new Date("2026-09-15T00:00:00.000Z");

  async function setBaseline() {
    await prisma.businessProfile.update({
      where: { id: ctx.profile.id },
      data: { availableFundsBaselineAt: baselineAt, availableFundsBaselineDate: baselineDate },
    });
  }

  it("counts importable matching rows and applies the default with a per-row override", async () => {
    await setBaseline();
    const staged = await stage([
      "Date,Description,Amount,Category",
      "2026-09-15,Default row,100,Office Supplies",
      "2026-09-14,Override row,200,Office Supplies",
      "2026-09-15,Invalid row,not-money,Office Supplies",
      "2026-09-15,Removed row,400,Office Supplies",
    ].join("\n"));
    const corrections = {
      "3": { date: "2026-09-15", includedInAvailableFundsBaseline: true },
      "5": { exclude: true },
    };
    const checked = await review(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: staged.suggestedMapping,
      corrections,
    });

    expect(checked.status).toBe(200);
    expect(checked.body.availableFundsBaseline).toEqual({
      baselineAt: baselineAt.toISOString(),
      baselineDate: "2026-09-15",
      matchingRowCount: 2,
    });

    const confirmed = await confirm(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: staged.suggestedMapping,
      corrections,
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: baselineAt.toISOString(),
    });
    expect(confirmed.status).toBe(201);

    const records = await prisma.expenseRecord.findMany({
      where: { businessProfileId: ctx.profile.id },
      orderBy: { description: "asc" },
    });
    expect(records.map((record) => ({
      description: record.description,
      included: record.includedInAvailableFundsBaseline,
      baselineAt: record.availableFundsDeltaBaselineAt?.toISOString(),
    }))).toEqual([
      { description: "Default row", included: false, baselineAt: baselineAt.toISOString() },
      { description: "Override row", included: true, baselineAt: baselineAt.toISOString() },
    ]);
  });

  it("refuses missing and stale decisions before activating the staged batch", async () => {
    await setBaseline();
    const staged = await stage([
      "Date,Description,Amount,Category",
      "2026-09-15,Guarded row,100,Office Supplies",
    ].join("\n"));

    const missing = await confirm(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: staged.suggestedMapping,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED");

    await prisma.businessProfile.update({
      where: { id: ctx.profile.id },
      data: { availableFundsBaselineAt: new Date("2026-09-15T04:00:00.000Z") },
    });
    const stale = await confirm(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: staged.suggestedMapping,
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: baselineAt.toISOString(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("AVAILABLE_FUNDS_BASELINE_CHANGED");

    expect(await prisma.cSVImportBatch.findUniqueOrThrow({
      where: { stageId: staged.stagedUploadId },
    })).toMatchObject({
      processingStatus: "STAGED",
      confirmedAt: null,
      confirmInputHash: null,
    });
    expect(await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("rejects a top-level decision when no importable row is on the balance date", async () => {
    await setBaseline();
    const staged = await stage([
      "Date,Description,Amount,Category",
      "2026-09-14,Ordinary row,100,Office Supplies",
    ].join("\n"));
    const response = await confirm(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: staged.suggestedMapping,
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: baselineAt.toISOString(),
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE");
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({
      where: { stageId: staged.stagedUploadId },
    })).toMatchObject({ processingStatus: "STAGED", confirmedAt: null });
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it.each([
    ["excluded", "2026-09-15", "100", { exclude: true }],
    ["invalid", "2026-09-15", "not-money", {}],
    ["off-date", "2026-09-14", "100", {}],
  ])("rejects a row override on an %s row", async (_case, date, amount, correction) => {
    await setBaseline();
    const staged = await stage([
      "Date,Description,Amount,Category",
      `${date},Non-matching row,${amount},Office Supplies`,
      "2026-09-14,Mapping row,25,Office Supplies",
    ].join("\n"));
    const response = await confirm(staged.stagedUploadId, {
      recordType: "expense",
      columnMapping: {
        date: "Date",
        description: "Description",
        amount: "Amount",
        category: "Category",
      },
      corrections: {
        "2": { ...correction, includedInAvailableFundsBaseline: false },
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_NOT_APPLICABLE");
    expect(await prisma.cSVImportBatch.findUniqueOrThrow({
      where: { stageId: staged.stagedUploadId },
    })).toMatchObject({ processingStatus: "STAGED", confirmedAt: null });
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

describe("sales imports", () => {
  it("imports sales without inventing a category, and names the columns it cannot store", async () => {
    const staged = await stage(
      ["Date,Product,Quantity,Revenue,Customer,Category", "2026-09-01,Iced coffee,2,240,Ana,Drinks"].join("\n"),
      "sales-september.csv",
    );
    expect(staged.columnDetection.suggestedRecordType).toBe("sales");
    expect(staged.columnDetection.unmapped.map((entry) => entry.header)).toEqual(["Quantity", "Customer"]);

    const checked = await review(staged.stagedUploadId, { recordType: "sales", columnMapping: staged.suggestedMapping });
    expect(checked.body.rowCategories).toBeUndefined();
    expect(checked.body.categorySummary).toBeUndefined();

    const confirmed = await confirm(staged.stagedUploadId, { recordType: "sales", columnMapping: staged.suggestedMapping });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({ imported: 1, importedSales: 1 });
    const saleRecord = await prisma.salesReferenceRecord.findFirstOrThrow({ where: { businessProfileId: ctx.profile.id } });
    expect([saleRecord.description, Number(saleRecord.amount)]).toEqual(["Iced coffee", 240]);
    // No expense category was created for a sales file.
    expect(await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id } })).toBe(2);
  });
});
