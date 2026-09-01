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
 * HTTP-level coverage for owner-controlled `ExpenseCategory.costBehavior` —
 * docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md §5.2 / §15 Phase 5.
 *
 * Deliberately plain: no name-based auto-classification anywhere in this
 * layer. A category not given a value stays at the column default
 * (UNCLASSIFIED), on both create and update.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const CATEGORIES_ENDPOINT = "/api/v1/records/categories";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

describe("POST /records/categories — create", () => {
  it("defaults to UNCLASSIFIED when costBehavior is omitted", async () => {
    const response = await request(app)
      .post(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, name: "Rent" });

    expect(response.status).toBe(201);
    expect(response.body.costBehavior).toBe("UNCLASSIFIED");

    const row = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.costBehavior).toBe("UNCLASSIFIED");
  });

  it("accepts a valid costBehavior and persists it", async () => {
    const response = await request(app)
      .post(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, name: "Rent", costBehavior: "FIXED" });

    expect(response.status).toBe(201);
    expect(response.body.costBehavior).toBe("FIXED");

    const row = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.costBehavior).toBe("FIXED");
  });

  it.each(["VARIABLE", "MIXED", "UNCLASSIFIED"])("accepts %s", async (value) => {
    const response = await request(app)
      .post(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, name: `Category ${value}`, costBehavior: value });
    expect(response.status).toBe(201);
    expect(response.body.costBehavior).toBe(value);
  });

  it("rejects an invalid costBehavior value", async () => {
    const response = await request(app)
      .post(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, name: "Rent", costBehavior: "SEMI_FIXED" });
    expect(response.status).toBe(400);
  });

  it("rejects a lowercase costBehavior value — casing must match the Prisma enum exactly", async () => {
    const response = await request(app)
      .post(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, name: "Rent", costBehavior: "fixed" });
    expect(response.status).toBe(400);
  });
});

describe("GET /records/categories — round trip", () => {
  it("returns the persisted costBehavior on read", async () => {
    const created = await request(app)
      .post(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, name: "Rent", costBehavior: "FIXED" });

    const list = await request(app)
      .get(CATEGORIES_ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id });

    expect(list.status).toBe(200);
    const found = list.body.find((c: { id: number }) => c.id === created.body.id);
    expect(found.costBehavior).toBe("FIXED");
  });
});

describe("PATCH /records/categories/:id — update", () => {
  it("sets costBehavior on a previously UNCLASSIFIED category", async () => {
    const created = await prisma.expenseCategory.create({
      data: { businessProfileId: ctx.profile.id, name: "Electricity" },
    });
    expect(created.costBehavior).toBe("UNCLASSIFIED");

    const response = await request(app)
      .patch(`${CATEGORIES_ENDPOINT}/${created.id}`)
      .set(...AUTH)
      .send({ costBehavior: "VARIABLE" });

    expect(response.status).toBe(200);
    expect(response.body.costBehavior).toBe("VARIABLE");

    const row = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.costBehavior).toBe("VARIABLE");
  });

  it("leaves costBehavior untouched when omitted from the update body", async () => {
    const created = await prisma.expenseCategory.create({
      data: { businessProfileId: ctx.profile.id, name: "Electricity", costBehavior: "MIXED" },
    });

    const response = await request(app)
      .patch(`${CATEGORIES_ENDPOINT}/${created.id}`)
      .set(...AUTH)
      .send({ name: "Power" });

    expect(response.status).toBe(200);
    expect(response.body.costBehavior).toBe("MIXED");
  });

  it("rejects an invalid costBehavior value", async () => {
    const created = await prisma.expenseCategory.create({
      data: { businessProfileId: ctx.profile.id, name: "Electricity" },
    });

    const response = await request(app)
      .patch(`${CATEGORIES_ENDPOINT}/${created.id}`)
      .set(...AUTH)
      .send({ costBehavior: "SOMETIMES" });
    expect(response.status).toBe(400);
  });

  it("returns 404 for a category belonging to another owner", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Supplies"]);
    const response = await request(app)
      .patch(`${CATEGORIES_ENDPOINT}/${other.categories.Supplies}`)
      .set(...AUTH)
      .send({ costBehavior: "FIXED" });
    expect(response.status).toBe(404);
  });

  it("requires authentication", async () => {
    const created = await prisma.expenseCategory.create({
      data: { businessProfileId: ctx.profile.id, name: "Electricity" },
    });
    const response = await request(app).patch(`${CATEGORIES_ENDPOINT}/${created.id}`).send({ costBehavior: "FIXED" });
    expect(response.status).toBe(401);
  });
});
