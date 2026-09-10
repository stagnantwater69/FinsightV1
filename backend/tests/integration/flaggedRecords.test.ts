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
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const FLAGGED = "/api/v1/records/flagged";
const COUNT = "/api/v1/records/flagged/count";

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

/** `count` flagged expenses, all on distinct days so ordering is unambiguous. */
async function seedFlaggedExpenses(profileId: number, categoryId: number, count: number) {
  await prisma.expenseRecord.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      businessProfileId: profileId,
      categoryId,
      date: utcDay(-i),
      description: `Flagged ${i}`,
      amount: 100 + i,
      source: "MANUAL_ENTRY" as const,
      reviewStatus: "Needs Review",
    })),
  });
}

async function seedFlaggedSales(profileId: number, count: number) {
  await prisma.salesReferenceRecord.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      businessProfileId: profileId,
      date: utcDay(-i),
      description: `Flagged sale ${i}`,
      amount: 50 + i,
      source: "MANUAL_ENTRY" as const,
      duplicateStatus: "Flagged",
    })),
  });
}

/**
 * PERF-001 — the flagged list had no `take` and no cursor, and both clients
 * downloaded all of it to render a badge number.
 */
describe("GET /records/flagged", () => {
  it("caps the legacy array response instead of returning everything", async () => {
    await seedFlaggedExpenses(ctx.profile.id, ctx.categories.Inventory!, 250);

    const res = await request(app).get(FLAGGED).query({ businessProfileId: ctx.profile.id }).set(...AUTH);

    expect(res.status).toBe(200);
    // Still a bare array — the shape both clients parse today.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(200);
    // ...and it says so, so an un-updated client can tell it is truncated.
    expect(res.headers["x-next-cursor"]).toBeTruthy();
  });

  it("returns a paginated envelope when asked, and walks every record exactly once", async () => {
    await seedFlaggedExpenses(ctx.profile.id, ctx.categories.Inventory!, 7);
    await seedFlaggedSales(ctx.profile.id, 5);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await request(app)
        .get(FLAGGED)
        .query({ businessProfileId: ctx.profile.id, limit: 5, ...(cursor ? { cursor } : {}) })
        .set(...AUTH);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(5);
      seen.push(...res.body.items.map((r: { type: string; id: number }) => `${r.type}-${r.id}`));
      cursor = res.body.nextCursor ?? undefined;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("never returns another business's flagged records", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    await seedFlaggedExpenses(other.profile.id, other.categories.Inventory!, 3);
    await seedFlaggedExpenses(ctx.profile.id, ctx.categories.Inventory!, 2);

    const mine = await request(app).get(FLAGGED).query({ businessProfileId: ctx.profile.id }).set(...AUTH);
    expect(mine.body).toHaveLength(2);

    const theirs = await request(app).get(FLAGGED).query({ businessProfileId: other.profile.id }).set(...AUTH);
    expect(theirs.status).toBe(404);
  });

  it("rejects a malformed cursor with a 400 rather than ignoring it", async () => {
    const res = await request(app)
      .get(FLAGGED)
      .query({ businessProfileId: ctx.profile.id, cursor: "not-a-cursor" })
      .set(...AUTH);
    expect(res.status).toBe(400);
  });
});

describe("GET /records/flagged/count", () => {
  it("gives the badge number without sending the list", async () => {
    await seedFlaggedExpenses(ctx.profile.id, ctx.categories.Inventory!, 250);
    await seedFlaggedSales(ctx.profile.id, 4);
    // A record that is neither needing review nor flagged must not be counted.
    await prisma.expenseRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: utcDay(),
        description: "Settled",
        amount: 12.5,
        source: "MANUAL_ENTRY",
        reviewStatus: "Reviewed",
        duplicateStatus: "Not a Duplicate",
      },
    });

    const res = await request(app).get(COUNT).query({ businessProfileId: ctx.profile.id }).set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expenses: 250, sales: 4, total: 254 });
  });

  it("answers 404 for a business the caller does not own, never another tenant's count", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
    await seedFlaggedExpenses(other.profile.id, other.categories.Inventory!, 9);

    const res = await request(app).get(COUNT).query({ businessProfileId: other.profile.id }).set(...AUTH);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("9");
  });

  it("requires authentication", async () => {
    const res = await request(app).get(COUNT).query({ businessProfileId: ctx.profile.id });
    expect(res.status).toBe(401);
  });
});
