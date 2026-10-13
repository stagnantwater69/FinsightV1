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
import { resolveBusinessToday, utcDateKey } from "../../src/lib/dates";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
const SUMMARY_SENTINEL = 987_654.32;
const CASHFLOW_SENTINEL = 876_543.21;

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;

  await prisma.expenseRecord.createMany({
    data: [
      {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: new Date("2026-09-15T00:00:00.000Z"),
        description: "Summary timing sentinel",
        amount: SUMMARY_SENTINEL,
        source: "MANUAL_ENTRY",
      },
      {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: new Date(`${utcDateKey(resolveBusinessToday(ctx.profile.timezone))}T00:00:00.000Z`),
        description: "Cashflow timing sentinel",
        amount: CASHFLOW_SENTINEL,
        source: "MANUAL_ENTRY",
      },
    ],
  });
});

afterAll(disconnectDb);

function expectSafeTotalTiming(headerValue: unknown, forbiddenFinancialValue: number): void {
  const header = String(headerValue);
  expect(header).toMatch(/^total;dur=\d+\.\d$/);
  const duration = Number(header.slice("total;dur=".length));
  expect(Number.isFinite(duration) && duration >= 0).toBe(true);
  expect(header).not.toContain(String(forbiddenFinancialValue));
  expect(header).not.toMatch(/(?:user|profile|amount|funds|record)(?:=|;)/i);
}

describe("dashboard Server-Timing", () => {
  it("reports only total duration for the summary endpoint", async () => {
    const response = await request(app)
      .get("/api/v1/dashboard/summary")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, period: "month", month: "2026-09" });

    expect(response.status).toBe(200);
    expect(response.body.overview.totalExpenses).toBeCloseTo(SUMMARY_SENTINEL, 2);
    expectSafeTotalTiming(response.headers["server-timing"], SUMMARY_SENTINEL);
  });

  it("reports only total duration for the cashflow endpoint", async () => {
    const response = await request(app)
      .get("/api/v1/dashboard/cashflow")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, granularity: "daily" });

    expect(response.status).toBe(200);
    expect(response.body.points.at(-1).expenses).toBeCloseTo(CASHFLOW_SENTINEL, 2);
    expectSafeTotalTiming(response.headers["server-timing"], CASHFLOW_SENTINEL);
  });
});
