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
 * HTTP-level coverage for the owner-controlled recovery notification
 * preferences — docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.5/§10.8, §11
 * Phase 6.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

function prefUrl(profileId: number) {
  return `/api/v1/business-profiles/${profileId}/recovery-notification-preferences`;
}

function asAuth(authId: string) {
  authUserId.value = authId;
  return AUTH;
}

const DEFAULTS = {
  targetIncreaseAlertEnabled: true,
  targetIncreaseThresholdPercent: 15,
  behindThreeDaysAlertEnabled: true,
  openDayNoSalesAlertEnabled: true,
  projectionShortfallAlertEnabled: true,
  coverageReachedAlertEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  minHoursBetweenNotifications: 24,
};

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({});
  other = await makeOwnerWithProfile({});
});
afterAll(disconnectDb);

describe("GET /business-profiles/:id/recovery-notification-preferences", () => {
  it("returns all-defaults when unconfigured, without creating a row", async () => {
    const response = await request(app).get(prefUrl(ctx.profile.id)).set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULTS);

    const row = await prisma.recoveryNotificationPreference.findUnique({
      where: { businessProfileId: ctx.profile.id },
    });
    expect(row).toBeNull();
  });

  it("returns 404 for another owner's profile", async () => {
    const response = await request(app).get(prefUrl(ctx.profile.id)).set(...asAuth(other.user.authId));
    expect(response.status).toBe(404);
  });
});

describe("PUT /business-profiles/:id/recovery-notification-preferences", () => {
  it("persists a partial update and a subsequent GET reflects it", async () => {
    const putResponse = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ targetIncreaseAlertEnabled: false, targetIncreaseThresholdPercent: 25 });

    expect(putResponse.status).toBe(200);
    expect(putResponse.body.targetIncreaseAlertEnabled).toBe(false);
    expect(putResponse.body.targetIncreaseThresholdPercent).toBe(25);
    // Untouched fields keep their defaults.
    expect(putResponse.body.behindThreeDaysAlertEnabled).toBe(true);
    expect(putResponse.body.minHoursBetweenNotifications).toBe(24);

    const getResponse = await request(app).get(prefUrl(ctx.profile.id)).set(...asAuth(ctx.user.authId));
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.targetIncreaseAlertEnabled).toBe(false);
    expect(getResponse.body.targetIncreaseThresholdPercent).toBe(25);
  });

  it("accepts a valid quiet-hours window, including one that wraps midnight", async () => {
    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: "22:00", quietHoursEnd: "06:00" });

    expect(response.status).toBe(200);
    expect(response.body.quietHoursStart).toBe("22:00");
    expect(response.body.quietHoursEnd).toBe("06:00");
  });

  it("rejects setting only quietHoursStart without quietHoursEnd", async () => {
    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: "22:00" });

    expect(response.status).toBe(400);
  });

  it("rejects setting only quietHoursEnd without quietHoursStart", async () => {
    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursEnd: "06:00" });

    expect(response.status).toBe(400);
  });

  it("rejects clearing only one side of an existing quiet-hours window", async () => {
    await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: "22:00", quietHoursEnd: "06:00" });

    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: null });

    expect(response.status).toBe(400);
  });

  it("allows clearing both sides of a quiet-hours window together", async () => {
    await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: "22:00", quietHoursEnd: "06:00" });

    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: null, quietHoursEnd: null });

    expect(response.status).toBe(200);
    expect(response.body.quietHoursStart).toBeNull();
    expect(response.body.quietHoursEnd).toBeNull();
  });

  it("rejects a malformed time string", async () => {
    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ quietHoursStart: "22:00", quietHoursEnd: "6am" });

    expect(response.status).toBe(400);
  });

  it("rejects targetIncreaseThresholdPercent outside 1-100", async () => {
    const tooLow = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ targetIncreaseThresholdPercent: 0 });
    expect(tooLow.status).toBe(400);

    const tooHigh = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ targetIncreaseThresholdPercent: 101 });
    expect(tooHigh.status).toBe(400);
  });

  it("rejects minHoursBetweenNotifications outside 1-168", async () => {
    const tooLow = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ minHoursBetweenNotifications: 0 });
    expect(tooLow.status).toBe(400);

    const tooHigh = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ minHoursBetweenNotifications: 169 });
    expect(tooHigh.status).toBe(400);
  });

  it("returns 404 (not 400) for another owner's profile and makes no write", async () => {
    const response = await request(app)
      .put(prefUrl(ctx.profile.id))
      .set(...asAuth(other.user.authId))
      .send({ targetIncreaseAlertEnabled: false });

    expect(response.status).toBe(404);
    const row = await prisma.recoveryNotificationPreference.findUnique({
      where: { businessProfileId: ctx.profile.id },
    });
    expect(row).toBeNull();
  });
});
