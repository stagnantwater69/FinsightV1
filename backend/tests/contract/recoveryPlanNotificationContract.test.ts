import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Schema-level contract coverage for the two Recovery Target CRUD surfaces
 * added in RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.5/§10.8/§11 Phase 6:
 *
 *   GET/PUT   /business-profiles/:id/recovery-notification-preferences
 *   GET/PUT   /business-profiles/:id/recovery-plans[?month=]
 *   PUT/DELETE /business-profiles/:id/recovery-plans/:month
 *
 * There was previously no contract test for either family — only the
 * behavioral integration coverage in
 * tests/integration/recoveryNotificationPreference.test.ts and
 * tests/integration/recoveryPlan.test.ts. Both web's and mobile's
 * `RecoveryNotificationPreference`/`RecoveryPlan` types (web/src/lib/types.ts,
 * mobile/src/lib/types.ts) agree field-for-field with the shapes asserted
 * here; `.strict()` throughout so an added/removed/renamed field on either
 * side fails loudly instead of silently drifting, matching this file's
 * established sibling contract tests (recoveryInsightContract.test.ts,
 * recoveryScenarioContract.test.ts).
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
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const recoveryNotificationPreferenceSchema = z
  .object({
    targetIncreaseAlertEnabled: z.boolean(),
    targetIncreaseThresholdPercent: z.number(),
    behindThreeDaysAlertEnabled: z.boolean(),
    openDayNoSalesAlertEnabled: z.boolean(),
    projectionShortfallAlertEnabled: z.boolean(),
    coverageReachedAlertEnabled: z.boolean(),
    quietHoursStart: z.string().nullable(),
    quietHoursEnd: z.string().nullable(),
    minHoursBetweenNotifications: z.number(),
  })
  .strict();

const recoveryPlanSchema = z
  .object({
    month: z.string(),
    bufferPercent: z.number().nullable(),
    deadline: z.string().nullable(),
    ownerTargetAmount: z.number().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

function assertContract<T extends z.ZodTypeAny>(schema: T, body: unknown) {
  const parsed = schema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2)).toBe(true);
}

describe("GET/PUT /business-profiles/:id/recovery-notification-preferences", () => {
  it("GET (unconfigured defaults) matches the contract", async () => {
    const res = await request(app)
      .get(`/api/v1/business-profiles/${ctx.profile.id}/recovery-notification-preferences`)
      .set(...AUTH);
    expect(res.status).toBe(200);
    assertContract(recoveryNotificationPreferenceSchema, res.body);
  });

  it("PUT (a partial update) matches the contract", async () => {
    const res = await request(app)
      .put(`/api/v1/business-profiles/${ctx.profile.id}/recovery-notification-preferences`)
      .set(...AUTH)
      .send({ targetIncreaseThresholdPercent: 20, quietHoursStart: "22:00", quietHoursEnd: "06:00" });
    expect(res.status).toBe(200);
    assertContract(recoveryNotificationPreferenceSchema, res.body);
    expect(res.body.targetIncreaseThresholdPercent).toBe(20);
    expect(res.body.quietHoursStart).toBe("22:00");
    expect(res.body.quietHoursEnd).toBe("06:00");
  });

  it("PUT rejects a body carrying an unrecognized field (e.g. a smuggled businessProfileId), and does not write", async () => {
    const res = await request(app)
      .put(`/api/v1/business-profiles/${ctx.profile.id}/recovery-notification-preferences`)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id + 1, targetIncreaseThresholdPercent: 20 });
    expect(res.status).toBe(400);

    const getRes = await request(app)
      .get(`/api/v1/business-profiles/${ctx.profile.id}/recovery-notification-preferences`)
      .set(...AUTH);
    // Still the unconfigured default (15), proving the rejected PUT never wrote.
    expect(getRes.body.targetIncreaseThresholdPercent).toBe(15);
  });
});

describe("GET/PUT/DELETE /business-profiles/:id/recovery-plans", () => {
  it("PUT (create) matches the contract", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app)
      .put(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans/${month}`)
      .set(...AUTH)
      .send({ bufferPercent: 10, ownerTargetAmount: 50000 });
    expect(res.status).toBe(200);
    assertContract(recoveryPlanSchema, res.body);
    expect(res.body.month).toBe(month);
  });

  it("GET (list) matches the contract for each returned element", async () => {
    const month = new Date().toISOString().slice(0, 7);
    await request(app)
      .put(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans/${month}`)
      .set(...AUTH)
      .send({ bufferPercent: 5 });

    const res = await request(app)
      .get(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans`)
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const plan of res.body) assertContract(recoveryPlanSchema, plan);
  });

  it("PUT rejects a body carrying an unrecognized field (e.g. a smuggled businessProfileId), and does not write", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app)
      .put(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans/${month}`)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id + 1, bufferPercent: 5 });
    expect(res.status).toBe(400);

    const getRes = await request(app)
      .get(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans`)
      .set(...AUTH)
      .query({ month });
    expect(getRes.body).toEqual([]);
  });

  it("DELETE on an existing plan returns 204 with an empty body", async () => {
    const month = new Date().toISOString().slice(0, 7);
    await request(app)
      .put(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans/${month}`)
      .set(...AUTH)
      .send({ bufferPercent: 5 });

    const res = await request(app)
      .delete(`/api/v1/business-profiles/${ctx.profile.id}/recovery-plans/${month}`)
      .set(...AUTH);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});
