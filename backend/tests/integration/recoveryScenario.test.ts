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
import { disconnectDb, makeOwnerWithProfile } from "../setup/testDb";
import { resetDb } from "../setup/testDb";

/**
 * HTTP-level coverage for POST /insights/recovery-scenario — §13.2/§15 Phase 5
 * of docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md.
 *
 * A sibling, non-persisting endpoint to POST /insights/reduction-simulation:
 * it takes one explicit owner-supplied hypothetical (`assumedExpectedMonthlyExpenses`)
 * and returns both the real, currently-configured Recovery Target and a
 * hypothetical one computed with the assumed value — never the other way
 * around, and never persisted anywhere.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/recovery-scenario";

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 125000 });
  authUserId.value = ctx.user.authId;
});
afterAll(disconnectDb);

function body(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: ctx.profile.id,
    assumedExpectedMonthlyExpenses: 90000,
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

  it("rejects a missing assumedExpectedMonthlyExpenses", async () => {
    const { assumedExpectedMonthlyExpenses: _drop, ...rest } = body();
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(rest);
    expect(response.status).toBe(400);
  });

  it("rejects a negative assumedExpectedMonthlyExpenses", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: -1 }));
    expect(response.status).toBe(400);
  });

  it("rejects a non-numeric assumedExpectedMonthlyExpenses", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: "a lot" }));
    expect(response.status).toBe(400);
  });
});

describe("response contract", () => {
  it("returns the assumed value, current and hypothetical targets", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: 90000 }));

    expect(response.status).toBe(200);
    expect(response.body.assumedExpectedMonthlyExpenses).toBe(90000);
    expect(response.body.current).toHaveProperty("dailyNeededTarget");
    expect(response.body.hypothetical).toHaveProperty("dailyNeededTarget");
    // Current reflects the profile's real, configured expense figure.
    expect(response.body.current.expectedMonthlyExpenses).toBe(125000);
    // Hypothetical reflects the assumed one, not the real one.
    expect(response.body.hypothetical.expectedMonthlyExpenses).toBe(90000);
  });

  it("accepts an assumed value of exactly zero", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: 0 }));
    expect(response.status).toBe(200);
    expect(response.body.hypothetical.expectedMonthlyExpenses).toBe(0);
  });
});

// Plan §8.4/§9.9, Phase 4 — additive `delta`/`persisted` fields on top of the
// existing `current`/`hypothetical` contract asserted above.
describe("response contract — delta and persisted (plan §8.4, Phase 4)", () => {
  it("returns delta fields derived from hypothetical minus current, and persisted: false", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: 90000 }));

    expect(response.status).toBe(200);
    const { current, hypothetical, delta } = response.body;
    expect(delta.totalCoverageGoal).toBeCloseTo(hypothetical.expectedMonthlyExpenses - current.expectedMonthlyExpenses, 6);
    expect(delta.remainingTarget).toBeCloseTo(hypothetical.remainingTarget - current.remainingTarget, 6);
    expect(delta.adjustedDailyTarget).toBeCloseTo(hypothetical.adjustedDailyTarget - current.adjustedDailyTarget, 6);
    expect(response.body.persisted).toBe(false);
  });

  it("totalCoverageGoal equals the plain expectedMonthlyExpenses delta (no safety buffer exists yet)", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: 90000 }));
    // 90000 (assumed) - 125000 (real, from beforeEach) = -35000.
    expect(response.body.delta.totalCoverageGoal).toBe(90000 - 125000);
  });

  it("always returns estimatedTransactionsPerDay: null with the documented unresolved-provenance reason (plan §9.9)", async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: 90000 }));
    expect(response.body.delta.estimatedTransactionsPerDay).toBeNull();
    expect(response.body.delta.estimatedTransactionsPerDayUnavailableReason).toBe("transaction_provenance_unknown");
  });
});

describe("no persistence occurs", () => {
  it("leaves the business profile's expectedMonthlyExpenses unchanged", async () => {
    const before = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });

    const response = await request(app)
      .post(ENDPOINT)
      .set(...AUTH)
      .send(body({ assumedExpectedMonthlyExpenses: 1 }));
    expect(response.status).toBe(200);

    const after = await prisma.businessProfile.findUniqueOrThrow({ where: { id: ctx.profile.id } });
    expect(after.expectedMonthlyExpenses.toString()).toBe(before.expectedMonthlyExpenses.toString());
  });
});
