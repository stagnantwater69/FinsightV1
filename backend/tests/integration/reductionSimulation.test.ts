import { describe, expect, it, afterAll, beforeEach, vi } from "vitest";

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
import * as expenses from "../../src/services/expenseRecord.service";
import * as spendingImpact from "../../src/services/insights.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * HTTP-level coverage for POST /insights/reduction-simulation — Phase 4/§12 of
 * docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md.
 *
 * This is a sibling, non-persisting endpoint (§12.2/§12.4) — it is NOT an
 * extension of GET /insights/spending-impact, and this file confirms that
 * endpoint's own existing behavior is unaffected as well as the simulation's
 * own read-only-ness and the invariant that `availableFunds` is never touched.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/reduction-simulation";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

async function addExpense(category: string, description: string, amount: number, dayOffset: number) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories[category]!,
    date: utcDayString(dayOffset),
    description,
    amount,
  });
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories.Inventory,
    periodDays: 30,
    reduction: { kind: "percent", value: 20 },
    ...overrides,
  };
}

describe("authentication", () => {
  it("rejects a request with no bearer token", async () => {
    const response = await request(app).post(ENDPOINT).send(body());
    expect(response.status).toBe(401);
  });
});

describe("ownership isolation", () => {
  it("returns 404 for a foreign business profile", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: other.profile.id, categoryId: other.categories.Inventory }));
    expect(response.status).toBe(404);
  });

  it("returns the same 404 for a foreign profile as for a nonexistent one", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    const foreign = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: other.profile.id, categoryId: other.categories.Inventory }));
    const nonexistent = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: 999999, categoryId: other.categories.Inventory }));
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.status).toBe(404);
  });

  it("rejects a category id belonging to another owner's profile, even under this owner's own profile id", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    await addExpense("Inventory", "This owner's own spend", 5000, -5);

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: ctx.profile.id, categoryId: other.categories.Inventory }));
    expect(response.status).toBe(400);
  });

  it("rejects a category id that does not exist at all", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ categoryId: 999999 }));
    expect(response.status).toBe(400);
  });
});

describe("request validation, matching §12.3", () => {
  it("rejects a missing businessProfileId", async () => {
    const { businessProfileId: _drop, ...rest } = body();
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(rest);
    expect(response.status).toBe(400);
  });

  it("rejects periodDays of 0", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ periodDays: 0 }));
    expect(response.status).toBe(400);
  });

  it("rejects periodDays over 366", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ periodDays: 367 }));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed endDate", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ endDate: "31-01-2026" }));
    expect(response.status).toBe(400);
  });

  it("rejects a reduction kind that isn't percent or amount", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "fraction", value: 0.2 } }));
    expect(response.status).toBe(400);
  });

  it("rejects a percent reduction of 0", async () => {
    await addExpense("Inventory", "Spend", 5000, -5);
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "percent", value: 0 } }));
    expect(response.status).toBe(400);
  });

  it("rejects a percent reduction over 100", async () => {
    await addExpense("Inventory", "Spend", 5000, -5);
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "percent", value: 101 } }));
    expect(response.status).toBe(400);
  });

  it("rejects an amount reduction greater than the category's period total", async () => {
    await addExpense("Inventory", "Spend", 1000, -5);
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "amount", value: 1000.01 } }));
    expect(response.status).toBe(400);
  });

  it("rejects a reduction when the category has zero spend in the period", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "percent", value: 10 } }));
    expect(response.status).toBe(400);
  });
});

describe("response contract", () => {
  it("computes a percent reduction against the owner's actual period totals", async () => {
    await addExpense("Inventory", "Inventory spend", 8000, -5);
    await addExpense("Utilities", "Utilities spend", 2000, -6);

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "percent", value: 25 } }));

    expect(response.status).toBe(200);
    expect(response.body.categoryId).toBe(ctx.categories.Inventory);
    expect(response.body.categoryName).toBe("Inventory");
    expect(response.body.categoryExpenses).toEqual({ before: 8000, after: 6000 });
    expect(response.body.totalExpenses).toEqual({ before: 10000, after: 8000 });
    expect(response.body.hypotheticalReduction).toBe(2000);
    expect(response.body.requestedReductionPercent).toBe(25);
    expect(Array.isArray(response.body.assumptions)).toBe(true);
    expect(response.body.assumptions.length).toBeGreaterThan(0);
    expect(response.body).not.toHaveProperty("availableFunds");
  });

  it("computes an amount reduction against the owner's actual period totals", async () => {
    await addExpense("Inventory", "Inventory spend", 8000, -5);

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "amount", value: 3000 } }));

    expect(response.status).toBe(200);
    expect(response.body.categoryExpenses).toEqual({ before: 8000, after: 5000 });
    expect(response.body.hypotheticalReduction).toBe(3000);
  });

  it("ignores a client-supplied baseline field, computing from records instead", async () => {
    await addExpense("Inventory", "Inventory spend", 8000, -5);

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      // categoryExpenses is not part of the accepted request shape (§12.2) —
      // sending it must have no effect on the computed baseline.
      .send({ ...body({ reduction: { kind: "percent", value: 10 } }), categoryExpenses: { before: 1, after: 0 } });

    expect(response.status).toBe(200);
    expect(response.body.categoryExpenses.before).toBe(8000);
  });
});

describe("availableFunds is never touched", () => {
  it("leaves the business profile's availableFunds unchanged after a successful simulation", async () => {
    await addExpense("Inventory", "Inventory spend", 8000, -5);
    const before = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "percent", value: 50 } }));
    expect(response.status).toBe(200);

    const after = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    expect(after.availableFunds.toString()).toBe(before.availableFunds.toString());
  });
});

describe("the endpoint performs no writes", () => {
  it("leaves row counts unchanged across every table it reads", async () => {
    await addExpense("Inventory", "Inventory spend", 8000, -5);
    await addExpense("Utilities", "Utilities spend", 2000, -6);

    const before = {
      expenseRecord: await prisma.expenseRecord.count(),
      expenseCategory: await prisma.expenseCategory.count(),
      businessProfile: await prisma.businessProfile.count(),
      notification: await prisma.notification.count(),
    };

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ reduction: { kind: "percent", value: 25 } }));
    expect(response.status).toBe(200);

    const after = {
      expenseRecord: await prisma.expenseRecord.count(),
      expenseCategory: await prisma.expenseCategory.count(),
      businessProfile: await prisma.businessProfile.count(),
      notification: await prisma.notification.count(),
    };
    expect(after).toEqual(before);
  });
});

describe("/insights/spending-impact is unaffected by this addition", () => {
  it("still computes planned-purchase impact against availableFunds exactly as before", async () => {
    const result = await spendingImpact.simulateSpendingImpact(ctx.user.id, ctx.profile.id, 1000, 30);
    expect(result.availableFunds).toBe(48500);
    expect(result.resultingFunds).toBe(47500);
    expect(result.funds).toEqual({ before: 48500, after: 47500 });
  });

  it("still responds 200 over HTTP with its existing shape", async () => {
    const response = await request(app)
      .get("/api/v1/insights/spending-impact")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, plannedAmount: 500 });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("availableFunds");
    expect(response.body).toHaveProperty("resultingFunds");
    expect(response.body).toHaveProperty("impactBand");
  });
});
