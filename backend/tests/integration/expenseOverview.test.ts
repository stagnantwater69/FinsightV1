import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
const ownedBehaviorCalls = vi.fn();

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

vi.mock("../../src/services/insights.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/insights.service")>();
  return {
    ...actual,
    getExpenseBehaviorForOwnedBusiness: (
      ...args: Parameters<typeof actual.getExpenseBehaviorForOwnedBusiness>
    ) => {
      ownedBehaviorCalls(...args);
      return actual.getExpenseBehaviorForOwnedBusiness(...args);
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/expense-overview";
const FINANCIAL_SENTINEL = 987_654.32;
const CURRENT_TOTAL = FINANCIAL_SENTINEL + 1_500 + 1_400 + 500 + 550 + 600;

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile(
    { availableFunds: 76_543.21, expectedMonthlyExpenses: 54_321.09 },
    ["Inventory", "Utilities"],
  );
  authUserId.value = ctx.user.authId;

  await prisma.expenseRecord.createMany({
    data: [
      ["2026-09-03", "Inventory", FINANCIAL_SENTINEL],
      ["2026-09-05", "Inventory", 1_500],
      ["2026-09-10", "Inventory", 1_400],
      ["2026-09-12", "Utilities", 500],
      ["2026-09-18", "Utilities", 550],
      ["2026-09-25", "Utilities", 600],
      ["2026-08-05", "Inventory", 1_200],
      ["2026-08-15", "Inventory", 1_300],
      ["2026-08-25", "Inventory", 1_400],
      ["2026-08-10", "Utilities", 450],
      ["2026-08-20", "Utilities", 500],
      ["2026-08-30", "Utilities", 550],
    ].map(([date, category, amount], index) => ({
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories[category as string]!,
      date: new Date(`${date}T00:00:00.000Z`),
      description: `Overview fixture ${index + 1}`,
      amount: amount as number,
      source: "MANUAL_ENTRY" as const,
    })),
  });

  ownedBehaviorCalls.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(disconnectDb);

function rollingQuery(view: "dashboard" | "detail") {
  return {
    businessProfileId: ctx.profile.id,
    view,
    periodDays: 30,
    endDate: "2026-09-30",
  };
}

function monthQuery(view: "dashboard" | "detail") {
  return {
    businessProfileId: ctx.profile.id,
    view,
    period: "month",
    month: "2026-09",
  };
}

async function legacyBehavior(query: Record<string, string | number>) {
  return request(app)
    .get("/api/v1/insights/expense-behavior")
    .set(...AUTH)
    .query(query);
}

async function legacyOpportunities(query: Record<string, string | number>) {
  return request(app)
    .get("/api/v1/insights/reduction-opportunities")
    .set(...AUTH)
    .query(query);
}

function expectedTopOpportunity(response: {
  dataQuality: { status: string };
  opportunities: Array<{ confidence: string }>;
}) {
  const top = response.opportunities[0];
  return response.dataQuality.status === "insufficient" || !top || top.confidence === "limited"
    ? null
    : top;
}

describe("request boundary", () => {
  it("rejects unauthenticated requests", async () => {
    const response = await request(app).get(ENDPOINT).query(rollingQuery("dashboard"));
    expect(response.status).toBe(401);
  });

  it("requires a supported view", async () => {
    const missing = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id });
    const invalid = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ ...rollingQuery("dashboard"), view: "summary" });

    expect(missing.status).toBe(400);
    expect(invalid.status).toBe(400);
  });

  it("rejects invalid period selections and rolling windows", async () => {
    const invalidPeriod = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ ...rollingQuery("dashboard"), period: "quarter" });
    const missingMonth = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, view: "dashboard", period: "month" });
    const malformedMonth = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, view: "dashboard", period: "month", month: "2026-13" });
    const invalidDays = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, view: "dashboard", periodDays: 0 });

    expect(invalidPeriod.status).toBe(400);
    expect(missingMonth.status).toBe(400);
    expect(malformedMonth.status).toBe(400);
    expect(invalidDays.status).toBe(400);
  });

  it("does not reveal whether a denied business exists", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    const foreign = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ ...rollingQuery("dashboard"), businessProfileId: other.profile.id });
    const nonexistent = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ ...rollingQuery("dashboard"), businessProfileId: 999_999 });

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(nonexistent.body);
  });
});

describe("response projections and financial parity", () => {
  it("returns only the dashboard comparison and top opportunity projections", async () => {
    const query = rollingQuery("dashboard");
    const behavior = await legacyBehavior(query);
    const opportunities = await legacyOpportunities(query);
    const response = await request(app).get(ENDPOINT).set(...AUTH).query(query);

    expect(behavior.status).toBe(200);
    expect(opportunities.status).toBe(200);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      view: "dashboard",
      comparison: {
        status: "available",
        data: {
          period: behavior.body.period,
          totals: behavior.body.totals,
          categoryTrends: behavior.body.categoryTrends,
        },
      },
      topOpportunity: {
        status: "available",
        data: expectedTopOpportunity(opportunities.body),
      },
    });
    expect(response.body.comparison.data).not.toHaveProperty("dailyTotals");
    expect(response.body.comparison.data).not.toHaveProperty("unusualExpenses");
  });

  it("returns full detail panels with unchanged legacy financial fingerprints", async () => {
    const query = monthQuery("detail");
    const behavior = await legacyBehavior(query);
    const opportunities = await legacyOpportunities(query);
    const response = await request(app).get(ENDPOINT).set(...AUTH).query(query);

    expect(behavior.status).toBe(200);
    expect(opportunities.status).toBe(200);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      view: "detail",
      behavior: { status: "available", data: behavior.body },
      opportunities: { status: "available", data: opportunities.body },
    });
  });
});

describe("observability and recovery", () => {
  it("emits only approved Server-Timing names and finite numeric durations", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query(rollingQuery("dashboard"));

    expect(response.status).toBe(200);
    expect(response.body.comparison.data.totals.current).toBeCloseTo(CURRENT_TOTAL, 2);

    const header = String(response.headers["server-timing"]);
    const parts = header.split(", ");
    expect(parts).toHaveLength(4);
    const parsed = parts.map((part) => {
      const match = /^(total|ownership|expense-behavior|reduction-opportunities);dur=(\d+\.\d)$/.exec(part);
      expect(match).not.toBeNull();
      return { name: match![1], duration: Number(match![2]) };
    });

    expect(parsed.map(({ name }) => name)).toEqual([
      "total",
      "ownership",
      "expense-behavior",
      "reduction-opportunities",
    ]);
    expect(parsed.every(({ duration }) => Number.isFinite(duration) && duration >= 0)).toBe(true);
    expect(header).not.toContain(String(CURRENT_TOTAL));
    expect(header).not.toContain(String(FINANCIAL_SENTINEL));
    expect(header).not.toMatch(/(?:user|profile|amount|funds|record)(?:=|;)/i);
  });

  it("keeps behavior available when the optional opportunity read fails", async () => {
    const anomalyRead = vi
      .spyOn(prisma.anomalyFinding, "findMany")
      .mockRejectedValueOnce(new Error("injected optional panel failure"));

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query(rollingQuery("detail"));

    expect(response.status).toBe(200);
    expect(response.body.behavior.status).toBe("available");
    expect(response.body.behavior.data.totals.current).toBeCloseTo(CURRENT_TOTAL, 2);
    expect(response.body.opportunities).toEqual({ status: "unavailable", data: null });
    expect(anomalyRead).toHaveBeenCalledTimes(1);
  });

  it("runs the owned expense behavior computation exactly once", async () => {
    ownedBehaviorCalls.mockClear();

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query(rollingQuery("detail"));

    expect(response.status).toBe(200);
    expect(ownedBehaviorCalls).toHaveBeenCalledTimes(1);
  });
});
