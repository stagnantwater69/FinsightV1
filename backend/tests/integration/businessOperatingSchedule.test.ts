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
 * HTTP-level coverage for the owner-controlled weekly operating schedule —
 * docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.2/§7.4, §11 Phase 2.
 *
 * The whole point of these endpoints is guaranteeing "all seven weekdays
 * exist after schedule setup, so absence never gets overloaded to mean
 * closed" — that invariant is asserted directly here.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

function scheduleUrl(profileId: number) {
  return `/api/v1/business-profiles/${profileId}/operating-schedule`;
}

function allSevenOpen() {
  return Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, isOpen: true }));
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

describe("GET /business-profiles/:id/operating-schedule", () => {
  it("returns an empty array when the schedule has never been configured", async () => {
    const response = await request(app)
      .get(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("returns 404 for another owner's profile", async () => {
    const response = await request(app)
      .get(scheduleUrl(ctx.profile.id))
      .set(...asAuth(other.user.authId));

    expect(response.status).toBe(404);
  });
});

describe("PUT /business-profiles/:id/operating-schedule", () => {
  it("accepts a valid all-seven upsert", async () => {
    const entries = [
      { weekday: 1, isOpen: true },
      { weekday: 2, isOpen: true },
      { weekday: 3, isOpen: true },
      { weekday: 4, isOpen: true },
      { weekday: 5, isOpen: true },
      { weekday: 6, isOpen: true },
      { weekday: 7, isOpen: false },
    ];

    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(7);
    expect(response.body.find((e: { weekday: number }) => e.weekday === 7).isOpen).toBe(false);

    const rows = await prisma.businessOperatingDay.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(7);
  });

  it("re-upserting replaces the prior schedule cleanly", async () => {
    await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries: allSevenOpen() });

    const closedSunday = allSevenOpen().map((e) => (e.weekday === 7 ? { weekday: 7, isOpen: false } : e));
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries: closedSunday });

    expect(response.status).toBe(200);
    const rows = await prisma.businessOperatingDay.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(7);
    const sunday = rows.find((r) => r.weekday === 7);
    expect(sunday?.isOpen).toBe(false);
  });

  it("rejects an update with only six entries", async () => {
    const entries = allSevenOpen().slice(0, 6);
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries });

    expect(response.status).toBe(400);
    const rows = await prisma.businessOperatingDay.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(0);
  });

  it("rejects an update with eight entries", async () => {
    const entries = [...allSevenOpen(), { weekday: 1, isOpen: false }];
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries });

    expect(response.status).toBe(400);
  });

  it("rejects a duplicate weekday even when the count is seven", async () => {
    const entries = allSevenOpen().map((e) => (e.weekday === 7 ? { weekday: 1, isOpen: true } : e));
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries });

    expect(response.status).toBe(400);
  });

  it("rejects weekday 0", async () => {
    const entries = allSevenOpen().map((e) => (e.weekday === 7 ? { weekday: 0, isOpen: true } : e));
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries });

    expect(response.status).toBe(400);
  });

  it("rejects weekday 8", async () => {
    const entries = allSevenOpen().map((e) => (e.weekday === 7 ? { weekday: 8, isOpen: true } : e));
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(ctx.user.authId))
      .send({ entries });

    expect(response.status).toBe(400);
  });

  it("returns 404 (not 400) for another owner's profile and makes no write", async () => {
    const response = await request(app)
      .put(scheduleUrl(ctx.profile.id))
      .set(...asAuth(other.user.authId))
      .send({ entries: allSevenOpen() });

    expect(response.status).toBe(404);
    const rows = await prisma.businessOperatingDay.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(rows).toHaveLength(0);
  });

  it("survives concurrent PUTs for the same profile without a raw 500", async () => {
    // Regression test: the original delete-then-createMany implementation,
    // run inside a single $transaction with no unique-violation handling,
    // reliably 500'd 2-of-4 concurrent writers here — the second writer's
    // createMany collided with the first writer's already-committed rows
    // under BusinessOperatingDay_profile_weekday_key, and errorHandler had
    // no case for a raw PrismaClientKnownRequestError/P2002, so it fell
    // through to a generic 500 instead of succeeding or returning a clean
    // 409. The fix (per-weekday upsert) must make every one of these
    // concurrent requests resolve 200, and leave exactly one complete,
    // internally consistent 7-row schedule behind — never a partial mix of
    // two interleaved writes.
    const auth = asAuth(ctx.user.authId);
    const closedSunday = allSevenOpen().map((e) => (e.weekday === 7 ? { weekday: 7, isOpen: false } : e));
    const closedSaturday = allSevenOpen().map((e) => (e.weekday === 6 ? { weekday: 6, isOpen: false } : e));

    const variants = [allSevenOpen(), closedSunday, closedSaturday, allSevenOpen()];
    const responses = await Promise.all(
      variants.map((entries) => request(app).put(scheduleUrl(ctx.profile.id)).set(...auth).send({ entries })),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(7);
    }

    const rows = await prisma.businessOperatingDay.findMany({
      where: { businessProfileId: ctx.profile.id },
      orderBy: { weekday: "asc" },
    });
    // Exactly one row per weekday 1-7 — never zero, never duplicated — and
    // the whole 7-row set must match ONE of the four submitted variants
    // wholesale, not a mix of two interleaved writes (e.g. Saturday's
    // isOpen from one request alongside Sunday's from another). Postgres
    // row locks held for the life of each PUT's transaction guarantee this:
    // a slower writer blocks on the first contested row until the faster
    // one fully commits, then re-applies all seven of its own values
    // uncontested — so whichever request commits last wins completely.
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const finalState = rows.map((r) => ({ weekday: r.weekday, isOpen: r.isOpen }));
    const matchesOneVariantWholesale = variants.some(
      (variant) => JSON.stringify([...variant].sort((a, b) => a.weekday - b.weekday)) === JSON.stringify(finalState),
    );
    expect(matchesOneVariantWholesale).toBe(true);
  });
});
