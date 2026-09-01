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
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * HTTP-level coverage for owner-scoped date overrides
 * (BusinessOperatingDayOverride) — docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md
 * §7.3, §11 Phase 2. Create + list + delete only; deliberately no
 * update-in-place (plan doesn't call for one — a holiday list only needs
 * create/delete).
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

function overridesUrl(profileId: number) {
  return `/api/v1/business-profiles/${profileId}/operating-overrides`;
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

describe("POST /business-profiles/:id/operating-overrides", () => {
  it("creates a CLOSED override with a reason", async () => {
    const response = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date: utcDayString(5), type: "CLOSED", reason: "Typhoon closure" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      businessProfileId: ctx.profile.id,
      date: utcDayString(5),
      type: "CLOSED",
      reason: "Typhoon closure",
    });

    const row = await prisma.businessOperatingDayOverride.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.type).toBe("CLOSED");
  });

  it("creates an OPEN override without a reason", async () => {
    const response = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date: utcDayString(10), type: "OPEN" });

    expect(response.status).toBe(201);
    expect(response.body.reason).toBeNull();
  });

  it("rejects a reason over 120 characters", async () => {
    const response = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date: utcDayString(1), type: "CLOSED", reason: "x".repeat(121) });

    expect(response.status).toBe(400);
  });

  it("rejects a duplicate override for the same date cleanly (no raw Prisma error)", async () => {
    const date = utcDayString(2);
    const first = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date, type: "CLOSED" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date, type: "OPEN" });

    expect([400, 409]).toContain(second.status);
    expect(second.body.error).toBeTypeOf("string");

    const rows = await prisma.businessOperatingDayOverride.findMany({ where: { businessProfileId: ctx.profile.id, date: new Date(`${date}T00:00:00.000Z`) } });
    expect(rows).toHaveLength(1);
  });

  it("returns 404 for another owner's profile and makes no write", async () => {
    const response = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(other.user.authId))
      .send({ date: utcDayString(3), type: "CLOSED" });

    expect(response.status).toBe(404);
    const rows = await prisma.businessOperatingDayOverride.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(0);
  });
});

describe("GET /business-profiles/:id/operating-overrides", () => {
  beforeEach(async () => {
    await prisma.businessOperatingDayOverride.createMany({
      data: [
        { businessProfileId: ctx.profile.id, date: new Date(`${utcDayString(-10)}T00:00:00.000Z`), type: "CLOSED" },
        { businessProfileId: ctx.profile.id, date: new Date(`${utcDayString(5)}T00:00:00.000Z`), type: "OPEN" },
        { businessProfileId: ctx.profile.id, date: new Date(`${utcDayString(40)}T00:00:00.000Z`), type: "CLOSED" },
      ],
    });
  });

  it("lists all overrides for the profile when unfiltered", async () => {
    const response = await request(app)
      .get(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(3);
  });

  it("filters by from/to date range", async () => {
    const response = await request(app)
      .get(overridesUrl(ctx.profile.id))
      .query({ from: utcDayString(0), to: utcDayString(30) })
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].date).toBe(utcDayString(5));
  });

  it("caps the range at 366 days", async () => {
    const response = await request(app)
      .get(overridesUrl(ctx.profile.id))
      .query({ from: utcDayString(0), to: utcDayString(400) })
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(400);
  });

  it("returns 404 for another owner's profile", async () => {
    const response = await request(app)
      .get(overridesUrl(ctx.profile.id))
      .set(...asAuth(other.user.authId));

    expect(response.status).toBe(404);
  });
});

describe("DELETE /business-profiles/:id/operating-overrides/:overrideId", () => {
  it("deletes an existing override", async () => {
    const created = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date: utcDayString(7), type: "CLOSED" });

    const response = await request(app)
      .delete(`${overridesUrl(ctx.profile.id)}/${created.body.id}`)
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(204);
    const row = await prisma.businessOperatingDayOverride.findUnique({ where: { id: created.body.id } });
    expect(row).toBeNull();
  });

  it("returns 404 for a nonexistent override id", async () => {
    const response = await request(app)
      .delete(`${overridesUrl(ctx.profile.id)}/999999`)
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(404);
  });

  it("returns 404 when deleting another owner's override (ownership isolation)", async () => {
    const created = await request(app)
      .post(overridesUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ date: utcDayString(8), type: "CLOSED" });

    const response = await request(app)
      .delete(`${overridesUrl(ctx.profile.id)}/${created.body.id}`)
      .set(...asAuth(other.user.authId));

    expect(response.status).toBe(404);
    const row = await prisma.businessOperatingDayOverride.findUnique({ where: { id: created.body.id } });
    expect(row).not.toBeNull();
  });

  it("returns 404 when an owner tries to delete a DIFFERENT owner's override by ID, even while passing their OWN profile id in the URL (cross-tenant enumeration/IDOR check)", async () => {
    // `other` creates an override on `other.profile` — belongs to a
    // different business profile than `ctx.profile`.
    const created = await request(app)
      .post(overridesUrl(other.profile.id))
      .set(...asAuth(other.user.authId))
      .send({ date: utcDayString(9), type: "CLOSED" });
    expect(created.status).toBe(201);

    // `ctx` owns `ctx.profile` (passes requireOwnedBusinessProfile for THAT
    // profile id) but guesses/enumerates `other`'s override id and submits it
    // against their own, legitimately-owned profile id in the URL. The
    // service's `findFirst({ where: { id, businessProfileId } })` must scope
    // the lookup to `ctx.profile.id`, not just to the id, or this would let
    // one owner delete another owner's override without ever having to pass
    // ownership on the second profile.
    const response = await request(app)
      .delete(`${overridesUrl(ctx.profile.id)}/${created.body.id}`)
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(404);
    const row = await prisma.businessOperatingDayOverride.findUnique({ where: { id: created.body.id } });
    expect(row).not.toBeNull();
    expect(row?.businessProfileId).toBe(other.profile.id);
  });
});
