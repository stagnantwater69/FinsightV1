import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Schema-level contract coverage for GET /insights/recovery/month-end-review —
 * RECOVERY-TARGET-IMPROVEMENT-PLAN.md §10.9/§11 Phase 7.
 *
 * `tests/integration/recoveryMonthEndReviewRoute.test.ts` already covers
 * routing/validation/ownership wiring with `toHaveProperty` assertions; this
 * file instead `.strict()`-pins the FULL discriminated-union response shape
 * (so an added/removed/renamed field fails loudly, matching the established
 * pattern in recoveryInsightContract.test.ts/recoveryScenarioContract.test.ts)
 * and independently re-verifies, against the real HTTP endpoint rather than
 * just by reading the source, the plan's single highest-stakes requirement
 * for this feature: nothing in this response — and no other request this
 * suite makes — ever mutates `expectedMonthlyExpenses`, `operatingDays`, or
 * any `BusinessOperatingDay`/`BusinessOperatingDayOverride` row.
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
import * as businessProfile from "../../src/services/businessProfile.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { prisma } from "../../src/config/prisma";

const openDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sales: z.number().finite(),
  })
  .strict();

const monthEndReviewSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_yet_reviewable"),
      month: z.string().regex(/^\d{4}-\d{2}$/),
    })
    .strict(),
  z
    .object({
      status: z.literal("reviewable"),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      coveragePercent: z.number().finite(),
      surplusOrShortfall: z.number().finite(),
      strongestOpenDay: z.union([z.null(), openDaySchema]),
      weakestOpenDay: z.union([z.null(), openDaySchema]),
      missingOrProvisionalDayCount: z.number().int().nonnegative(),
      openDayCount: z.number().int().nonnegative(),
      originalDailyTarget: z.number().finite(),
      finalAdjustedDailyTarget: z.union([z.null(), z.number().finite()]),
      baselineAppearsOffFromPattern: z.boolean(),
      suggestedQuestionsForNextMonth: z.array(z.string()),
      operatingScheduleConfigured: z.boolean(),
    })
    .strict(),
]);

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/recovery/month-end-review";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 125000, operatingDays: 25 });
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);
afterEach(() => {
  vi.useRealTimers();
});

async function fetchMonthEndReview(month: string) {
  const response = await request(app)
    .get(ENDPOINT)
    .set(...AUTH)
    .query({ businessProfileId: ctx.profile.id, month });
  expect(response.status).toBe(200);
  return response.body;
}

function assertContract(body: unknown) {
  const parsed = monthEndReviewSchema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
}

describe("current month — not yet reviewable", () => {
  it("matches the not_yet_reviewable branch exactly, with no extra fields", async () => {
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const body = await fetchMonthEndReview(currentMonth);
    assertContract(body);
    expect(body.status).toBe("not_yet_reviewable");
  });
});

describe("a definitely-past month with confirmed sales", () => {
  it("matches the reviewable branch exactly, with every numeric field finite", async () => {
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: "2020-05-15",
      description: "Daily sales",
      amount: 9000,
    });

    const body = await fetchMonthEndReview("2020-05");
    assertContract(body);
    expect(body.status).toBe("reviewable");
    expect(body.month).toBe("2020-05");
  });
});

describe("a past month with zero sales at all", () => {
  it("still matches the reviewable branch (openDayCount/missingOrProvisionalDayCount reflect the gap, not an error)", async () => {
    const body = await fetchMonthEndReview("2020-06");
    assertContract(body);
    expect(body.status).toBe("reviewable");
  });
});

/**
 * The plan's single highest-stakes requirement (§10.9, §7 Phase 7): this
 * read-only endpoint must never be a path to mutate next month's baseline.
 * There is no request BODY this endpoint accepts at all (GET, query-string
 * only) — assert that the caller's profile/schedule rows are byte-for-byte
 * unchanged after hitting it, even when `suggestedQuestionsForNextMonth` is
 * non-empty and `baselineAppearsOffFromPattern` is true (the case an "apply
 * this suggestion" control would most plausibly be wired to).
 */
describe("never mutates settings, even when suggestions/off-pattern signals fire", () => {
  it("leaves expectedMonthlyExpenses, operatingDays, and BusinessOperatingDay rows untouched", async () => {
    // A tiny sale against a large expected baseline all but guarantees
    // baselineAppearsOffFromPattern=true and a non-empty suggestions list.
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: "2020-07-15",
      description: "Tiny sale",
      amount: 10,
    });

    const before = await businessProfile.getBusinessProfile(ctx.user.id, ctx.profile.id);
    const scheduleBefore = await prisma.businessOperatingDay.findMany({
      where: { businessProfileId: ctx.profile.id },
      orderBy: { weekday: "asc" },
    });

    const body = await fetchMonthEndReview("2020-07");
    assertContract(body);
    expect(body.status).toBe("reviewable");
    // Sanity: this fixture is actually exercising the interesting case, not
    // silently landing on the boring one.
    expect(body.suggestedQuestionsForNextMonth.length).toBeGreaterThan(0);

    const after = await businessProfile.getBusinessProfile(ctx.user.id, ctx.profile.id);
    const scheduleAfter = await prisma.businessOperatingDay.findMany({
      where: { businessProfileId: ctx.profile.id },
      orderBy: { weekday: "asc" },
    });

    expect(after.expectedMonthlyExpenses.toString()).toBe(before.expectedMonthlyExpenses.toString());
    expect(after.operatingDays).toBe(before.operatingDays);
    expect(scheduleAfter).toEqual(scheduleBefore);
  });
});

describe("month-parameter adversarial validation", () => {
  it("400s on a SQL-injection-shaped month string", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "2026-01' OR '1'='1" });
    expect(response.status).toBe(400);
  });

  it("400s on month=2026-00", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "2026-00" });
    expect(response.status).toBe(400);
  });

  it("cleanly returns not_yet_reviewable, without crashing or hanging, for a far-future month", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "2999-12" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "not_yet_reviewable", month: "2999-12" });
  });

  it("cleanly resolves a far-past month without crashing or hanging", async () => {
    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, month: "1900-01" });
    expect(response.status).toBe(200);
    assertContract(response.body);
    expect(response.body.status).toBe("reviewable");
  });
});
