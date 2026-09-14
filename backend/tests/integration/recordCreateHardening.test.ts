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

const { notificationEffect } = vi.hoisted(() => ({ notificationEffect: { fail: false, calls: 0 } }));
vi.mock("../../src/services/notification.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/notification.service")>();
  return {
    ...actual,
    createNotification: async (...args: Parameters<typeof actual.createNotification>) => {
      notificationEffect.calls += 1;
      if (notificationEffect.fail) throw new Error("simulated notification write failure");
      return actual.createNotification(...args);
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { logger } from "../../src/config/logger";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const EXPENSES = "/api/v1/records/expenses";
const SALES = "/api/v1/records/sales";

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
  notificationEffect.fail = false;
  notificationEffect.calls = 0;
  vi.restoreAllMocks();
});
afterAll(disconnectDb);

/**
 * API-004 — the amount that was accepted and then stored as nothing.
 *
 * `amount: 0.001` used to answer 201 with a record whose stored amount was
 * 0.00: past `.positive()`, rounded away by the Decimal(12,2) column, and from
 * then on a real row in the owner's books worth zero pesos. These assert on
 * the STORED value, not just on the status, because the status was never the
 * part that was wrong.
 */
describe("money amount validation", () => {
  it("rejects a sub-centavo expense with a 400 instead of storing zero", async () => {
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Sub-centavo",
        amount: 0.001,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("still accepts a normal two-decimal amount and stores it exactly", async () => {
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Rice sack",
        amount: 1234.56,
      });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1234.56);
    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(Number(stored.amount)).toBe(1234.56);
  });

  it("rejects a sub-centavo sales record too", async () => {
    const res = await request(app)
      .post(SALES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        date: utcDayString(),
        description: "Sub-centavo sale",
        amount: 0.004,
      });

    expect(res.status).toBe(400);
    expect(await prisma.salesReferenceRecord.count()).toBe(0);
  });

  it("rejects a sub-centavo amount on update as well as on create", async () => {
    const created = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Edited later",
        amount: 500,
      });
    expect(created.status).toBe(201);

    const res = await request(app)
      .patch(`${EXPENSES}/${created.body.id}`)
      .set(...AUTH)
      .send({ amount: 0.009 });

    expect(res.status).toBe(400);
    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(Number(stored.amount)).toBe(500);
  });

  it("rejects an amount wider than the column rather than answering 500", async () => {
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Overflow",
        amount: 99_999_999_999.99,
      });

    expect(res.status).toBe(400);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

/**
 * API-008 / API-014 — the double-tap the duplicate detector could not see.
 *
 * Two identical creates issued together used to both read "no duplicate"
 * before either had written, so BOTH landed as "Not a Duplicate" and the owner
 * was never told they had recorded the same purchase twice. Neither record is
 * rejected — a genuine second identical purchase is legitimate — but exactly
 * one of them must come out flagged and pointing at the other.
 */
describe("concurrent create is not a read-then-write race", () => {
  const body = () => ({
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories.Inventory,
    date: utcDayString(),
    description: "Double-tapped delivery",
    amount: 350.5,
  });

  /*
   * SIX AT ONCE, not two. Two supertest requests fired together rarely
   * interleave inside the millisecond the duplicate check takes, so a
   * two-request version of this passed even with the serialisation removed —
   * it was testing nothing. Six reliably overlap, and the assertion is the one
   * that matters either way: however many identical records arrive together,
   * exactly ONE of them is the original and every other points at it.
   */
  it("flags every simultaneous identical expense but the first", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post(EXPENSES).set(...AUTH).send(body())),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));

    const records = await prisma.expenseRecord.findMany({ orderBy: { id: "asc" } });
    expect(records).toHaveLength(6);

    const originals = records.filter((r) => r.duplicateStatus === "Not a Duplicate");
    expect(originals).toHaveLength(1);
    for (const duplicate of records.filter((r) => r.duplicateStatus === "Flagged")) {
      expect(duplicate.duplicateOfRecordId).toBe(originals[0]!.id);
    }
  });

  it("flags every simultaneous identical sales record but the first", async () => {
    const salesBody = () => ({
      businessProfileId: ctx.profile.id,
      date: utcDayString(),
      description: "Double-tapped sale",
      amount: 120.25,
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post(SALES).set(...AUTH).send(salesBody())),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));

    const records = await prisma.salesReferenceRecord.findMany({ orderBy: { id: "asc" } });
    expect(records).toHaveLength(6);
    expect(records.filter((r) => r.duplicateStatus === "Not a Duplicate")).toHaveLength(1);
  });

  it("leaves nothing behind when the create fails inside its transaction", async () => {
    // A category from another business: the ownership check inside the
    // transaction rejects it, and no partial row may survive the rollback.
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Utilities"]);
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: other.categories.Utilities,
        date: utcDayString(),
        description: "Someone else's category",
        amount: 10,
      });

    expect(res.status).toBe(400);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

/**
 * The update's post-commit tail. An edit that crosses the large-expense
 * threshold commits the new amount and then raises a notification and requeues
 * the analysis job outside the transaction. The notification used to be
 * awaited bare: if it threw, the enqueue after it never ran and the owner got
 * a 500 for an edit that was already in the books, the same gap the create
 * path closed in round 4.
 */
describe("a post-commit effect of an update that fails", () => {
  const VENDOR = "Sari-sari Wholesale Depot";
  // Above the default large-expense threshold (125000 * 25% = 31250).
  const LARGE_AMOUNT = 40000;

  it("notification write: answers 200 with the edit committed, the analysis still queued, and an ids-only log entry", async () => {
    const created = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Stock purchase",
        vendor: VENDOR,
        amount: 500,
      });
    expect(created.status).toBe(201);
    expect(created.body.largeExpenseFlag).toBe(false);
    // Drain the create's own job so the edit's requeue is observable.
    await prisma.analysisJob.deleteMany({ where: { expenseRecordId: created.body.id } });

    const logged = vi.spyOn(logger, "error");
    notificationEffect.calls = 0;
    notificationEffect.fail = true;

    const res = await request(app)
      .patch(`${EXPENSES}/${created.body.id}`)
      .set(...AUTH)
      .send({ amount: LARGE_AMOUNT });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, largeExpenseFlag: true, reviewStatus: "Needs Review" });
    expect(notificationEffect.calls).toBe(1);

    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(Number(stored.amount)).toBe(LARGE_AMOUNT);
    expect(stored.largeExpenseFlag).toBe(true);
    // The notification itself is lost, and the loss is the only thing that is.
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.analysisJob.findUnique({ where: { idempotencyKey: `transaction:${created.body.id}` } }))
      .toMatchObject({ status: "PENDING" });

    const entry = logged.mock.calls.find(([fields]) =>
      typeof fields === "object" && fields !== null
      && (fields as { code?: unknown }).code === "EXPENSE_RECORD_SIDE_EFFECT_FAILED");
    expect(entry, "a failed post-commit effect must be logged").toBeDefined();
    expect(entry![0]).toMatchObject({
      businessProfileId: ctx.profile.id,
      expenseRecordId: created.body.id,
      effect: "notification",
    });
    const serialised = JSON.stringify(entry, (_key, value) => (value instanceof Error ? value.message : value));
    expect(serialised).not.toMatch(new RegExp(VENDOR));
    expect(serialised).not.toContain(String(LARGE_AMOUNT));
    expect(serialised).not.toContain("Stock purchase");
  });
});
