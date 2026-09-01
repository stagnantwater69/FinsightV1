import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-level contract for `GET /insights/recovery/month-end-review` —
 * RECOVERY-TARGET-IMPROVEMENT-PLAN.md §10.9/§11 Phase 7. `computeMonthEndReview`
 * itself is already covered end-to-end (tests/integration/recoveryMonthEndReview.test.ts)
 * and at the unit level (tests/unit/recoveryMonthEndReview.test.ts) — this file
 * only proves the routing/validation/ownership wiring: query-param validation,
 * ownership isolation, and that the endpoint hands back the discriminated
 * union `computeMonthEndReview` produces, unmodified.
 */

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
import * as sales from "../../src/services/salesRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { resolveBusinessToday } from "../../src/lib/dates";

const ENDPOINT = "/api/v1/insights/recovery/month-end-review";
const AUTH = ["Authorization", "Bearer valid-token"] as const;

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 150000, operatingDays: 30 }, ["Inventory"]);
  authUserId.value = ctx.user.authId;
});

afterAll(disconnectDb);

describe("GET /insights/recovery/month-end-review — validation", () => {
  it("400s on a missing businessProfileId", async () => {
    const response = await request(app).get(ENDPOINT).set(...AUTH).query({ month: "2020-05" });
    expect(response.status).toBe(400);
  });

  it("400s on an invalid month format", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "2020-5" });
    expect(response.status).toBe(400);
  });

  it("400s on a month with an out-of-range value", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "2020-13" });
    expect(response.status).toBe(400);
  });

  it("400s on a missing month", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id });
    expect(response.status).toBe(400);
  });
});

describe("GET /insights/recovery/month-end-review — ownership isolation", () => {
  it("404s when the businessProfileId belongs to a different owner", async () => {
    const other = await makeOwnerWithProfile({ expectedMonthlyExpenses: 100000, operatingDays: 26 });

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: other.profile.id, month: "2020-05" });

    expect(response.status).toBe(404);
  });
});

describe("GET /insights/recovery/month-end-review — happy path", () => {
  it("returns not_yet_reviewable for the current month", async () => {
    // Same clock computeMonthEndReview itself resolves "today" from — see
    // resolveBusinessToday's own comment on why a naive `new Date()` UTC
    // getter disagrees with it for roughly a third of every day.
    const today = resolveBusinessToday(ctx.profile.timezone);
    const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: currentMonth });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "not_yet_reviewable", month: currentMonth });
  });

  it("returns a reviewable summary for a definitely-past month with confirmed sales", async () => {
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: "2020-05-15",
      description: "Daily sales",
      amount: 9000,
    });

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "2020-05" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("reviewable");
    expect(response.body.month).toBe("2020-05");
    expect(response.body).toHaveProperty("coveragePercent");
    expect(response.body).toHaveProperty("surplusOrShortfall");
    expect(response.body).toHaveProperty("strongestOpenDay");
    expect(response.body).toHaveProperty("weakestOpenDay");
    expect(response.body).toHaveProperty("missingOrProvisionalDayCount");
    expect(response.body).toHaveProperty("openDayCount");
    expect(response.body).toHaveProperty("originalDailyTarget");
    expect(response.body).toHaveProperty("finalAdjustedDailyTarget");
    expect(response.body).toHaveProperty("baselineAppearsOffFromPattern");
    expect(response.body).toHaveProperty("suggestedQuestionsForNextMonth");
    expect(response.body).toHaveProperty("operatingScheduleConfigured");
  });
});
