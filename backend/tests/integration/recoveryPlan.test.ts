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
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * HTTP-level coverage for the owner-saved recovery buffer/deadline plan —
 * docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.5/§10.7, §11 Phase 6.
 *
 * The whole point of this table is that it is a purely separate,
 * owner-visible artifact — see the "zero effect on getRecoveryInsight"
 * describe block below, which is the load-bearing test in this file.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

function plansUrl(profileId: number) {
  return `/api/v1/business-profiles/${profileId}/recovery-plans`;
}

function planUrl(profileId: number, month: string) {
  return `${plansUrl(profileId)}/${month}`;
}

function asAuth(authId: string) {
  authUserId.value = authId;
  return AUTH;
}

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({});
  other = await makeOwnerWithProfile({});
});
afterAll(disconnectDb);

describe("PUT /business-profiles/:id/recovery-plans/:month", () => {
  it("creates a plan with a subset of fields", async () => {
    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 10 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      month: "2026-08",
      bufferPercent: 10,
      deadline: null,
      ownerTargetAmount: null,
    });
  });

  it("upserts (updates) an existing month's plan", async () => {
    await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 10, deadline: "2026-08-31", ownerTargetAmount: 50000 });

    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 20 });

    expect(response.status).toBe(200);
    expect(response.body.bufferPercent).toBe(20);
    // Untouched fields survive the partial update.
    expect(response.body.deadline).toBe("2026-08-31");
    expect(response.body.ownerTargetAmount).toBe(50000);

    const rows = await prisma.recoveryPlan.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid month format in the URL", async () => {
    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-8"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 10 });

    expect(response.status).toBe(400);
  });

  it("rejects bufferPercent outside 0-100", async () => {
    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 150 });

    expect(response.status).toBe(400);
  });

  it("rejects a non-positive ownerTargetAmount", async () => {
    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ ownerTargetAmount: -5 });

    expect(response.status).toBe(400);
  });

  it("rejects an invalid deadline date", async () => {
    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ deadline: "not-a-date" });

    expect(response.status).toBe(400);
  });

  it("returns 404 (not 400) for another owner's profile and makes no write", async () => {
    const response = await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(other.user.authId))
      .send({ bufferPercent: 10 });

    expect(response.status).toBe(404);
    const rows = await prisma.recoveryPlan.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(0);
  });
});

describe("GET /business-profiles/:id/recovery-plans", () => {
  it("returns an empty array when no plans exist", async () => {
    const response = await request(app).get(plansUrl(ctx.profile.id)).set(...asAuth(ctx.user.authId));
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("filters by the month query param", async () => {
    await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 10 });
    await request(app)
      .put(planUrl(ctx.profile.id, "2026-09"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 20 });

    const response = await request(app)
      .get(`${plansUrl(ctx.profile.id)}?month=2026-08`)
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].month).toBe("2026-08");
  });

  it("caps the unfiltered list at the most recent 24 months", async () => {
    for (let i = 0; i < 30; i++) {
      const monthIndex = i; // 0-based months since 2024-01
      const year = 2024 + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;
      await prisma.recoveryPlan.create({
        data: {
          businessProfileId: ctx.profile.id,
          month: new Date(`${monthKey}-01T00:00:00.000Z`),
          bufferPercent: 5,
        },
      });
    }

    const response = await request(app).get(plansUrl(ctx.profile.id)).set(...asAuth(ctx.user.authId));
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(24);
  });

  it("returns 404 for another owner's profile", async () => {
    const response = await request(app).get(plansUrl(ctx.profile.id)).set(...asAuth(other.user.authId));
    expect(response.status).toBe(404);
  });
});

describe("DELETE /business-profiles/:id/recovery-plans/:month", () => {
  it("removes a saved plan", async () => {
    await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 10 });

    const response = await request(app)
      .delete(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(204);
    const rows = await prisma.recoveryPlan.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(0);
  });

  it("404s deleting a plan that doesn't exist", async () => {
    const response = await request(app)
      .delete(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(404);
  });

  it("returns 404 for another owner's profile and makes no delete", async () => {
    await request(app)
      .put(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(ctx.user.authId))
      .send({ bufferPercent: 10 });

    const response = await request(app)
      .delete(planUrl(ctx.profile.id, "2026-08"))
      .set(...asAuth(other.user.authId));

    expect(response.status).toBe(404);
    const rows = await prisma.recoveryPlan.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(1);
  });
});

describe("RecoveryPlan has zero effect on the live recovery calculation", () => {
  it("getRecoveryInsight is unaffected by a RecoveryPlan with a wildly different ownerTargetAmount", async () => {
    // ctx.profile's expectedMonthlyExpenses is a fixed 125000 (see
    // makeOwnerWithProfile's default) — the real recovery target is derived
    // from that, never from anything in RecoveryPlan.
    const before = await request(app)
      .get(`/api/v1/insights/recovery?businessProfileId=${ctx.profile.id}`)
      .set(...asAuth(ctx.user.authId));
    expect(before.status).toBe(200);

    const currentMonthKey = new Date().toISOString().slice(0, 7);
    const putResponse = await request(app)
      .put(planUrl(ctx.profile.id, currentMonthKey))
      .set(...asAuth(ctx.user.authId))
      .send({ ownerTargetAmount: 9_999_999, bufferPercent: 90, deadline: "2026-12-31" });
    expect(putResponse.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/insights/recovery?businessProfileId=${ctx.profile.id}`)
      .set(...asAuth(ctx.user.authId));
    expect(after.status).toBe(200);

    // The live insight must be identical before and after saving a
    // RecoveryPlan with numbers that would visibly change the result if
    // (incorrectly) wired in. `computedAt` is excluded since it's a
    // request-time timestamp, not derived from any stored data.
    const { computedAt: _beforeComputedAt, ...beforeRest } = before.body;
    const { computedAt: _afterComputedAt, ...afterRest } = after.body;
    expect(afterRest).toEqual(beforeRest);
  });
});
