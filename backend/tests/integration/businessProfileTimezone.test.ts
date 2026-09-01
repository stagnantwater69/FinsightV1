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
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * HTTP-level coverage for the `timezone` field on BusinessProfile create/update
 * — Phase 1 of docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.1.
 *
 * `timezone` must be a real IANA identifier (validated against
 * `Intl.supportedValuesOf("timeZone")`), never a raw numeric UTC offset, and
 * it must go through the same owned-profile update path as every other field.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/business-profiles";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({});
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "New Store",
    type: "Sari-Sari Store",
    availableFunds: 1000,
    expectedMonthlyExpenses: 500,
    operatingDays: 20,
    ...overrides,
  };
}

describe("create", () => {
  it("accepts a valid IANA timezone", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(createBody({ timezone: "America/Los_Angeles" }));
    expect(res.status).toBe(201);
    expect(res.body.timezone).toBe("America/Los_Angeles");
  });

  it("falls back to the DB default (Asia/Manila) when omitted", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(createBody());
    expect(res.status).toBe(201);
    expect(res.body.timezone).toBe("Asia/Manila");
  });

  it("rejects a bogus timezone string", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(createBody({ timezone: "Not/AZone" }));
    expect(res.status).toBe(400);
  });

  it("rejects a numeric-offset-style string", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(createBody({ timezone: "+08:00" }));
    expect(res.status).toBe(400);
  });
});

describe("update", () => {
  it("accepts a valid IANA timezone", async () => {
    const res = await request(app)
      .patch(`${ENDPOINT}/${ctx.profile.id}`)
      .set(...AUTH)
      .send({ timezone: "Europe/London" });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Europe/London");
  });

  it("rejects a bogus timezone string", async () => {
    const res = await request(app)
      .patch(`${ENDPOINT}/${ctx.profile.id}`)
      .set(...AUTH)
      .send({ timezone: "Not/AZone" });
    expect(res.status).toBe(400);
  });

  it("rejects a numeric-offset-style string", async () => {
    const res = await request(app)
      .patch(`${ENDPOINT}/${ctx.profile.id}`)
      .set(...AUTH)
      .send({ timezone: "+08:00" });
    expect(res.status).toBe(400);
  });

  it("is independently updatable, without entangling other fields", async () => {
    const before = await request(app)
      .get(`${ENDPOINT}/${ctx.profile.id}`)
      .set(...AUTH);
    expect(before.status).toBe(200);

    const res = await request(app)
      .patch(`${ENDPOINT}/${ctx.profile.id}`)
      .set(...AUTH)
      .send({ timezone: "Asia/Tokyo" });

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Asia/Tokyo");
    expect(res.body.operatingDays).toBe(before.body.operatingDays);
    expect(res.body.name).toBe(before.body.name);
    expect(res.body.type).toBe(before.body.type);
    expect(res.body.availableFunds).toBe(before.body.availableFunds);
    expect(res.body.expectedMonthlyExpenses).toBe(before.body.expectedMonthlyExpenses);
    expect(res.body.largeExpenseThresholdPercent).toBe(before.body.largeExpenseThresholdPercent);
  });

  it("cannot update timezone on another owner's profile", async () => {
    const other = await makeOwnerWithProfile();
    const res = await request(app)
      .patch(`${ENDPOINT}/${other.profile.id}`)
      .set(...AUTH)
      .send({ timezone: "Asia/Tokyo" });
    expect(res.status).toBe(404);
  });
});
