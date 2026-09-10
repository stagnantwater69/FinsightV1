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

import request from "supertest";
import { app } from "../../src/app";
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
