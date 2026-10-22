import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authUserId = vi.hoisted(() => ({ value: "" }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async () => ({ data: { user: { id: authUserId.value } }, error: null }) } } };
});

import request from "supertest";
import { app } from "../../src/app";
import { observeRequestTiming, type CompletedRequestTiming } from "../../src/lib/requestTiming";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import * as expenses from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * How many database round trips each everyday action costs.
 *
 * From a laptop to the hosted database every round trip is about 60 ms, so a
 * request's speed is mostly this count times the distance. Unlike a duration,
 * the count is the same on every machine, which makes it something CI can hold.
 *
 * The budgets are the counts measured on 2026-10-18. A change that adds round
 * trips to one of these actions fails here; one that removes them should lower
 * the number. Counted per Prisma operation, so a transaction's BEGIN and
 * COMMIT are not included, and operations run in parallel still each count.
 */
const BUDGET: Record<string, number> = {
  // 24 -> 25 on 2026-10-22: available funds reads the daily totals plus the
  // baseline day's sales and expenses (three aggregates, run in parallel)
  // instead of two whole-ledger sums. Same wall-clock round trip; at 500,000
  // records the calculation went from ~240 ms to ~8 ms.
  "dashboard summary": 25,
  "dashboard cashflow": 3,
  "records list": 5,
  notifications: 5,
  "expense create": 9,
  "expense edit": 9,
  "expense delete": 6,
};

const AUTH = ["Authorization", "Bearer synthetic-token"] as const;
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let finished: CompletedRequestTiming[] = [];
let stopObserving: () => void = () => {};
const measured: { action: string; dbOperations: number; totalMs: number }[] = [];

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
  for (let day = 1; day <= 20; day++) {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(-day),
      description: `Seed purchase ${day}`,
      amount: 100 + day,
    });
  }
  finished = [];
  stopObserving = observeRequestTiming((timing) => finished.push(timing));
});

afterEach(() => stopObserving());

afterAll(async () => {
  console.log(`\nround trips per action\n${measured.map((m) => `  ${m.action.padEnd(28)} ${String(m.dbOperations).padStart(3)} ops  ${Math.round(m.totalMs)} ms`).join("\n")}`);
  await disconnectDb();
});

/** Runs one request and returns what it cost; the request must succeed. */
async function measure(action: string, send: () => request.Test) {
  finished = [];
  const response = await send();
  expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
  expect(finished).toHaveLength(1);
  const [timing] = finished;
  measured.push({ action, dbOperations: timing!.dbOperations, totalMs: timing!.totalMs });
  return { response, dbOperations: timing!.dbOperations };
}

function expectWithinBudget(action: string, dbOperations: number) {
  const budget = BUDGET[action];
  expect(budget, `no budget for ${action}`).toBeDefined();
  expect(dbOperations, `${action} made ${dbOperations} round trips; budget ${budget}`).toBeLessThanOrEqual(budget!);
}

describe("database round trips per action", () => {
  it.each([
    ["dashboard summary", () => `/api/v1/dashboard/summary?businessProfileId=${ctx.profile.id}`],
    ["dashboard cashflow", () => `/api/v1/dashboard/cashflow?businessProfileId=${ctx.profile.id}`],
    ["records list", () => `/api/v1/records/search?businessProfileId=${ctx.profile.id}`],
    ["notifications", () => `/api/v1/notifications?businessProfileId=${ctx.profile.id}`],
  ] as const)("%s", async (action, path) => {
    const { dbOperations } = await measure(action, () => request(app).get(path()).set(...AUTH));
    expectWithinBudget(action, dbOperations);
  });

  it("expense create, edit and delete", async () => {
    const created = await measure("expense create", () => request(app).post("/api/v1/records/expenses").set(...AUTH).send({
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory,
      date: utcDayString(0),
      description: "Measured purchase",
      amount: 250,
    }));
    expectWithinBudget("expense create", created.dbOperations);
    const id = created.response.body.id as number;

    const edited = await measure("expense edit", () => request(app).patch(`/api/v1/records/expenses/${id}`).set(...AUTH).send({ amount: 275 }));
    expectWithinBudget("expense edit", edited.dbOperations);

    const removed = await measure("expense delete", () => request(app).delete(`/api/v1/records/expenses/${id}`).set(...AUTH));
    expectWithinBudget("expense delete", removed.dbOperations);
  });
});
