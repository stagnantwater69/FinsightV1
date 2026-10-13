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
import * as expenses from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
});

afterAll(disconnectDb);

function endDateRequests(endDate: string) {
  return [
    request(app).get("/api/v1/insights/expense-overview").set(...AUTH).query({
      businessProfileId: ctx.profile.id,
      view: "detail",
      endDate,
    }),
    request(app).get("/api/v1/insights/expense-behavior").set(...AUTH).query({
      businessProfileId: ctx.profile.id,
      endDate,
    }),
    request(app).get("/api/v1/insights/reduction-opportunities").set(...AUTH).query({
      businessProfileId: ctx.profile.id,
      endDate,
    }),
    request(app).post("/api/v1/insights/reduction-simulation").set(...AUTH).send({
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory,
      periodDays: 30,
      endDate,
      reduction: { kind: "percent", value: 10 },
    }),
  ];
}

describe("insight endDate validation", () => {
  it.each(["2025-02-29", "2025-02-31", "2025-04-31"])(
    "rejects the impossible date %s on every shared endDate route",
    async (endDate) => {
      const responses = await Promise.all(endDateRequests(endDate));
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    },
  );

  it("accepts a real leap day on every shared endDate route", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: "2024-02-20",
      description: "Leap-month inventory",
      amount: 100,
    });
    const responses = await Promise.all(endDateRequests("2024-02-29"));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  });
});

describe("spending-impact amount validation", () => {
  async function simulate(plannedAmount: string) {
    return request(app).get("/api/v1/insights/spending-impact").set(...AUTH).query({
      businessProfileId: ctx.profile.id,
      plannedAmount,
    });
  }

  it.each(["-0.01", "0.001", "10000000000", "Infinity", "NaN"])(
    "rejects the invalid planned amount %s at the HTTP boundary",
    async (plannedAmount) => {
      expect((await simulate(plannedAmount)).status).toBe(400);
    },
  );

  it.each(["0", "0.01", "9999999999.99"])(
    "accepts the valid planned amount %s at the HTTP boundary",
    async (plannedAmount) => {
      expect((await simulate(plannedAmount)).status).toBe(200);
    },
  );
});
