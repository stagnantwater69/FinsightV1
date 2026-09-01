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
 * HTTP-level coverage for POST /insights/reduction-opportunities/feedback —
 * §15 Phase 5 of docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md.
 *
 * The service layer (`recordReductionOpportunityFeedback`, id-format and
 * rating validation, upsert semantics) is already covered by
 * tests/integration/reductionOpportunityFeedback.test.ts — this file only
 * confirms the route wires auth, request validation, and the response shape
 * correctly.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/reduction-opportunities/feedback";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

function opportunityId() {
  return `category_pressure-${ctx.categories.Inventory}-${utcDayString(0)}`;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: ctx.profile.id,
    opportunityId: opportunityId(),
    rating: "helpful",
    ...overrides,
  };
}

describe("authentication", () => {
  it("rejects a request with no bearer token", async () => {
    const response = await request(app).post(ENDPOINT).send(body());
    expect(response.status).toBe(401);
  });
});

describe("ownership isolation", () => {
  it("returns 404 for a foreign business profile", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: other.profile.id }));
    expect(response.status).toBe(404);
  });

  it("returns the same 404 for a foreign profile as for a nonexistent one", async () => {
    const other = await makeOwnerWithProfile({ name: "Other Store" });
    const foreign = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: other.profile.id }));
    const nonexistent = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ businessProfileId: 999999 }));
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.status).toBe(404);
  });
});

describe("request validation", () => {
  it("rejects a missing businessProfileId", async () => {
    const { businessProfileId: _drop, ...rest } = body();
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(rest);
    expect(response.status).toBe(400);
  });

  it("rejects a missing opportunityId", async () => {
    const { opportunityId: _drop, ...rest } = body();
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(rest);
    expect(response.status).toBe(400);
  });

  it("rejects a malformed opportunityId", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ opportunityId: "not-a-real-id" }));
    expect(response.status).toBe(400);
  });

  it("rejects a rating that isn't 'helpful' or 'not_relevant'", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ rating: "very-helpful" }));
    expect(response.status).toBe(400);
  });
});

describe("response contract", () => {
  it("creates a feedback row and returns it", async () => {
    const id = opportunityId();
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ opportunityId: id, rating: "helpful" }));

    expect(response.status).toBe(200);
    expect(response.body.opportunityId).toBe(id);
    expect(response.body.rating).toBe("helpful");
    expect(response.body).toHaveProperty("createdAt");

    const row = await prisma.reductionOpportunityFeedback.findFirstOrThrow({
      where: { businessProfileId: ctx.profile.id, opportunityId: id, userId: ctx.user.id },
    });
    expect(row.rating).toBe("HELPFUL");
  });

  it("upserts on resubmission rather than creating a duplicate row", async () => {
    const id = opportunityId();
    await request(app).post(ENDPOINT).set(...AUTH).send(body({ opportunityId: id, rating: "helpful" }));
    const second = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ opportunityId: id, rating: "not_relevant" }));

    expect(second.status).toBe(200);
    expect(second.body.rating).toBe("not_relevant");

    const rows = await prisma.reductionOpportunityFeedback.findMany({
      where: { businessProfileId: ctx.profile.id, opportunityId: id, userId: ctx.user.id },
    });
    expect(rows).toHaveLength(1);
  });
});
